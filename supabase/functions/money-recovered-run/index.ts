// supabase/functions/money-recovered-run/index.ts
//
// Weekly "Money Recovered" statement generator + scheduler.
//   • Cron  (header X-Cron-Secret, body {action:"sweep"}): finds owners whose statement is due in
//     THEIR time zone, snapshots last week's statement (Mon–Sun), emails it with the PDF attached.
//   • Owner (Authorization: Bearer <jwt>): {action:"send_test" | "send_now", weekStart?:"YYYY-MM-DD", resend?:boolean}
//
// This function uses the service role (RLS bypassed), so EVERY query is explicitly scoped by user_id.
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL (optional), SITE_URL (optional), MONEY_RECOVERED_CRON_SECRET.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsPDF } from "npm:jspdf@2.5.2";
import {
  computeStatement, isStatementDue, isValidTimeZone, previousWeekWindow, weekWindowFor,
  type Baseline, type CallInfo, type LedgerEvent, type Statement, type Window,
} from "../_shared/money-recovered/engine.ts";
import { renderStatementEmail } from "../_shared/money-recovered/render.ts";
import { buildStatementPdf } from "../_shared/money-recovered/pdf.ts";
import { parsePilotResults, renderPilotBlock } from "../_shared/pilot-results/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_ATTEMPTS = 5;
const SWEEP_BATCH = 20;
const SWEEP_BUDGET_MS = 100_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MANUAL_COOLDOWN_MS = 30_000;

type Admin = SupabaseClient;

interface Settings {
  user_id: string; enabled: boolean; send_hour: number; timezone: string;
  include_owner: boolean; include_co_owners: boolean; extra_recipients: string[];
}
interface Profile { id: string; email: string | null; company_name: string | null; invoice_currency: string | null; status: string | null; role: string | null }
snapshot: Statement & { pilot?: unknown }; status: string; send_attempts: number; generated_at: string }

const DEFAULT_SETTINGS = (userId: string): Settings => ({
  user_id: userId, enabled: false, send_hour: 8, timezone: "America/New_York",
  include_owner: true, include_co_owners: true, extra_recipients: [],
});

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
const companyOf = (p: Profile) => p.company_name?.trim() || "Your business";
const currencyOf = (p: Profile) => (p.invoice_currency && CURRENCY_RE.test(p.invoice_currency) ? p.invoice_currency : "USD");

// ---------------------------------------------------------------- data
// deno-lint-ignore no-explicit-any
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, cap = 10000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message ?? "query failed");
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const EVENT_COLS =
  "id,source_type,call_id,customer_name,occurred_at,estimated_value_cents,status,recovery_method,recovered_amount_cents,follow_up_count,last_follow_up_at,resolved_at";

async function loadEvents(admin: Admin, userId: string, w: Window): Promise<LedgerEvent[]> {
  const base = () => admin.from("revenue_recovery_events").select(EVENT_COLS).eq("user_id", userId);
  const [resolved, active, occurred] = await Promise.all([
    fetchAll<LedgerEvent>((a, b) => base().eq("status", "recovered").gte("resolved_at", w.startUtc).lt("resolved_at", w.endUtc).order("id").range(a, b)),
    fetchAll<LedgerEvent>((a, b) => base().in("status", ["open", "contacted"]).order("id").range(a, b)),
    fetchAll<LedgerEvent>((a, b) => base().gte("occurred_at", w.startUtc).lt("occurred_at", w.endUtc).order("id").range(a, b)),
  ]);
  return [...new Map([...resolved, ...active, ...occurred].map((e) => [e.id, e])).values()];
}

async function loadCalls(admin: Admin, userId: string, events: LedgerEvent[]): Promise<CallInfo[]> {
  const ids = [...new Set(events.map((e) => e.call_id).filter((x): x is string => Boolean(x)))];
  const out: CallInfo[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await admin.from("calls").select("id,summary,recording_url").eq("user_id", userId).in("id", ids.slice(i, i + 150));
    if (error) throw new Error(`Could not load calls: ${error.message}`);
    for (const c of (data ?? []) as { id: string; summary: string | null; recording_url: string | null }[]) {
      out.push({ id: c.id, summary: c.summary, has_recording: typeof c.recording_url === "string" && c.recording_url.startsWith("https://") });
    }
  }
  return out;
}

async function loadBaseline(admin: Admin, userId: string): Promise<Baseline | null> {
  const { data } = await admin.from("money_recovered_baselines").select("monthly_leak_cents,source,label,captured_at")
    .eq("user_id", userId).order("captured_at", { ascending: false }).limit(1).maybeSingle();
  return (data as Baseline | null) ?? null;
}

