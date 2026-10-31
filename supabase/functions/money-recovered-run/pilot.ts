// supabase/functions/money-recovered-run/pilot.ts
//
// Pilot outcome measurement: attribution sync + weekly owner email. Called from index.ts
// (cron action "pilot_sweep", owner actions "pilot_sync" | "pilot_send_test" | "pilot_send_now").
// Service role => every query is explicitly scoped by user_id. Attribution rows are insert-only
// (ON CONFLICT DO NOTHING), so a counted dollar is never rewritten. Missing/malformed rows are skipped + logged.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isStatementDue, isValidTimeZone, previousWeekWindow, type LedgerEvent } from "../_shared/money-recovered/engine.ts";
import {
  PILOT_EMAIL_TEMPLATE_VERSION, PILOT_METHOD_VERSION, attributeClaim, attributeLedgerEvent, buildPilotResults, renderPilotEmail,
  type AttributionRow, type BaselineRow, type ClaimActionInput, type ClaimInput, type EligibleJobRow, type PilotResults, type SettingsRow,
} from "../_shared/pilot-outcomes/engine.ts";

type Admin = SupabaseClient;
export interface PilotDeps {
  sendMail(o: { to: string; subject: string; html: string; text: string; filename: string; pdf: null }): Promise<{ ok: boolean; error?: string }>;
  siteUrl(): string;
}
interface Owner { id: string; email: string | null; company_name: string | null; invoice_currency: string | null; status: string | null; role: string | null }

const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const log = (event: string, extra: Record<string, unknown>) => console.error(JSON.stringify({ event, ...extra }));
const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const EVENT_COLS = "id, source_type, call_id, customer_name, occurred_at, estimated_value_cents, status, recovery_method, recovered_amount_cents, follow_up_count, last_follow_up_at, resolved_at, recovered_job_id";

