// supabase/functions/executive-report-run/index.ts
//
// Executive Monthly Report generator + scheduler.
//   • Cron  (header X-Cron-Secret, body {action:"sweep"}): finds owners whose report is due
//     in THEIR time zone, generates the previous month's report, emails it.
//   • Owner (Authorization: Bearer <jwt>): {action:"preview" | "send_test" | "send_now", period?:"YYYY-MM", resend?:boolean}

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsPDF } from "npm:jspdf@2.5.2";
import { computeExecutiveMetrics } from "../_shared/executive-report/metrics.ts";
import { isReportDue, isValidTimeZone, periodForMonth, previousMonthPeriod } from "../_shared/executive-report/period.ts";
import { generateCommentary } from "../_shared/executive-report/commentary.ts";
import { renderReportEmail } from "../_shared/executive-report/render.ts";
import { buildExecutiveReportPdf } from "../_shared/executive-report/pdf.ts";
import { sendReportEmail } from "../_shared/executive-report/email.ts";
import type {
  Commentary, ExecutiveMetrics, ReportData, ReportPeriod, ReportSettings,
} from "../_shared/executive-report/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const BUCKET = "executive-reports";
const MAX_ATTEMPTS = 5;
const SWEEP_BATCH = 20;
const SWEEP_BUDGET_MS = 100_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Admin = SupabaseClient;

const DEFAULT_SETTINGS = (userId: string): ReportSettings => ({
  user_id: userId, enabled: true, send_day: 1, send_hour: 8, timezone: "America/New_York",
  include_owner: true, include_co_owners: true, extra_recipients: [], ai_commentary_enabled: true,
  revenue_goal: null, jobs_goal: null, close_rate_goal_pct: null, margin_goal_pct: null,
});

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- data loading
// deno-lint-ignore no-explicit-any
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, cap = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message ?? "query failed");
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadReportData(admin: Admin, userId: string, period: ReportPeriod): Promise<ReportData> {
  const from = period.prior.startUtc;
  const to = period.endUtc;

  const jobs = await fetchAll((a, b) =>
    admin.from("jobs")
      .select("id,assigned_technician_id,job_status,invoice_amount,invoice_status,completed_at,scheduled_datetime,created_at,is_rework")
      .eq("user_id", userId)
      .or(`completed_at.gte.${from},scheduled_datetime.gte.${from},created_at.gte.${from}`)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(a, b));

  // Optional sources: a missing table/column must degrade the report, never break it.
  let costs: ReportData["costs"] = [];
  try {
    const ids = jobs.filter((j) => j.job_status === "completed").map((j) => j.id as string);
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await admin.from("job_cost_entries").select("job_id,amount").in("job_id", ids.slice(i, i + 150));
      if (error) throw error;
      costs.push(...(data ?? []));
    }
  } catch (e) { console.warn(JSON.stringify({ event: "exec_report_costs_skipped", error: String((e as Error)?.message ?? e) })); costs = []; }

  const quotes = await fetchAll((a, b) =>
    admin.from("quotes").select("status,sent_at").eq("user_id", userId)
      .gte("sent_at", from).lt("sent_at", to).order("sent_at").range(a, b));

  const calls = await fetchAll((a, b) =>
    admin.from("calls").select("status,call_datetime").eq("user_id", userId).eq("status", "missed")
      .gte("call_datetime", from).lt("call_datetime", to).order("call_datetime").range(a, b));

  let recoveries: ReportData["recoveries"] = [];
  try {
    recoveries = await fetchAll((a, b) =>
      admin.from("revenue_recovery_events").select("source_type,status,occurred_at,recovered_amount_cents")
        .eq("user_id", userId).in("source_type", ["missed_call", "voicemail"])
        .gte("occurred_at", from).lt("occurred_at", to).order("occurred_at").range(a, b));
  } catch (e) { console.warn(JSON.stringify({ event: "exec_report_recovery_skipped", error: String((e as Error)?.message ?? e) })); }

  const { data: techs } = await admin.from("team_members").select("id,member_name,member_email").eq("account_owner_id", userId);

  return { jobs: jobs as ReportData["jobs"], costs, quotes, calls, recoveries, technicians: techs ?? [] };
}

