// supabase/functions/scheduled-reports-run/index.ts
//
// Two entry points, one delivery pipeline:
//
//   1. { action: "tick" }      — called by pg_cron every ~10 min (see the cron snippet
//                                in migration 20270416000000_scheduled_reports.sql).
//                                Auth: X-Cron-Secret == CRON_SECRET, or Bearer == service role key.
//                                Claims due schedules atomically (scheduled_report_claim_due),
//                                runs each, writes the delivery log.
//   2. { action: "send_now", scheduleId } — "Send now" button. Auth: the user's own JWT.
//                                Requires the owner or a team member with can_view_billing,
//                                scoped to that user's ACCOUNT OWNER, rate-limited to 1 / 60 s.
//
// Because this function uses the service role (RLS bypassed), EVERY query below is
// explicitly scoped by user_id = account owner id.
//
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL (optional), SITE_URL (optional), CRON_SECRET (recommended).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ENTITIES,
  MAX_ROWS,
  PAGE_SIZE,
  rangeStart,
  runReport,
  sanitizeDefinition,
  toExportTable,
  type ReportEntity,
  type ReportRow,
  type RangePreset,
} from "../_shared/reports/engine.ts";
import { buildReportEmail, safeDisplayName, toCsv } from "../_shared/reports/email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

const MAX_CONSECUTIVE_FAILURES = 5;
const TICK_BUDGET_MS = 100_000;
const MANUAL_COOLDOWN_MS = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Emails may contain _ (a LIKE wildcard); escape so ilike behaves as a case-insensitive equals. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

interface ScheduleRow {
  id: string;
  user_id: string;
  created_by: string;
  report_id: string;
  recipients: string[];
  include_csv: boolean;
  is_active: boolean;
  consecutive_failures: number;
}

interface RecipientResult {
  email: string;
  ok: boolean;
  error?: string;
}

type DeliveryStatus = "sent" | "partial" | "failed" | "skipped";

// ---------------------------------------------------------------- access

/** Mirrors public.reports_can_access(): the account owner, or an active team member with can_view_billing. */
async function userHasReportAccess(admin: SupabaseClient, ownerId: string, userId: string): Promise<boolean> {
  if (userId === ownerId) return true;
  const { data: authUser } = await admin.auth.admin.getUserById(userId);
  const email = authUser?.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: members } = await admin
    .from("team_members")
    .select("member_email, invite_status, permissions")
    .eq("account_owner_id", ownerId)
    .ilike("member_email", escapeLike(email));
  return ((members ?? []) as { member_email: string; invite_status: string; permissions: Record<string, unknown> | null }[]).some(
    (m) => m.member_email.toLowerCase() === email && m.invite_status === "active" && m.permissions?.can_view_billing === true,
  );
}

/** Resolves which account a signed-in user acts on (their own, or the owner who invited them). */
async function resolveAccountOwner(admin: SupabaseClient, userId: string, email: string | undefined): Promise<string | null> {
  const { data: profile } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (profile) return profile.id as string;
  if (!email) return null;
  const { data: member } = await admin
    .from("team_members")
    .select("account_owner_id")
    .ilike("member_email", escapeLike(email))
    .eq("invite_status", "active")
    .limit(1)
    .maybeSingle();
  return (member?.account_owner_id as string | undefined) ?? null;
}

// ---------------------------------------------------------------- data

async function fetchRows(admin: SupabaseClient, entity: ReportEntity, ownerId: string, range: RangePreset) {
  const def = ENTITIES[entity];
  const columns = ["id", ...def.fields.map((f) => f.key)].filter((c, i, a) => a.indexOf(c) === i).join(",");
  const since = rangeStart(range);
  const out: ReportRow[] = [];

  for (let from = 0; from <= MAX_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_ROWS);
    let q = admin.from(def.table).select(columns).eq("user_id", ownerId);
    if (since) q = q.gte(def.dateField, since.toISOString());
    const { data, error } = await q.order(def.dateField, { ascending: false }).order("id", { ascending: true }).range(from, to);
    if (error) throw new Error(`Could not load ${entity}: ${error.message}`);
    const page = (data ?? []) as unknown as ReportRow[];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  const truncated = out.length > MAX_ROWS;
  return { rows: truncated ? out.slice(0, MAX_ROWS) : out, truncated };
}

// ---------------------------------------------------------------- email

function fromHeader(company: string | null): string {
  const raw = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  const name = safeDisplayName(company);
  if (!name) return raw;
  const addr = raw.includes("<") ? raw.slice(raw.indexOf("<") + 1, raw.lastIndexOf(">")) : raw;
  return `${name} via Vireek <${addr}>`;
}