/** Computes and stores attributions for one tenant. Idempotent. */
export async function syncPilotAttributions(admin: Admin, tenant: string): Promise<{ baseline: boolean; inserted: number; skipped: number }> {
  const { data: base } = await admin.from("pilot_outcome_baselines").select("captured_at").eq("user_id", tenant).maybeSingle();
  if (!base) return { baseline: false, inserted: 0, skipped: 0 };
  const baselineAt = base.captured_at as string;

  const existing = new Set((await fetchAll<{ source_type: string; source_id: string }>((a, b) =>
    admin.from("pilot_attributions").select("source_type, source_id").eq("user_id", tenant).order("id").range(a, b)))
    .map((r) => `${r.source_type}:${r.source_id}`));

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;

  // --- warranty claims
  const claims = await fetchAll<ClaimInput>((a, b) =>
    admin.from("warranty_claims").select("id, job_id, status, created_at, submitted_at, credit_received_cents, credit_received_at")
      .eq("user_id", tenant).gt("credit_received_cents", 0).order("id").range(a, b));
  const pending = claims.filter((c) => !existing.has(`warranty_claim:${c.id}`));
  const actions: ClaimActionInput[] = [];
  for (const ids of chunk(pending.map((c) => c.id), 150)) {
    actions.push(...await fetchAll<ClaimActionInput>((a, b) =>
      admin.from("warranty_claim_actions").select("id, claim_id, action_type, to_status, amount_cents, occurred_at")
        .eq("user_id", tenant).in("claim_id", ids).gte("occurred_at", baselineAt).order("id").range(a, b)));
  }
  for (const c of pending) {
    try {
      const r = attributeClaim(c, actions, baselineAt);
      if (!r.counted) { skipped++; continue; }
      rows.push({
        user_id: tenant, source_type: "warranty_claim", source_id: c.id, claim_id: c.id, invoice_id: null, job_id: c.job_id,
        amount_cents: r.amountCents, action_type: r.action.type, action_id: r.action.id, action_at: r.action.at,
        recovered_at: r.recoveredAt, method_version: PILOT_METHOD_VERSION,
      });
    } catch (e) { skipped++; log("pilot_claim_attribution_skipped", { claim_id: c.id, error: String(e) }); }
  }

  // --- ledger events (existing conservative-v1 rule + paid-invoice link)
  const events = (await fetchAll<LedgerEvent & { recovered_job_id: string | null }>((a, b) =>
    admin.from("revenue_recovery_events").select(EVENT_COLS).eq("user_id", tenant).eq("status", "recovered")
      .gte("resolved_at", baselineAt).order("id").range(a, b))).filter((e) => !existing.has(`recovery_event:${e.id}`));
  const jobIds = [...new Set(events.map((e) => e.recovered_job_id).filter((v): v is string => !!v))];
  const paidByJob = new Map<string, string | null>();
  for (const ids of chunk(jobIds, 150)) {
    const { data, error } = await admin.from("invoices").select("id, job_id").eq("user_id", tenant).eq("status", "paid").in("job_id", ids);
    if (error) throw new Error(error.message);
    for (const inv of (data ?? []) as { id: string; job_id: string }[]) {
      paidByJob.set(inv.job_id, paidByJob.has(inv.job_id) ? null : inv.id); // >1 paid invoice => ambiguous => no link (never guess)
    }
  }
  for (const e of events) {
    try {
      const invoiceId = e.recovered_job_id ? (paidByJob.get(e.recovered_job_id) ?? null) : null;
      const r = attributeLedgerEvent(e, invoiceId, baselineAt);
      if (!r.counted) { skipped++; continue; }
      rows.push({
        user_id: tenant, source_type: "recovery_event", source_id: e.id, claim_id: null, invoice_id: invoiceId, job_id: e.recovered_job_id,
        amount_cents: r.amountCents, action_type: r.action.type, action_id: null, action_at: r.action.at,
        recovered_at: r.recoveredAt, method_version: PILOT_METHOD_VERSION,
      });
    } catch (err) { skipped++; log("pilot_event_attribution_skipped", { event_id: e.id, error: String(err) }); }
  }

  let inserted = 0;
  for (const part of chunk(rows, 200)) {
    const { data, error } = await admin.from("pilot_attributions")
      .upsert(part, { onConflict: "source_type,source_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`pilot_attributions insert failed: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return { baseline: true, inserted, skipped };
}

export async function loadPilotResults(admin: Admin, tenant: string): Promise<PilotResults> {
  const [{ data: baseline }, { data: settings }] = await Promise.all([
    admin.from("pilot_outcome_baselines").select("*").eq("user_id", tenant).maybeSingle(),
    admin.from("pilot_outcome_settings").select("current_admin_hours_per_week, fee_bps").eq("user_id", tenant).maybeSingle(),
  ]);
  const claims = await fetchAll<ClaimInput>((a, b) =>
    admin.from("warranty_claims").select("id, job_id, status, created_at, submitted_at, credit_received_cents, credit_received_at")
      .eq("user_id", tenant).order("id").range(a, b));
  const attributions = await fetchAll<AttributionRow>((a, b) =>
    admin.from("pilot_attributions").select("source_type, source_id, claim_id, invoice_id, job_id, amount_cents, action_type, action_at, recovered_at")
      .eq("user_id", tenant).order("id").range(a, b));
  const eligibleUnfiled = await fetchAll<EligibleJobRow>((a, b) =>
    admin.from("warranty_eligible_jobs").select("job_id, invoice_amount, completed_at").eq("user_id", tenant).order("job_id").range(a, b));
  return buildPilotResults({
    nowIso: new Date().toISOString(), baseline: (baseline ?? null) as BaselineRow | null,
    settings: (settings ?? null) as SettingsRow | null, claims, attributions, eligibleUnfiled,
  });
}

async function sendPilotEmail(admin: Admin, deps: PilotDeps, owner: Owner, weekStart: string, periodLabel: string, subjectPrefix = ""): Promise<{ sent: boolean; reason?: string }> {
  const to = (owner.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { sent: false, reason: "no_valid_recipient" };

  const ins = await admin.from("pilot_email_deliveries")
    .upsert({ user_id: owner.id, week_start: weekStart, email: to, template_version: PILOT_EMAIL_TEMPLATE_VERSION, status: "sending" },
      { onConflict: "user_id,week_start,email", ignoreDuplicates: true }).select("id");
  let claimed = !!ins.data?.length;
  if (!claimed) {
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const retry = await admin.from("pilot_email_deliveries").select("id, attempts")
      .eq("user_id", owner.id).eq("week_start", weekStart).eq("email", to)
      .or(`status.eq.failed,and(status.eq.sending,updated_at.lt.${staleBefore})`).lt("attempts", MAX_ATTEMPTS);
    if (retry.data?.length) {
      const u = await admin.from("pilot_email_deliveries")
        .update({ status: "sending", attempts: (retry.data[0].attempts as number) + 1, updated_at: new Date().toISOString() })
        .eq("id", retry.data[0].id).eq("user_id", owner.id).select("id");
      claimed = !!u.data?.length;
    }
  }
  if (!claimed) return { sent: false, reason: "already_sent_or_in_progress" };

  const results = await loadPilotResults(admin, owner.id);
  const mail = renderPilotEmail({
    companyName: owner.company_name?.trim() || "Your business", results, periodLabel,
    currency: /^[A-Z]{3}$/.test(owner.invoice_currency ?? "") ? (owner.invoice_currency as string) : "USD",
    siteUrl: deps.siteUrl(), subjectPrefix,
  });
  const res = await deps.sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, filename: "", pdf: null });
  await admin.from("pilot_email_deliveries").update({
    status: res.ok ? "sent" : "failed", error: res.ok ? null : (res.error ?? "send failed").slice(0, 300),
    sent_at: res.ok ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  }).eq("user_id", owner.id).eq("week_start", weekStart).eq("email", to);
  return res.ok ? { sent: true } : { sent: false, reason: res.error ?? "send_failed" };
}

/** Cron: sync + email for tenants whose owner switched the email on AND approved THIS template version. */
export async function runPilotSweep(admin: Admin, deps: PilotDeps) {
  const now = new Date();
  const { data: all, error } = await admin.from("pilot_outcome_settings").select("user_id")
    .eq("email_enabled", true).eq("email_template_approved_version", PILOT_EMAIL_TEMPLATE_VERSION).limit(500);
  if (error) throw error;
  const ids = ((all ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (!ids.length) return { processed: 0 };

  const [{ data: owners }, { data: ms }, { data: bases }] = await Promise.all([
    admin.from("profiles").select("id,email,company_name,invoice_currency,status,role").in("id", ids),
    admin.from("money_recovered_settings").select("user_id,send_hour,timezone").in("user_id", ids),
    admin.from("pilot_outcome_baselines").select("user_id").in("user_id", ids),
  ]);
  const tz = new Map(((ms ?? []) as { user_id: string; send_hour: number; timezone: string }[]).map((m) => [m.user_id, m]));
  const hasBase = new Set(((bases ?? []) as { user_id: string }[]).map((b) => b.user_id));
  let processed = 0, sent = 0;
  const failures: string[] = [];
  for (const o of (owners ?? []) as Owner[]) {
    if (o.status !== "active" || o.role !== "owner" || !hasBase.has(o.id)) continue;
    const s = tz.get(o.id);
    const timezone = s && isValidTimeZone(s.timezone) ? s.timezone : "America/New_York";
    if (!isStatementDue({ enabled: true, send_hour: s?.send_hour ?? 8, timezone }, now)) continue;
    try {
      processed++;
      await syncPilotAttributions(admin, o.id);
      const w = previousWeekWindow(now, timezone);
      const r = await sendPilotEmail(admin, deps, o, w.start, w.label);
      if (r.sent) sent++;
    } catch (e) {
      failures.push(o.id);
      log("pilot_sweep_item_failed", { user_id: o.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { processed, sent, failures: failures.length };
}

/** Owner JWT actions. Returns [body, status]. */
export async function handlePilotOwner(admin: Admin, deps: PilotDeps, userId: string, action: string): Promise<[unknown, number]> {
  const { data: p } = await admin.from("profiles").select("id,email,company_name,invoice_currency,status,role").eq("id", userId).maybeSingle();
  if (!p || p.role !== "owner") return [{ error: "Only the account owner can run pilot actions." }, 403];
  const owner = p as Owner;

  if (action === "pilot_sync") return [await syncPilotAttributions(admin, userId), 200];

  if (action === "pilot_send_test" || action === "pilot_send_now") {
    const { data: s } = await admin.from("pilot_outcome_settings").select("email_template_approved_version").eq("user_id", userId).maybeSingle();
    if (s?.email_template_approved_version !== PILOT_EMAIL_TEMPLATE_VERSION) {
      return [{ error: "Approve the current email template before sending." }, 409];
    }
    await syncPilotAttributions(admin, userId);
    const w = previousWeekWindow(new Date(), "America/New_York");
    if (action === "pilot_send_test") {
      // Test mail: sent straight to the owner, not logged as the weekly delivery.
      const results = await loadPilotResults(admin, userId);
      const mail = renderPilotEmail({
        companyName: owner.company_name?.trim() || "Your business", results, periodLabel: w.label, siteUrl: deps.siteUrl(),
        currency: /^[A-Z]{3}$/.test(owner.invoice_currency ?? "") ? (owner.invoice_currency as string) : "USD", subjectPrefix: "[Test] ",
      });
      const to = (owner.email ?? "").toLowerCase();
      if (!EMAIL_RE.test(to)) return [{ error: "Your account has no valid email address." }, 400];
      const res = await deps.sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, filename: "", pdf: null });
      return [{ test: true, ok: res.ok, error: res.ok ? null : res.error }, 200];
    }
    return [await sendPilotEmail(admin, deps, owner, w.start, w.label), 200];
  }
  return [{ error: "Unknown action." }, 400];
}