// ---------------------------------------------------------------- recipients
async function resolveRecipients(admin: Admin, s: ReportSettings, ownerEmail: string | null): Promise<string[]> {
  const set = new Set<string>();
  const add = (e: string | null | undefined) => {
    const v = (e ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(v)) set.add(v);
  };
  if (s.include_owner) add(ownerEmail);
  if (s.include_co_owners) {
    const { data } = await admin.from("team_members").select("member_email")
      .eq("account_owner_id", s.user_id).eq("role", "owner").eq("invite_status", "active");
    (data ?? []).forEach((r: { member_email: string }) => add(r.member_email));
  }
  (s.extra_recipients ?? []).forEach(add);
  return [...set].slice(0, 25);
}

// ---------------------------------------------------------------- generation
interface StoredReport {
  id: string; metrics: ExecutiveMetrics; commentary: Commentary; pdf_path: string | null;
  status: string; send_attempts: number; generated_at: string;
}

async function generateReport(admin: Admin, s: ReportSettings, period: ReportPeriod, companyName: string, trigger: "scheduled" | "manual"): Promise<{ report: StoredReport; pdf: Uint8Array }> {
  const data = await loadReportData(admin, s.user_id, period);
  const metrics = computeExecutiveMetrics(period, data, s);
  const commentary = await generateCommentary(metrics, s.ai_commentary_enabled);
  const pdf = buildExecutiveReportPdf(jsPDF as never, { companyName, metrics, commentary, generatedAt: new Date() });

  const ym = period.start.slice(0, 7);
  const path = `${s.user_id}/${ym}.pdf`;
  const up = await admin.storage.from(BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (up.error) throw new Error(`PDF upload failed: ${up.error.message}`);

  const { data: row, error } = await admin.from("executive_reports").upsert({
    user_id: s.user_id, period_start: period.start, period_end: period.end, period_label: period.label,
    metrics, commentary, commentary_source: commentary.source, pdf_path: path, trigger,
    generated_at: new Date().toISOString(),
  }, { onConflict: "user_id,period_start" }).select("id,status,send_attempts,generated_at").single();
  if (error || !row) throw new Error(`Report save failed: ${error?.message}`);

  return { report: { id: row.id, metrics, commentary, pdf_path: path, status: row.status, send_attempts: row.send_attempts, generated_at: row.generated_at }, pdf };
}

async function loadStored(admin: Admin, userId: string, periodStart: string): Promise<{ report: StoredReport; pdf: Uint8Array } | null> {
  const { data: row } = await admin.from("executive_reports")
    .select("id,metrics,commentary,pdf_path,status,send_attempts,generated_at")
    .eq("user_id", userId).eq("period_start", periodStart).maybeSingle();
  if (!row?.pdf_path) return null;
  const file = await admin.storage.from(BUCKET).download(row.pdf_path);
  if (file.error || !file.data) return null;
  return { report: row as StoredReport, pdf: new Uint8Array(await file.data.arrayBuffer()) };
}

// ---------------------------------------------------------------- delivery
/** Atomically claim a recipient so overlapping runs never double-send. */
async function claimDelivery(admin: Admin, reportId: string, userId: string, email: string): Promise<boolean> {
  const ins = await admin.from("executive_report_deliveries")
    .upsert({ report_id: reportId, user_id: userId, email, status: "sending" }, { onConflict: "report_id,email", ignoreDuplicates: true })
    .select("id");
  if (ins.data?.length) return true;
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  const retry = await admin.from("executive_report_deliveries")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("report_id", reportId).eq("email", email)
    .or(`status.eq.failed,and(status.eq.sending,updated_at.lt.${staleBefore})`)
    .select("id, attempts");
  if (retry.data?.length) {
    await admin.from("executive_report_deliveries").update({ attempts: (retry.data[0].attempts ?? 1) + 1 }).eq("id", retry.data[0].id);
    return true;
  }
  return false;
}

async function deliverReport(admin: Admin, s: ReportSettings, stored: { report: StoredReport; pdf: Uint8Array }, companyName: string, recipients: string[]) {
  const { report, pdf } = stored;
  const mail = renderReportEmail({ companyName, metrics: report.metrics, commentary: report.commentary });
  const filename = `${companyName.replace(/[^\w.-]+/g, "_")}_Executive_Report_${report.metrics.period.start.slice(0, 7)}.pdf`;
  let lastError: string | null = null;

  for (const email of recipients) {
    if (!(await claimDelivery(admin, report.id, s.user_id, email))) continue;
    const res = await sendReportEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text, filename, pdf });
    if (!res.ok) lastError = res.error ?? "send failed";
    await admin.from("executive_report_deliveries").update({
      status: res.ok ? "sent" : "failed", error: res.ok ? null : (res.error ?? "send failed").slice(0, 300),
      sent_at: res.ok ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
    }).eq("report_id", report.id).eq("email", email);
  }

  const { data: rows } = await admin.from("executive_report_deliveries").select("status").eq("report_id", report.id);
  const sent = (rows ?? []).filter((r: { status: string }) => r.status === "sent").length;
  const total = (rows ?? []).length;
  const status = recipients.length === 0 ? "ready" : sent === 0 ? "failed" : sent < total ? "partial" : "sent";
  const error = recipients.length === 0 ? "No valid recipients configured." : sent === total ? null : lastError;
  await admin.from("executive_reports").update({
    status, last_error: error, send_attempts: report.send_attempts + 1,
    sent_at: status === "sent" || status === "partial" ? new Date().toISOString() : null,
  }).eq("id", report.id);
  return { status, sent, total, error };
}