async function sendOne(
  apiKey: string,
  payload: { from: string; to: string; subject: string; html: string; text: string; attachment?: { filename: string; content: string } },
): Promise<RecipientResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: payload.from,
          to: [payload.to],
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          ...(payload.attachment ? { attachments: [payload.attachment] } : {}),
        }),
      });
      if (res.ok) return { email: payload.to, ok: true };
      const detail = (await res.text()).slice(0, 200);
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
      }
      return { email: payload.to, ok: false, error: `Email provider error (${res.status}): ${detail}` };
    } catch (err) {
      if (attempt === 1) return { email: payload.to, ok: false, error: `Network error: ${String(err).slice(0, 150)}` };
    }
  }
  return { email: payload.to, ok: false, error: "Unknown delivery error" };
}

// ---------------------------------------------------------------- pipeline

async function finishDelivery(
  admin: SupabaseClient,
  schedule: ScheduleRow,
  deliveryId: string,
  trigger: "schedule" | "manual",
  outcome: { status: DeliveryStatus; results?: RecipientResult[]; rowCount?: number | null; error?: string | null; deactivate?: string },
) {
  const results = outcome.results ?? [];
  const now = new Date().toISOString();

  await admin
    .from("scheduled_report_deliveries")
    .update({
      status: outcome.status,
      results,
      recipients_sent: results.filter((r) => r.ok).length,
      row_count: outcome.rowCount ?? null,
      error: outcome.error ?? null,
      finished_at: now,
    })
    .eq("id", deliveryId)
    .eq("user_id", schedule.user_id);

  const patch: Record<string, unknown> = { last_run_at: now, last_status: outcome.status };
  if (trigger === "schedule") {
    if (outcome.status === "sent" || outcome.status === "partial") patch.consecutive_failures = 0;
    else if (outcome.status === "failed") {
      const failures = schedule.consecutive_failures + 1;
      patch.consecutive_failures = failures;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        patch.is_active = false;
        patch.paused_reason = `Paused automatically after ${MAX_CONSECUTIVE_FAILURES} failed deliveries in a row.`;
      }
    }
  }
  if (outcome.deactivate) {
    patch.is_active = false;
    patch.paused_reason = outcome.deactivate;
  }
  await admin.from("scheduled_reports").update(patch).eq("id", schedule.id).eq("user_id", schedule.user_id);
}

async function runDelivery(admin: SupabaseClient, schedule: ScheduleRow, deliveryId: string, trigger: "schedule" | "manual") {
  const fail = async (error: string, extra: { status?: DeliveryStatus; deactivate?: string } = {}) => {
    const status = extra.status ?? "failed";
    await finishDelivery(admin, schedule, deliveryId, trigger, { status, error, deactivate: extra.deactivate });
    return { status, sent: 0, total: schedule.recipients.length };
  };

  try {
    const { data: report } = await admin
      .from("saved_reports")
      .select("id, name, description, entity, definition")
      .eq("id", schedule.report_id)
      .eq("user_id", schedule.user_id)
      .maybeSingle();
    if (!report) return await fail("The saved report no longer exists.");

    // The creator must STILL be allowed to see reports — otherwise a removed team member's schedule
    // would keep mailing company data to outside recipients forever.
    if (!(await userHasReportAccess(admin, schedule.user_id, schedule.created_by))) {
      return await fail("The person who created this schedule no longer has report access.", {
        status: "skipped",
        deactivate: "Paused: the schedule's creator no longer has report access. Re-create it from an account with access.",
      });
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) return await fail("Email isn't configured yet (missing RESEND_API_KEY).");

    const entity = report.entity as ReportEntity;
    if (!(entity in ENTITIES)) return await fail("Unsupported report data source.");
    const def = sanitizeDefinition(report.definition, entity);

    const { data: profile } = await admin.from("profiles").select("company_name, invoice_currency").eq("id", schedule.user_id).maybeSingle();
    const currency = (profile?.invoice_currency as string | undefined) || "USD";

    const { rows, truncated } = await fetchRows(admin, entity, schedule.user_id, def.range);
    const result = runReport(rows, def);
    const table = toExportTable(result, def, currency);

    const generatedAt = new Date();
    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const csvAttached = schedule.include_csv && table.rows.length > 0;
    const email = buildReportEmail({
      companyName: (profile?.company_name as string | null) ?? null,
      reportName: report.name as string,
      description: (report.description as string | null) ?? null,
      def,
      result,
      currency,
      truncated,
      csvAttached,
      generatedAt,
      siteUrl,
    });
    const attachment = csvAttached
      ? { filename: `${slug(report.name as string)}-${generatedAt.toISOString().slice(0, 10)}.csv`, content: toBase64(toCsv(table)) }
      : undefined;
    const from = fromHeader((profile?.company_name as string | null) ?? null);

    const results: RecipientResult[] = [];
    for (const to of schedule.recipients) {
      results.push(await sendOne(apiKey, { from, to, subject: email.subject, html: email.html, text: email.text, attachment }));
    }
    const sent = results.filter((r) => r.ok).length;
    const status: DeliveryStatus = sent === results.length ? "sent" : sent === 0 ? "failed" : "partial";
    const firstError = results.find((r) => !r.ok)?.error ?? null;

    await finishDelivery(admin, schedule, deliveryId, trigger, {
      status,
      results,
      rowCount: result.matched,
      error: status === "sent" ? null : firstError,
    });
    return { status, sent, total: results.length };
  } catch (err) {
    console.error("scheduled-reports-run delivery failed", schedule.id, err);
    return await fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  }
}

