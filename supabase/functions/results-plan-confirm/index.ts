// supabase/functions/results-plan-confirm/index.ts
//
// Cron (X-Cron-Secret = RESULTS_PLAN_CRON_SECRET, every ~15 min). For every ACTIVE Results Plan account whose owner enabled
// customer confirmation, asks the customer "Did <business> arrive?" once per billable job.
//   - Idempotent: UNIQUE (user_id, job_id) + claim queued->sending before the SMS; a crash after the claim is never re-sent
//     (outcome unknown) and is closed as failed('interrupted').
//   - Opt-out respected: every send goes through sendCompliantSms (A2P gate, dnc_suppressions, quiet hours, fraud guard).
//   - Service role: EVERY query is scoped by user_id. Replies are handled in sms-webhook -> rp_record_confirmation_reply.
// Env: RESULTS_PLAN_CRON_SECRET + the Twilio secrets used by sendCompliantSms.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";
import {
  CONFIRMATION_DEFAULTS, buildConfirmationSms, classifySendOutcome, evaluateEligibility, type SendOutcome,
} from "../_shared/results-plan/confirmation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BATCH = 25;
const BUDGET_MS = 100_000;
const DISCOVER_LIMIT = 200;
const SEND_LIMIT = 50;
const DAY = 86_400_000;
type Admin = SupabaseClient;

interface Account { user_id: string }
interface ChargeRow { id: string; job_id: string; status: string; created_at: string }
interface JobRow { id: string; customer_phone: string | null; job_status: string | null; is_rework: boolean | null; rework_of_job_id: string | null; job_source: string | null; service_type: string | null }
interface Due { id: string; job_id: string; customer_phone: string; attempts: number }