async function loadPilot(admin: Admin, userId: string): Promise<unknown> {
  try {
    const { data, error } = await admin.rpc("pilot_results_core", { p_tenant: userId });
    return error ? null : data;
  } catch { return null; }
}
function pilotBlockFor(profile: Profile, snapshot: { pilot?: unknown }) {
  const p = parsePilotResults(snapshot.pilot);
  return p ? renderPilotBlock(p, currencyOf(profile), `${siteUrl()}/dashboard/pilot-results`) : null;
}
// ---------------------------------------------------------------- statement
async function getOrCreateStatement(admin: Admin, profile: Profile, w: Window, trigger: "scheduled" | "manual"): Promise<Stored> {
  const select = "id,snapshot,status,send_attempts,generated_at";
  const existing = await admin.from("money_recovered_statements").select(select).eq("user_id", profile.id).eq("week_start", w.start).maybeSingle();
  if (existing.data) return existing.data as Stored;

  const events = await loadEvents(admin, profile.id, w);
  const statement = computeStatement({
    events, calls: await loadCalls(admin, profile.id, events), baseline: await loadBaseline(admin, profile.id),
    window: w, now: new Date(), currency: currencyOf(profile),
  });
  const ins = await admin.from("money_recovered_statements").insert({
    user_id: profile.id, week_start: w.start, week_end: w.end, period_label: w.label, method_version: statement.methodVersion,
    credited_cents: statement.creditedCents, snapshot: { ...statement, pilot: await loadPilot(admin, profile.id) }, trigger,
  }).select(select).single();
  if (ins.data) return ins.data as Stored;

  // Lost a race with an overlapping run: use the row that won.
  const again = await admin.from("money_recovered_statements").select(select).eq("user_id", profile.id).eq("week_start", w.start).maybeSingle();
  if (again.data) return again.data as Stored;
  throw new Error(`Statement save failed: ${ins.error?.message ?? "unknown"}`);
}