// ---------------------------------------------------------------- handlers

async function handleTick(admin: SupabaseClient) {
  const startedAt = Date.now();
  const { data: claimed, error } = await admin.rpc("scheduled_report_claim_due", { p_limit: 10 });
  if (error) return json({ error: `claim failed: ${error.message}` }, 500);

  const claims = (claimed ?? []) as { o_delivery_id: string; o_schedule_id: string }[];
  const summary = { claimed: claims.length, sent: 0, partial: 0, failed: 0, skipped: 0 };

  for (const c of claims) {
    const { data: schedule } = await admin
      .from("scheduled_reports")
      .select("id, user_id, created_by, report_id, recipients, include_csv, is_active, consecutive_failures")
      .eq("id", c.o_schedule_id)
      .maybeSingle();

    if (!schedule) {
      await admin.from("scheduled_report_deliveries").update({ status: "failed", error: "Schedule was deleted before it ran.", finished_at: new Date().toISOString() }).eq("id", c.o_delivery_id);
      summary.failed++;
      continue;
    }
    if (Date.now() - startedAt > TICK_BUDGET_MS) {
      await finishDelivery(admin, schedule as ScheduleRow, c.o_delivery_id, "schedule", { status: "failed", error: "Deferred: this run ran out of time. It will run at the next scheduled occurrence." });
      summary.failed++;
      continue;
    }
    const out = await runDelivery(admin, schedule as ScheduleRow, c.o_delivery_id, "schedule");
    summary[out.status]++;
  }
  return json(summary);
}

async function handleSendNow(admin: SupabaseClient, accessToken: string, scheduleId: unknown) {
  if (typeof scheduleId !== "string" || !/^[0-9a-f-]{36}$/i.test(scheduleId)) return json({ error: "scheduleId is required" }, 400);

  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const user = userData.user;

  const ownerId = await resolveAccountOwner(admin, user.id, user.email);
  if (!ownerId) return json({ error: "No account found for this user" }, 403);
  if (!(await userHasReportAccess(admin, ownerId, user.id))) return json({ error: "You don't have permission to send reports" }, 403);

  const { data: schedule } = await admin
    .from("scheduled_reports")
    .select("id, user_id, created_by, report_id, recipients, include_csv, is_active, consecutive_failures")
    .eq("id", scheduleId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!schedule) return json({ error: "Schedule not found" }, 404);

  const { data: recent } = await admin
    .from("scheduled_report_deliveries")
    .select("created_at")
    .eq("schedule_id", scheduleId)
    .eq("user_id", ownerId)
    .eq("trigger", "manual")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent && Date.now() - new Date(recent.created_at as string).getTime() < MANUAL_COOLDOWN_MS) {
    return json({ error: "RATE_LIMITED", detail: "Please wait a minute before sending this report again." }, 429);
  }

  const { data: reportRow } = await admin.from("saved_reports").select("name").eq("id", schedule.report_id).eq("user_id", ownerId).maybeSingle();
  const { data: delivery, error: insertError } = await admin
    .from("scheduled_report_deliveries")
    .insert({
      user_id: ownerId,
      schedule_id: scheduleId,
      report_name: (reportRow?.name as string | undefined) ?? "Report",
      trigger: "manual",
      status: "pending",
      scheduled_for: new Date().toISOString(),
      recipients_total: (schedule.recipients as string[]).length,
    })
    .select("id")
    .single();
  if (insertError || !delivery) return json({ error: "Could not start delivery" }, 500);

  const out = await runDelivery(admin, schedule as ScheduleRow, delivery.id as string, "manual");
  const { data: final } = await admin.from("scheduled_report_deliveries").select("*").eq("id", delivery.id).eq("user_id", ownerId).maybeSingle();
  return json({ delivery: final, status: out.status });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });

  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === "string" ? body.action : "tick";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  if (action === "tick") {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const headerSecret = req.headers.get("X-Cron-Secret") ?? "";
    const okSecret = !!cronSecret && safeEqual(headerSecret, cronSecret);
    const okService = !!serviceKey && !!bearer && safeEqual(bearer, serviceKey);
    if (!okSecret && !okService) return json({ error: "Unauthorized" }, 401);
    return await handleTick(admin);
  }

  if (action === "send_now") {
    if (!bearer) return json({ error: "Missing Authorization header" }, 401);
    return await handleSendNow(admin, bearer, body?.scheduleId);
  }

  return json({ error: "Unknown action" }, 400);
});