async function processAccount(admin: Admin, userId: string, deadline: number) {
  const out = { expired: 0, interrupted: 0, queued: 0, skipped: 0, sent: 0, requeued: 0, failed: 0 };
  const nowIso = () => new Date().toISOString();

  // 1. Housekeeping: unanswered questions close; abandoned claims are failed, never re-sent.
  const closeBefore = new Date(Date.now() - CONFIRMATION_DEFAULTS.noResponseAfterDays * DAY).toISOString();
  const { data: exp } = await admin.from("results_plan_confirmations").update({ status: "no_response" })
    .eq("user_id", userId).eq("status", "sent").lt("sent_at", closeBefore).select("id");
  out.expired = exp?.length ?? 0;
  const stuckBefore = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: stuck } = await admin.from("results_plan_confirmations").update({ status: "failed", failure_reason: "interrupted: outcome unknown, not re-sent" })
    .eq("user_id", userId).eq("status", "sending").lt("updated_at", stuckBefore).select("id");
  out.interrupted = stuck?.length ?? 0;

  // 2. Discover billable jobs that were never asked.
  const since = new Date(Date.now() - CONFIRMATION_DEFAULTS.maxAgeDays * DAY).toISOString();
  const { data: chargeData, error: chErr } = await admin.from("results_plan_charges").select("id,job_id,status,created_at")
    .eq("user_id", userId).in("status", ["pending", "posted"]).gte("created_at", since).order("created_at", { ascending: true }).limit(DISCOVER_LIMIT);
  if (chErr) throw new Error(`charges:${chErr.message}`);
  const charges = (chargeData ?? []) as ChargeRow[];
  if (charges.length > 0) {
    const jobIds = charges.map((c) => c.job_id);
    const { data: asked } = await admin.from("results_plan_confirmations").select("job_id").eq("user_id", userId).in("job_id", jobIds);
    const askedSet = new Set(((asked ?? []) as Array<{ job_id: string }>).map((r) => r.job_id));
    const fresh = charges.filter((c) => !askedSet.has(c.job_id));
    if (fresh.length > 0) {
      const { data: jobData } = await admin.from("jobs").select("id,customer_phone,job_status,is_rework,rework_of_job_id,job_source,service_type")
        .eq("user_id", userId).in("id", fresh.map((c) => c.job_id));
      const jobs = new Map(((jobData ?? []) as JobRow[]).map((j) => [j.id, j]));
      const rows: Array<Record<string, unknown>> = [];
      for (const c of fresh) {
        const j = jobs.get(c.job_id);
        if (!j) continue; // job not visible for this owner: never guess
        const phone = j.customer_phone?.trim() ? normalizePhone(j.customer_phone) : null;
        const verdict = evaluateEligibility({
          featureEnabled: true, customerPhone: phone, jobStatus: j.job_status, isRework: !!j.is_rework || !!j.rework_of_job_id,
          jobSource: j.job_source, chargeStatus: c.status, chargeCreatedAt: c.created_at, alreadyAsked: false,
        }, nowIso());
        if (verdict.send) rows.push({ user_id: userId, job_id: c.job_id, charge_id: c.id, customer_phone: phone, status: "queued", next_attempt_at: verdict.notBefore });
        else if (verdict.permanent && phone && /^\+[1-9][0-9]{6,14}$/.test(phone)) rows.push({ user_id: userId, job_id: c.job_id, charge_id: c.id, customer_phone: phone, status: "skipped", skip_reason: verdict.reason });
        // permanent skips without a storable phone are simply not asked; they are re-evaluated cheaply next tick and expire with the charge window
      }
      if (rows.length > 0) {
        const { error } = await admin.from("results_plan_confirmations").upsert(rows, { onConflict: "user_id,job_id", ignoreDuplicates: true });
        if (error) throw new Error(`confirmations:${error.message}`);
        out.queued = rows.filter((r) => r.status === "queued").length;
        out.skipped = rows.length - out.queued;
      }
    }
  }

  // 3. Send what is due (claim first => at-most-once).
  const { data: dueData } = await admin.from("results_plan_confirmations").select("id,job_id,customer_phone,attempts")
    .eq("user_id", userId).eq("status", "queued").lte("next_attempt_at", nowIso()).order("next_attempt_at", { ascending: true }).limit(SEND_LIMIT);
  const due = (dueData ?? []) as Due[];
  if (due.length === 0) return out;

  const { data: prof } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
  const business = (prof as { company_name: string | null } | null)?.company_name ?? null;

  for (const d of due) {
    if (Date.now() > deadline) break;
    const { data: claimed } = await admin.from("results_plan_confirmations").update({ status: "sending" })
      .eq("id", d.id).eq("user_id", userId).eq("status", "queued").select("id").maybeSingle();
    if (!claimed) continue; // another worker owns it

    // Re-check right before sending: the owner may have switched the feature off, or the charge may have been voided/credited.
    const [{ data: acc }, { data: chg }, { data: job }] = await Promise.all([
      admin.from("results_plan_accounts").select("customer_confirmation_enabled,status").eq("user_id", userId).maybeSingle(),
      admin.from("results_plan_charges").select("status").eq("user_id", userId).eq("job_id", d.job_id).maybeSingle(),
      admin.from("jobs").select("service_type,job_status").eq("user_id", userId).eq("id", d.job_id).maybeSingle(),
    ]);
    const stillOn = (acc as { customer_confirmation_enabled: boolean; status: string } | null);
    const chargeStatus = (chg as { status: string } | null)?.status;
    const jobRow = job as { service_type: string | null; job_status: string | null } | null;
    let skip: string | null = null;
    if (!stillOn?.customer_confirmation_enabled || stillOn.status !== "active") skip = "feature_disabled";
    else if (chargeStatus !== "pending" && chargeStatus !== "posted") skip = "charge_not_active";
    else if (jobRow?.job_status === "cancelled") skip = "cancelled";
    if (skip) {
      await admin.from("results_plan_confirmations").update({ status: "skipped", skip_reason: skip }).eq("id", d.id).eq("user_id", userId).eq("status", "sending");
      out.skipped++;
      continue;
    }

    let result: SendOutcome;
    try {
      const body = buildConfirmationSms({ businessName: business, serviceType: jobRow?.service_type ?? null });
      result = await sendCompliantSms(admin, userId, d.customer_phone, body, {
        purpose: "service", source: "results-plan-confirm", onQuiet: "caller", dedupeKey: `rp-confirm:${d.id}`,
      }) as SendOutcome;
    } catch (e) {
      result = { ok: false, reason: "TWILIO_ERROR", detail: e instanceof Error ? e.message : "send_error" };
    }
    const t = classifySendOutcome(result, d.attempts, nowIso());
    const base = { user_id: userId, id: d.id };
    let patch: Record<string, unknown>;
    if (t.status === "sent") { patch = { status: "sent", sent_at: nowIso(), provider_sid: t.sid.slice(0, 80), failure_reason: null }; out.sent++; }
    else if (t.status === "queued") { patch = { status: "queued", next_attempt_at: t.nextAttemptAt, attempts: d.attempts + (t.countAttempt ? 1 : 0) }; out.requeued++; }
    else if (t.status === "skipped") { patch = { status: "skipped", skip_reason: t.reason }; out.skipped++; }
    else { patch = { status: "failed", failure_reason: t.reason, attempts: d.attempts + 1 }; out.failed++; }
    const { error } = await admin.from("results_plan_confirmations").update(patch).eq("id", base.id).eq("user_id", base.user_id).eq("status", "sending");
    if (error) console.error(JSON.stringify({ event: "rp_confirm_update_failed", id: d.id, error: error.message }));
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("RESULTS_PLAN_CRON_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const started = Date.now();
  const results: Array<Record<string, unknown>> = [];
  // Page through ALL enabled accounts (stable order) so no account is starved when there are more than one page.
  for (let from = 0; Date.now() - started <= BUDGET_MS; from += BATCH) {
    const { data: accounts, error } = await admin.from("results_plan_accounts").select("user_id")
      .eq("status", "active").eq("customer_confirmation_enabled", true).not("opted_in_at", "is", null)
      .order("user_id", { ascending: true }).range(from, from + BATCH - 1);
    if (error) return json({ error: error.message }, 500);
    const page = (accounts ?? []) as Account[];
    for (const a of page) {
      if (Date.now() - started > BUDGET_MS) break;
      try { results.push({ user_id: a.user_id, ...(await processAccount(admin, a.user_id, started + BUDGET_MS)) }); }
      catch (e) { console.error("results-plan-confirm account failed", a.user_id, e instanceof Error ? e.message : e); results.push({ user_id: a.user_id, error: true }); }
    }
    if (page.length < BATCH) break;
  }
  return json({ processed: results.length, results });
});