// ---------------------------------------------------------------- recipients + delivery
async function resolveRecipients(admin: Admin, s: Settings, ownerEmail: string | null): Promise<string[]> {
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

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function sendMail(opts: {
  to: string; subject: string; html: string; text: string; filename: string; pdf: Uint8Array | null;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { ok: false, error: "Email isn't configured yet (missing RESEND_API_KEY)." };
  const from = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text,
        ...(opts.pdf ? { attachments: [{ filename: opts.filename, content: toBase64(opts.pdf) }] } : {}),
      }),
    });
    return res.ok ? { ok: true } : { ok: false, error: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The PDF is a bonus: if it ever fails to build, the email (which carries everything) still goes out. */
function tryPdf(profile: Profile, statement: Statement): Uint8Array | null {
  try {
    return buildStatementPdf(jsPDF as never, { companyName: companyOf(profile), statement, siteUrl: siteUrl() });
  } catch (e) {
    console.error(JSON.stringify({ event: "money_recovered_pdf_failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

const fileName = (profile: Profile, st: Statement) =>
  `${companyOf(profile).replace(/[^\w.-]+/g, "_")}_Money_Recovered_${st.period.start}.pdf`;

/** Atomically claim a recipient so overlapping runs never double-send. */
async function claimDelivery(admin: Admin, statementId: string, userId: string, email: string): Promise<boolean> {
  const ins = await admin.from("money_recovered_deliveries")
    .upsert({ statement_id: statementId, user_id: userId, email, status: "sending" }, { onConflict: "statement_id,email", ignoreDuplicates: true })
    .select("id");
  if (ins.data?.length) return true;
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  const retry = await admin.from("money_recovered_deliveries")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("statement_id", statementId).eq("email", email)
    .or(`status.eq.failed,and(status.eq.sending,updated_at.lt.${staleBefore})`)
    .select("id, attempts");
  if (retry.data?.length) {
    await admin.from("money_recovered_deliveries").update({ attempts: (retry.data[0].attempts ?? 1) + 1 }).eq("id", retry.data[0].id);
    return true;
  }
  return false;
}

async function deliver(admin: Admin, profile: Profile, stored: Stored, recipients: string[]) {
  const st = stored.snapshot;
  const mail = renderStatementEmail({ companyName: companyOf(profile), statement: st, siteUrl: siteUrl() } , pilot: pilotBlockFor(profile, st));
  const pdf = tryPdf(profile, st);
  let lastError: string | null = null;

  for (const email of recipients) {
    if (!(await claimDelivery(admin, stored.id, profile.id, email))) continue;
    const res = await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text, filename: fileName(profile, st), pdf });
    if (!res.ok) lastError = res.error ?? "send failed";
    await admin.from("money_recovered_deliveries").update({
      status: res.ok ? "sent" : "failed", error: res.ok ? null : (res.error ?? "send failed").slice(0, 300),
      sent_at: res.ok ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
    }).eq("statement_id", stored.id).eq("email", email);
  }

  const { data: rows } = await admin.from("money_recovered_deliveries").select("status").eq("statement_id", stored.id);
  const sent = (rows ?? []).filter((r: { status: string }) => r.status === "sent").length;
  const total = (rows ?? []).length;
  const status = recipients.length === 0 ? "ready" : sent === 0 ? "failed" : sent < total ? "partial" : "sent";
  const error = recipients.length === 0 ? "No valid recipients configured." : sent === total ? null : lastError;
  await admin.from("money_recovered_statements").update({
    status, last_error: error, send_attempts: stored.send_attempts + 1,
    sent_at: status === "sent" || status === "partial" ? new Date().toISOString() : null,
  }).eq("id", stored.id).eq("user_id", profile.id);
  return { status, sent, total, error };
}

// ---------------------------------------------------------------- handlers
async function runSweep(admin: Admin) {
  const startedAt = Date.now();
  const now = new Date();
  const { data: all, error } = await admin.from("money_recovered_settings").select("*").eq("enabled", true);
  if (error) throw error;
  const due = ((all ?? []) as Settings[]).filter((s) => isStatementDue(s, now)).slice(0, 500);
  if (!due.length) return { processed: 0, due: 0 };

  const { data: profiles } = await admin.from("profiles").select("id,email,company_name,invoice_currency,status,role").in("id", due.map((d) => d.user_id));
  const byId = new Map(((profiles ?? []) as Profile[]).map((p) => [p.id, p]));

  let processed = 0, sentCount = 0;
  const failures: string[] = [];
  for (const s of due) {
    if (processed >= SWEEP_BATCH || Date.now() - startedAt > SWEEP_BUDGET_MS) break;
    const profile = byId.get(s.user_id);
    if (!profile || profile.status !== "active") continue;
    try {
      const w = previousWeekWindow(now, s.timezone);
      const { data: existing } = await admin.from("money_recovered_statements").select("status,send_attempts")
        .eq("user_id", s.user_id).eq("week_start", w.start).maybeSingle();
      if (existing && (existing.status === "sent" || existing.send_attempts >= MAX_ATTEMPTS)) continue;

      processed += 1;
      const stored = await getOrCreateStatement(admin, profile, w, "scheduled");
      const result = await deliver(admin, profile, stored, await resolveRecipients(admin, s, profile.email));
      if (result.status === "sent") sentCount += 1;
    } catch (e) {
      failures.push(`${s.user_id}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(JSON.stringify({ event: "money_recovered_sweep_item_failed", user_id: s.user_id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return { due: due.length, processed, sent: sentCount, failures: failures.length };
}

async function handleOwner(admin: Admin, userId: string, userEmail: string | null, body: Record<string, unknown>) {
  const action = String(body.action ?? "");
  if (action !== "send_test" && action !== "send_now") return json({ error: "Unknown action." }, 400);

  const { data: profile } = await admin.from("profiles").select("id,email,company_name,invoice_currency,status,role").eq("id", userId).maybeSingle();
  if (!profile || profile.role !== "owner") return json({ error: "Only the account owner can send Money Recovered statements." }, 403);

  const { data: stored } = await admin.from("money_recovered_settings").select("*").eq("user_id", userId).maybeSingle();
  const settings: Settings = stored ?? DEFAULT_SETTINGS(userId);
  if (!isValidTimeZone(settings.timezone)) return json({ error: "Saved time zone is invalid." }, 400);

  const now = new Date();
  const latest = previousWeekWindow(now, settings.timezone);
  const w = typeof body.weekStart === "string" && body.weekStart ? weekWindowFor(body.weekStart, settings.timezone) : latest;
  if (!w) return json({ error: "weekStart must be a Monday formatted YYYY-MM-DD." }, 400);
  if (w.start > latest.start) return json({ error: "Statements can only be generated for completed weeks." }, 400);

  const existing = await admin.from("money_recovered_statements").select("generated_at,status").eq("user_id", userId).eq("week_start", w.start).maybeSingle();
  if (existing.data && Date.now() - Date.parse(existing.data.generated_at) < MANUAL_COOLDOWN_MS && action === "send_now" && existing.data.status === "sent") {
    return json({ error: "That statement was just sent. Please wait a moment." }, 429);
  }

  const current = await getOrCreateStatement(admin, profile as Profile, w, "manual");
  let delivery: unknown;
  if (action === "send_test") {
    const to = (userEmail ?? profile.email ?? "").toLowerCase();
    if (!EMAIL_RE.test(to)) return json({ error: "Your account has no valid email address." }, 400);
    const mail = renderStatementEmail({ companyName: companyOf(profile as Profile), statement: current.snapshot, siteUrl: siteUrl(), subjectPrefix: "[Test] " , pilot: pilotBlockFor(profile as Profile, current.snapshot) });
    const res = await sendMail({
      to, subject: mail.subject, html: mail.html, text: mail.text,
      filename: fileName(profile as Profile, current.snapshot), pdf: tryPdf(profile as Profile, current.snapshot),
    });
    delivery = { test: true, ok: res.ok, error: res.ok ? null : res.error };
  } else {
    if (body.resend === true) await admin.from("money_recovered_deliveries").delete().eq("statement_id", current.id).eq("user_id", userId);
    delivery = await deliver(admin, profile as Profile, current, await resolveRecipients(admin, settings, profile.email));
  }

  const { data: fresh } = await admin.from("money_recovered_statements")
    .select("id,week_start,week_end,period_label,credited_cents,status,generated_at,sent_at,last_error")
    .eq("id", current.id).eq("user_id", userId).single();
  return json({ statement: fresh, delivery });
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
      const secret = Deno.env.get("MONEY_RECOVERED_CRON_SECRET");
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
    console.error(JSON.stringify({ event: "money_recovered_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Money Recovered run failed." }, 500);
  }
});
