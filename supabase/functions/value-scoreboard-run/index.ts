// supabase/functions/value-scoreboard-run/index.ts
//
// Monthly "Results" statement generator + sender.
//   • Cron  (header X-Cron-Secret, body {action:"sweep"}): finds owners whose statement is due in THEIR
//     time zone, snapshots last month, emails it (with PDF).
//   • Owner (Authorization: Bearer <jwt>): {action:"send_now", month?:"YYYY-MM"} — sends to the owner + extra recipients.
//
// Uses the service role (RLS bypassed), so EVERY query is explicitly scoped by user_id.
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL (optional), SITE_URL (optional), VALUE_SCOREBOARD_CRON_SECRET.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsPDF } from "npm:jspdf@2.5.2";
import {
  DEFAULT_TREND_MONTHS, MAX_SNAPSHOT_EVENTS, computeScoreboard, isMonthlyStatementDue, isValidTimeZone,
  monthWindowFor, planMonthlyCents, previousMonthWindow, shiftMonth,
  type MonthWindow, type Scoreboard, type Subscription, type ValueEvent, type ValueReview,
} from "../_shared/value-scoreboard/engine.ts";
import { renderValueEmail } from "../_shared/value-scoreboard/render.ts";
import { buildValuePdf } from "../_shared/value-scoreboard/pdf.ts";

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
const MANUAL_COOLDOWN_MS = 30_000;
const PAGE = 1000;
const MAX_ROWS = 50_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

type Admin = SupabaseClient;

interface Settings {
  user_id: string; avg_ticket_cents: number | null; subscription_cents_override: number | null; timezone: string | null;
  monthly_email_enabled: boolean; send_hour: number; extra_recipients: string[];
}
interface Profile { id: string; email: string | null; company_name: string | null; invoice_currency: string | null; plan: string | null }
interface Delivery { email: string; status: "sent" | "failed"; at: string; error?: string }
interface Stored { id: string; snapshot: Scoreboard; status: string; deliveries: Delivery[]; send_attempts: number; sent_at: string | null }

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
const companyOf = (p: Profile) => p.company_name?.trim() || "Your business";
const currencyOf = (p: Profile) => (p.invoice_currency && CURRENCY_RE.test(p.invoice_currency.toUpperCase()) ? p.invoice_currency.toUpperCase() : "USD");

async function resolveTimezone(admin: Admin, s: Settings): Promise<string> {
  if (s.timezone && isValidTimeZone(s.timezone)) return s.timezone;
  const { data } = await admin.from("business_profile").select("timezone").eq("user_id", s.user_id).limit(1).maybeSingle();
  const tz = (data as { timezone: string | null } | null)?.timezone;
  return tz && isValidTimeZone(tz) ? tz : "America/New_York";
}

function subscriptionFor(p: Profile, s: Settings): Subscription | null {
  const cur = currencyOf(p);
  if (s.subscription_cents_override !== null && s.subscription_cents_override !== undefined) return { cents: s.subscription_cents_override, currency: cur };
  const list = planMonthlyCents(p.plan);
  return list === null ? null : { cents: list, currency: "USD" };
}