async function signedUrl(admin: Admin, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

// ---------------------------------------------------------------- handlers
async function runSweep(admin: Admin) {
  const startedAt = Date.now();
  const now = new Date();
  const { data: all, error } = await admin.from("executive_report_settings").select("*").eq("enabled", true);
  if (error) throw error;
  const due = (all ?? []).filter((s: ReportSettings) => isReportDue(s, now)).slice(0, 500);
  if (!due.length) return { processed: 0, due: 0 };

  const { data: profiles } = await admin.from("profiles").select("id,email,company_name,status").in("id", due.map((d: ReportSettings) => d.user_id));
  const profileById = new Map((profiles ?? []).map((p: { id: string }) => [p.id, p]));

  let processed = 0, sentCount = 0;
  const failures: string[] = [];
  for (const s of due as ReportSettings[]) {
    if (processed >= SWEEP_BATCH || Date.now() - startedAt > SWEEP_BUDGET_MS) break;
    const profile = profileById.get(s.user_id) as { email: string | null; company_name: string | null; status: string } | undefined;
    if (!profile || profile.status !== "active") continue;
    try {
      const period = previousMonthPeriod(now, s.timezone);
      const { data: existing } = await admin.from("executive_reports").select("status,send_attempts")
        .eq("user_id", s.user_id).eq("period_start", period.start).maybeSingle();
      if (existing && (existing.status === "sent" || existing.send_attempts >= MAX_ATTEMPTS)) continue;

      processed += 1;
      const name = profile.company_name?.trim() || "Your business";
      const stored = (existing && await loadStored(admin, s.user_id, period.start)) || (await generateReport(admin, s, period, name, "scheduled"));
      const recipients = await resolveRecipients(admin, s, profile.email);
      const result = await deliverReport(admin, s, stored, name, recipients);
      if (result.status === "sent") sentCount += 1;
    } catch (e) {
      failures.push(`${s.user_id}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(JSON.stringify({ event: "exec_report_sweep_item_failed", user_id: s.user_id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return { due: due.length, processed, sent: sentCount, failures: failures.length };
}

async function handleOwner(admin: Admin, userId: string, userEmail: string | null, body: Record<string, unknown>) {
  const action = String(body.action ?? "");
  if (!["preview", "send_test", "send_now"].includes(action)) return json({ error: "Unknown action." }, 400);

  const { data: profile } = await admin.from("profiles").select("id,role,email,company_name").eq("id", userId).maybeSingle();
  if (!profile || profile.role !== "owner") return json({ error: "Only the account owner can manage executive reports." }, 403);

  const { data: stored } = await admin.from("executive_report_settings").select("*").eq("user_id", userId).maybeSingle();
  const settings: ReportSettings = stored ?? DEFAULT_SETTINGS(userId);
  if (!isValidTimeZone(settings.timezone)) return json({ error: "Saved time zone is invalid." }, 400);

  const latest = previousMonthPeriod(new Date(), settings.timezone);
  const ym = typeof body.period === "string" && body.period ? body.period : latest.start.slice(0, 7);
  const period = periodForMonth(ym, settings.timezone);
  if (!period) return json({ error: "period must look like YYYY-MM." }, 400);
  if (period.start > latest.start) return json({ error: "Reports can only be generated for completed months." }, 400);

  const name = profile.company_name?.trim() || "Your business";
  const existing = await loadStored(admin, userId, period.start);

  let current = existing;
  // A report that was already emailed is never silently regenerated — the PDF must match what recipients got.
  if (!current || (action === "preview" && current.report.status !== "sent")) {
    if (existing && Date.now() - Date.parse(existing.report.generated_at) < 30_000) {
      return json({ error: "A report for this month was just generated. Please wait a moment." }, 429);
    }
    current = await generateReport(admin, settings, period, name, "manual");
  }

  let delivery: unknown = null;
  if (action === "send_test") {
    const to = (userEmail ?? profile.email ?? "").toLowerCase();
    if (!EMAIL_RE.test(to)) return json({ error: "Your account has no valid email address." }, 400);
    const mail = renderReportEmail({ companyName: name, metrics: current.report.metrics, commentary: current.report.commentary });
    const res = await sendReportEmail({
      to, subject: `[Test] ${mail.subject}`, html: mail.html, text: mail.text,
      filename: `Executive_Report_${period.start.slice(0, 7)}.pdf`, pdf: current.pdf,
    });
    delivery = { test: true, ok: res.ok, error: res.ok ? null : res.error };
  } else if (action === "send_now") {
    if (body.resend === true) await admin.from("executive_report_deliveries").delete().eq("report_id", current.report.id);
    const recipients = await resolveRecipients(admin, settings, profile.email);
    delivery = await deliverReport(admin, settings, current, name, recipients);
  }

  const { data: fresh } = await admin.from("executive_reports")
    .select("id,period_label,period_start,status,commentary_source,pdf_path,generated_at,sent_at,last_error")
    .eq("id", current.report.id).single();
  return json({ report: { ...fresh, pdf_url: await signedUrl(admin, fresh?.pdf_path ?? null) }, delivery });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    const cronHeader = req.headers.get("X-Cron-Secret");
    if (cronHeader !== null) {
      const secret = Deno.env.get("EXECUTIVE_REPORT_CRON_SECRET");
      if (!secret || !safeEqual(cronHeader, secret)) return json({ error: "Unauthorized." }, 401);
      return json(await runSweep(admin));
    }

    const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized." }, 401);
    return await handleOwner(admin, user.id, user.email ?? null, body);
  } catch (e) {
    console.error(JSON.stringify({ event: "exec_report_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Executive report run failed." }, 500);
  }
});