// ---------------------------------------------------------------- data
async function loadEvents(admin: Admin, userId: string, w: MonthWindow): Promise<{ events: ValueEvent[]; reviews: ValueReview[] }> {
  const from = monthWindowFor(shiftMonth(w.month, -(DEFAULT_TREND_MONTHS - 1)), w.timezone)!.startUtc;
  const events: ValueEvent[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await admin.from("value_events")
      .select("id,source_feature,type,amount,unit,currency,confidence,method_note,evidence_ref,supersedes_ref,occurred_at")
      .eq("user_id", userId).gte("occurred_at", from).lt("occurred_at", w.endUtc)
      .order("occurred_at", { ascending: true }).order("id", { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw new Error(`Events load failed: ${error.message}`);
    events.push(...((data ?? []) as ValueEvent[]));
    if (!data || data.length < PAGE) break;
  }
  const reviews: ValueReview[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await admin.from("value_event_reviews").select("value_event_id,decision,decided_at")
      .eq("user_id", userId).order("decided_at", { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw new Error(`Reviews load failed: ${error.message}`);
    reviews.push(...((data ?? []) as ValueReview[]));
    if (!data || data.length < PAGE) break;
  }
  return { events, reviews };
}

async function getOrCreateStatement(admin: Admin, profile: Profile, s: Settings, w: MonthWindow): Promise<Stored> {
  const select = "id,snapshot,status,deliveries,send_attempts,sent_at";
  const existing = await admin.from("value_statements").select(select).eq("user_id", profile.id).eq("month_start", `${w.month}-01`).maybeSingle();
  if (existing.data) return existing.data as Stored;

  const { events, reviews } = await loadEvents(admin, profile.id, w);
  const board = computeScoreboard({
    events, reviews, window: w, currency: currencyOf(profile), subscription: subscriptionFor(profile, s), maxEvents: MAX_SNAPSHOT_EVENTS,
  });
  const ins = await admin.from("value_statements").insert({
    user_id: profile.id, month_start: `${w.month}-01`, period_label: w.label, method_version: board.methodVersion, currency: board.currency,
    measured_cents: board.money.measuredCents, estimated_cents: board.money.estimatedCents, saved_minutes: board.hours.totalMinutes, snapshot: board,
  }).select(select).single();
  if (ins.data) return ins.data as Stored;

  const again = await admin.from("value_statements").select(select).eq("user_id", profile.id).eq("month_start", `${w.month}-01`).maybeSingle();
  if (again.data) return again.data as Stored;
  throw new Error(`Statement save failed: ${ins.error?.message ?? "unknown"}`);
}

// ---------------------------------------------------------------- delivery
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function sendEmail(opts: { to: string; subject: string; html: string; text: string; filename: string; pdf: Uint8Array | null }): Promise<{ ok: boolean; error?: string }> {
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
function tryPdf(profile: Profile, board: Scoreboard): Uint8Array | null {
  try {
    return buildValuePdf(jsPDF as never, { companyName: companyOf(profile), board, siteUrl: siteUrl() });
  } catch (e) {
    console.error(JSON.stringify({ event: "value_pdf_failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

function recipientsOf(profile: Profile, s: Settings): string[] {
  const set = new Set<string>();
  for (const e of [profile.email, ...(s.extra_recipients ?? [])]) {
    const v = (e ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(v)) set.add(v);
  }
  return [...set].slice(0, 11);
}

async function deliver(admin: Admin, profile: Profile, s: Settings, st: Stored, force: boolean): Promise<{ status: string; sent: number; failed: number }> {
  const board = st.snapshot;
  const mail = renderValueEmail({ companyName: companyOf(profile), board, siteUrl: siteUrl() });
  const pdf = tryPdf(profile, board);
  const prior = new Map<string, Delivery>((st.deliveries ?? []).map((d) => [d.email, d]));
  const targets = recipientsOf(profile, s);
  let sent = 0, failed = 0;

  for (const email of targets) {
    if (!force && prior.get(email)?.status === "sent") { sent++; continue; }
    const r = await sendEmail({ to: email, ...mail, filename: `vireek-results-${board.window.month}.pdf`, pdf });
    prior.set(email, { email, status: r.ok ? "sent" : "failed", at: new Date().toISOString(), ...(r.ok ? {} : { error: r.error }) });
    if (r.ok) sent++;
    else failed++;
  }
  const status = targets.length === 0 ? "failed" : failed === 0 ? "sent" : sent > 0 ? "partial" : "failed";
  const lastError = [...prior.values()].find((d) => d.status === "failed")?.error ?? null;
  await admin.from("value_statements").update({
    status, deliveries: [...prior.values()], send_attempts: (st.send_attempts ?? 0) + 1, last_error: targets.length === 0 ? "No valid recipient email." : lastError,
    sent_at: sent > 0 ? new Date().toISOString() : st.sent_at,
  }).eq("id", st.id).eq("user_id", profile.id);
  return { status, sent, failed };
}

// ---------------------------------------------------------------- entry
async function loadProfile(admin: Admin, id: string): Promise<Profile | null> {
  const { data } = await admin.from("profiles").select("id,email,company_name,invoice_currency,plan").eq("id", id).maybeSingle();
  return (data as Profile | null) ?? null;
}

async function sweep(admin: Admin): Promise<Record<string, unknown>> {
  const started = Date.now();
  const { data } = await admin.from("value_settings")
    .select("user_id,avg_ticket_cents,subscription_cents_override,timezone,monthly_email_enabled,send_hour,extra_recipients")
    .eq("monthly_email_enabled", true).limit(2000);
  const now = new Date();
  let processed = 0, sentCount = 0, skipped = 0, errors = 0;

  for (const s of (data ?? []) as Settings[]) {
    if (processed >= SWEEP_BATCH || Date.now() - started > SWEEP_BUDGET_MS) break;
    try {
      const tz = await resolveTimezone(admin, s);
      if (!isMonthlyStatementDue({ enabled: true, send_hour: s.send_hour, timezone: tz }, now)) { skipped++; continue; }
      const w = previousMonthWindow(now, tz);
      const existing = await admin.from("value_statements").select("status,send_attempts").eq("user_id", s.user_id).eq("month_start", `${w.month}-01`).maybeSingle();
      const ex = existing.data as { status: string; send_attempts: number } | null;
      if (ex && (ex.status === "sent" || ex.send_attempts >= MAX_ATTEMPTS)) { skipped++; continue; }
      const profile = await loadProfile(admin, s.user_id);
      if (!profile) { skipped++; continue; }
      processed++;
      const st = await getOrCreateStatement(admin, profile, s, w);
      const r = await deliver(admin, profile, s, st, false);
      if (r.sent > 0) sentCount++;
    } catch (e) {
      errors++;
      console.error(JSON.stringify({ event: "value_sweep_error", user: s.user_id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return { processed, sent: sentCount, skipped, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server is not configured." }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { action?: string; month?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const cron = Deno.env.get("VALUE_SCOREBOARD_CRON_SECRET");
  const presented = req.headers.get("X-Cron-Secret");
  if (presented) {
    if (!cron || !safeEqual(presented, cron)) return json({ error: "Unauthorized." }, 401);
    if (body.action !== "sweep") return json({ error: "Unknown action." }, 400);
    return json({ ok: true, ...(await sweep(admin)) });
  }

  // Owner-initiated
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized." }, 401);
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return json({ error: "Unauthorized." }, 401);
  if (body.action !== "send_now") return json({ error: "Unknown action." }, 400);

  const profile = await loadProfile(admin, u.user.id);
  if (!profile) return json({ error: "Only the account owner can send the summary." }, 403);

  const { data: row } = await admin.from("value_settings")
    .select("user_id,avg_ticket_cents,subscription_cents_override,timezone,monthly_email_enabled,send_hour,extra_recipients")
    .eq("user_id", profile.id).maybeSingle();
  const s: Settings = (row as Settings | null) ?? {
    user_id: profile.id, avg_ticket_cents: null, subscription_cents_override: null, timezone: null,
    monthly_email_enabled: false, send_hour: 8, extra_recipients: [],
  };
  const tz = await resolveTimezone(admin, s);
  const w = body.month ? monthWindowFor(body.month, tz) : previousMonthWindow(new Date(), tz);
  if (!w) return json({ error: "Invalid month." }, 400);

  try {
    const st = await getOrCreateStatement(admin, profile, s, w);
    if (st.sent_at && Date.now() - Date.parse(st.sent_at) < MANUAL_COOLDOWN_MS) return json({ error: "Please wait a moment before sending again." }, 429);
    const r = await deliver(admin, profile, s, st, true);
    return json({ ok: r.sent > 0, ...r, month: w.month });
  } catch (e) {
    console.error(JSON.stringify({ event: "value_send_now_error", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Could not send the summary. Try again shortly." }, 500);
  }
});
