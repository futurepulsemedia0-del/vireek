// supabase/functions/daily-briefing/index.ts
//
// Composes and delivers the daily briefing (push / email / in-dashboard card).
//
//   cron   : POST with header `x-briefing-secret` (hourly, from pg_cron -> dispatch_daily_briefing()).
//            Sends to every recipient whose LOCAL time is inside their send-hour window.
//   self   : POST with a user's `Authorization: Bearer <jwt>` and body {"mode":"self"}.
//            Rebuilds the caller's own briefing for the dashboard card ("Refresh"); never pushes/emails.
//
// Reuse: all composition lives in src/lib/dailyBriefing.ts, built on src/lib/changesSinceYesterday.ts
// (same snapshot + thresholds as the dashboard's "Since yesterday" card). "AI-recommended actions"
// come from `ai_insights`, produced by the existing `generate-insights` function (invoked here when
// today's insights are stale). This file only does I/O.
//
// Secrets:  BRIEFING_CRON_SECRET (required) · SITE_URL · RESEND_API_KEY/RESEND_FROM_EMAIL (email)
//           VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT (push; same as send-push-notification)
// Deploy:   supabase functions deploy daily-briefing --no-verify-jwt
//           (auth is enforced in-code: shared secret for cron, getUser() for self)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { computeSnapshot, DAY_MS, invoiceTotalCents, type RawData } from "../../../src/lib/changesSinceYesterday.ts";
import {
  canSeeBilling,
  composeBriefing,
  isDue,
  localDayBoundsUtc,
  localParts,
  sanitizePrefs,
  toEmail,
  toPushPayload,
  type Briefing,
  type BriefingInputs,
  type BriefingRecipient,
  type BriefingRole,
  type ExpiringItem,
  type SectionKey,
} from "../../../src/lib/dailyBriefing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-briefing-secret, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TIME_BUDGET_MS = 110_000; // stop starting new accounts; leftovers are still due on the next hourly tick
const CONCURRENCY = 4;
const INSIGHT_STALE_MS = 20 * 3_600_000;

type Admin = SupabaseClient;
type Channel = "push" | "email" | "in_app";
type Delivered = Partial<Record<Channel, { ok: boolean; detail?: string }>>;

interface PrefRow {
  id: string;
  account_owner_id: string;
  team_member_id: string | null;
  enabled: boolean;
  send_hour: number;
  timezone: string;
  channel_push: boolean;
  channel_email: boolean;
  channel_in_app: boolean;
  sections: string[] | null;
  last_sent_on: string | null;
}
interface MemberRow {
  id: string;
  role: BriefingRole | null;
  member_email: string | null;
  member_name: string | null;
  user_id: string | null;
  permissions: { can_view_billing?: boolean } | null;
  invite_status: string | null;
  max_jobs_per_day: number | null;
  dispatch_enabled: boolean | null;
}

const rowToPrefs = (r: PrefRow) =>
  sanitizePrefs({
    enabled: r.enabled,
    sendHour: r.send_hour,
    timezone: r.timezone,
    channels: { push: r.channel_push, email: r.channel_email, inApp: r.channel_in_app },
    sections: (r.sections ?? null) as SectionKey[] | null,
    lastSentOn: r.last_sent_on,
  });

/** A failed source becomes `null` (section hidden) — never a misleading zero. */
async function load<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[] | null> {
  try {
    const { data, error } = await q;
    return error || !Array.isArray(data) ? null : (data as T[]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- data (one pass per account + timezone)

interface AccountData {
  team: MemberRow[] | null;
  profile: { email: string | null; full_name: string | null; company_name: string | null } | null;
  invoices: (RawData["invoices"] & unknown[]) | null;
  calls: Array<{ id: string; call_datetime: string; sentiment: string | null; is_emergency: boolean | null; caller_name: string | null }> | null;
  jobsCreated: { created_at: string }[] | null;
  reviews: RawData["reviews"];
  quotes: ExpiringItem[] | null;
  contracts: ExpiringItem[] | null;
  insights: BriefingInputs["insights"];
  callIdsWithJob: Set<string> | null;
}

async function ensureFreshInsights(admin: Admin, ownerId: string, now: number): Promise<void> {
  const { data } = await admin
    .from("ai_insights").select("created_at").eq("user_id", ownerId).eq("is_dismissed", false)
    .order("created_at", { ascending: false }).limit(1);
  const newest = data?.[0]?.created_at ? Date.parse(data[0].created_at) : 0;
  if (now - newest < INSIGHT_STALE_MS) return;
  try {
    // Reuse the existing function as-is (it dedupes against open insights and has its own AI→rules fallback).
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-insights`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ user_id: ownerId }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "insights_refresh_failed", ownerId, error: String(err) }));
  }
}

async function loadAccount(admin: Admin, ownerId: string, now: number): Promise<AccountData> {
  const since48h = new Date(now - 2 * DAY_MS).toISOString();
  const since24h = new Date(now - DAY_MS).toISOString();
  await ensureFreshInsights(admin, ownerId, now);

  const [team, profileRows, invoices, calls, jobsCreated, reviews, insights] = await Promise.all([
    load<MemberRow>(admin.from("team_members")
      .select("id,role,member_email,member_name,user_id,permissions,invite_status,max_jobs_per_day,dispatch_enabled")
      .eq("account_owner_id", ownerId)),
    load<AccountData["profile"] & object>(admin.from("profiles").select("email,full_name,company_name").eq("id", ownerId).limit(1)),
    load<NonNullable<RawData["invoices"]>[number] & { customer_name: string; due_date: string | null }>(
      admin.from("invoices")
        .select("status,sent_at,paid_at,created_at,line_items,tax_percent,customer_name,due_date")
        .eq("user_id", ownerId).neq("status", "void").neq("status", "draft")
        .or(`paid_at.is.null,paid_at.gte.${since48h}`)),
    load<NonNullable<AccountData["calls"]>[number]>(
      admin.from("calls").select("id,call_datetime,sentiment,is_emergency,caller_name").eq("user_id", ownerId).gte("call_datetime", since48h)),
    load<{ created_at: string }>(admin.from("jobs").select("created_at").eq("user_id", ownerId).gte("created_at", since48h)),
    load<NonNullable<RawData["reviews"]>[number]>(
      admin.from("review_requests").select("rating,completed_at").eq("user_id", ownerId)
        .eq("status", "completed").lte("rating", 2).gte("completed_at", since48h)),
    load<NonNullable<BriefingInputs["insights"]>[number]>(
      admin.from("ai_insights").select("title,description,recommended_action,priority")
        .eq("user_id", ownerId).eq("is_dismissed", false).order("created_at", { ascending: false }).limit(20)),
  ]);

  const emergencyIds = (calls ?? []).filter((c) => c.is_emergency && c.call_datetime >= since24h).map((c) => c.id);
  const withJob = emergencyIds.length
    ? await load<{ call_id: string }>(admin.from("jobs").select("call_id").eq("user_id", ownerId).in("call_id", emergencyIds))
    : [];

  const plusDays = (n: number) => new Date(now + n * DAY_MS).toISOString().slice(0, 10);
  const [quotes, contracts] = await Promise.all([
    load<{ customer_name: string; valid_until: string; line_items: unknown; tax_percent: number | null }>(
      admin.from("quotes").select("customer_name,valid_until,line_items,tax_percent").eq("user_id", ownerId)
        .in("status", ["sent"]).gte("valid_until", plusDays(-1)).lte("valid_until", plusDays(4))),
    load<{ contract_name: string; end_date: string }>(
      admin.from("commercial_contracts").select("contract_name,end_date").eq("user_id", ownerId)
        .in("status", ["active", "expiring_soon"]).gte("end_date", plusDays(-1)).lte("end_date", plusDays(31))),
  ]);

  return {
    team,
    profile: profileRows?.[0] ?? null,
    invoices,
    calls,
    jobsCreated,
    reviews,
    insights,
    callIdsWithJob: withJob ? new Set(withJob.map((j) => j.call_id)) : null,
    quotes: quotes
      ? quotes.map((q) => ({
          kind: "quote" as const,
          label: `for ${q.customer_name}`,
          date: q.valid_until,
          amountCents: invoiceTotalCents({ line_items: q.line_items as never, tax_percent: q.tax_percent }),
        }))
      : null,
    contracts: contracts ? contracts.map((c) => ({ kind: "contract" as const, label: c.contract_name, date: c.end_date })) : null,
  };
}

async function buildInputs(admin: Admin, ownerId: string, data: AccountData, tz: string, now: number): Promise<BriefingInputs> {
  const day = localDayBoundsUtc(now, tz);
  const yesterdayStart = localDayBoundsUtc(now - DAY_MS, tz).start;
  const jobsWindow = await load<{
    id: string; customer_name: string; service_type: string | null; scheduled_datetime: string | null;
    job_status: string; assigned_technician_id: string | null;
  }>(
    admin.from("jobs")
      .select("id,customer_name,service_type,scheduled_datetime,job_status,assigned_technician_id")
      .eq("user_id", ownerId)
      .gte("scheduled_datetime", new Date(yesterdayStart).toISOString())
      .lt("scheduled_datetime", new Date(day.end).toISOString()),
  );

  const dailyCapacity = data.team
    ? data.team
        .filter((m) => m.dispatch_enabled && m.invite_status === "active")
        .reduce((s, m) => s + (Number(m.max_jobs_per_day) || 0), 0)
    : null;

  // Same inputs as the dashboard's fetchChangeSnapshot(), scoped to the account.
  const snapshot = computeSnapshot(
    {
      invoices: data.invoices as RawData["invoices"],
      calls: data.calls,
      jobsCreated: data.jobsCreated,
      jobsScheduled: jobsWindow,
      reviews: data.reviews,
      dailyCapacity,
    },
    now,
  );

  const since24h = now - DAY_MS;
  const emergencyCalls = data.calls && data.callIdsWithJob
    ? data.calls
        .filter((c) => c.is_emergency && Date.parse(c.call_datetime) >= since24h)
        .map((c) => ({ id: c.id, caller_name: c.caller_name, call_datetime: c.call_datetime, has_job: data.callIdsWithJob!.has(c.id) }))
    : null;

  const unpaid = data.invoices
    ? (data.invoices as Array<{ status: string; paid_at: string | null; customer_name: string; due_date: string | null; line_items: never; tax_percent: number | null }>)
        .filter((i) => (i.status === "sent" || i.status === "viewed") && !i.paid_at)
        .map((i) => ({ status: i.status, customer_name: i.customer_name, due_date: i.due_date, line_items: i.line_items, tax_percent: i.tax_percent }))
    : null;

  return {
    now,
    timezone: tz,
    snapshot,
    jobsToday: jobsWindow
      ? jobsWindow.filter((j) => j.scheduled_datetime && Date.parse(j.scheduled_datetime) >= day.start && Date.parse(j.scheduled_datetime) < day.end)
      : null,
    dailyCapacity,
    emergencyCalls,
    unpaidInvoices: unpaid,
    expiring: data.quotes || data.contracts ? [...(data.quotes ?? []), ...(data.contracts ?? [])] : null,
    insights: data.insights,
  };
}

// ---------------------------------------------------------------- recipients & delivery

interface Recipient {
  pref: PrefRow;
  who: BriefingRecipient;
  email: string | null;
  authUserId: string | null;
}

function resolveRecipient(pref: PrefRow, data: AccountData): Recipient | null {
  if (!pref.team_member_id) {
    const role: BriefingRole = "owner";
    return {
      pref,
      who: { role, name: data.profile?.full_name ?? null, canViewBilling: true, teamMemberId: null, sections: pref.sections as SectionKey[] | null },
      email: data.profile?.email ?? null,
      authUserId: pref.account_owner_id,
    };
  }
  const m = data.team?.find((t) => t.id === pref.team_member_id);
  if (!m || m.invite_status !== "active") return null; // pending/removed members never get briefings
  const role: BriefingRole = m.role ?? "member";
  return {
    pref,
    who: { role, name: m.member_name, canViewBilling: canSeeBilling(role, m.permissions), teamMemberId: m.id, sections: pref.sections as SectionKey[] | null },
    email: m.member_email,
    authUserId: m.user_id,
  };
}

let vapidReady: boolean | null = null;
function initVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY"), subj = Deno.env.get("VAPID_SUBJECT");
  vapidReady = Boolean(pub && priv && subj);
  if (vapidReady) webpush.setVapidDetails(subj!, pub!, priv!);
  return vapidReady;
}

async function sendPush(admin: Admin, r: Recipient, b: Briefing): Promise<{ ok: boolean; detail?: string }> {
  if (!initVapid()) return { ok: true, detail: "skipped: push not configured" };
  if (!r.authUserId) return { ok: true, detail: "skipped: member has no login yet" };
  // Owner also owns legacy rows registered before subscriber_id existed (NULL).
  const filter = r.pref.team_member_id
    ? `subscriber_id.eq.${r.authUserId}`
    : `subscriber_id.eq.${r.authUserId},and(subscriber_id.is.null,user_id.eq.${r.pref.account_owner_id})`;
  const { data: subs, error } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth_key").or(filter);
  if (error) return { ok: false, detail: "subscription lookup failed" };
  if (!subs?.length) return { ok: true, detail: "skipped: no devices" };

  const body = JSON.stringify(toPushPayload(b));
  let sent = 0;
  await Promise.all(subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth_key: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, body);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
    }
  }));
  return { ok: sent > 0 || subs.length === 0, detail: `sent ${sent}/${subs.length}` };
}

async function sendMail(r: Recipient, b: Briefing, company: string | null): Promise<{ ok: boolean; detail?: string }> {
  if (!r.email) return { ok: true, detail: "skipped: no email address" };
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const m = toEmail(b, { companyName: company, dashboardUrl: siteUrl });
  const res = await sendEmail(r.email, m.subject, m.html, m.text);
  return res.ok ? { ok: true } : { ok: false, detail: (res.error ?? "email failed").slice(0, 200) };
}

async function processRecipient(admin: Admin, r: Recipient, inputs: BriefingInputs, company: string | null, mode: "cron" | "self") {
  const prefs = rowToPrefs(r.pref);
  const date = localParts(inputs.now, prefs.timezone).date;
  const base = admin.from("daily_briefings").select("id,payload,delivered")
    .eq("account_owner_id", r.pref.account_owner_id).eq("briefing_date", date);
  const { data: existing } = await (r.pref.team_member_id ? base.eq("team_member_id", r.pref.team_member_id) : base.is("team_member_id", null)).maybeSingle();

  // Retries within the catch-up window re-send the SAME content and only the channels that failed.
  const briefing: Briefing = mode === "cron" && existing?.payload
    ? (existing.payload as Briefing)
    : composeBriefing({ ...inputs, timezone: prefs.timezone }, r.who);
  const delivered: Delivered = { ...((existing?.delivered as Delivered) ?? {}) };

  const row = {
    account_owner_id: r.pref.account_owner_id,
    team_member_id: r.pref.team_member_id,
    briefing_date: date,
    role: r.who.role,
    payload: briefing,
    delivered,
  };

  if (!delivered.in_app?.ok && (mode === "self" || prefs.channels.inApp)) delivered.in_app = { ok: true };
  if (existing) {
    await admin.from("daily_briefings").update({ payload: briefing, delivered }).eq("id", existing.id);
  } else {
    const { error } = await admin.from("daily_briefings").insert(row);
    if (error && error.code !== "23505") throw error; // 23505 = a concurrent tick created it; harmless
  }
  if (mode === "self") return { date, delivered };

  const jobs: Promise<void>[] = [];
  if (prefs.channels.push && !delivered.push?.ok) jobs.push(sendPush(admin, r, briefing).then((x) => void (delivered.push = x)));
  if (prefs.channels.email && !delivered.email?.ok) jobs.push(sendMail(r, briefing, company).then((x) => void (delivered.email = x)));
  await Promise.all(jobs);

  const upd = admin.from("daily_briefings").update({ delivered })
    .eq("account_owner_id", r.pref.account_owner_id).eq("briefing_date", date);
  await (r.pref.team_member_id ? upd.eq("team_member_id", r.pref.team_member_id) : upd.is("team_member_id", null));

  const failed = (Object.entries(delivered) as [Channel, { ok: boolean }][]).filter(([, v]) => !v.ok);
  if (failed.length === 0) {
    await admin.from("briefing_preferences").update({ last_sent_on: date }).eq("id", r.pref.id);
  }
  return { date, delivered, failed: failed.map(([k]) => k) };
}

// ---------------------------------------------------------------- orchestration

async function runAccount(admin: Admin, ownerId: string, prefs: PrefRow[], now: number, mode: "cron" | "self") {
  const data = await loadAccount(admin, ownerId, now);
  const cache = new Map<string, BriefingInputs>(); // per timezone
  const out = { sent: 0, retryLater: 0, skipped: 0 };
  for (const pref of prefs) {
    const recipient = resolveRecipient(pref, data);
    if (!recipient) { out.skipped++; continue; }
    const tz = rowToPrefs(pref).timezone;
    if (!cache.has(tz)) cache.set(tz, await buildInputs(admin, ownerId, data, tz, now));
    try {
      const res = await processRecipient(admin, recipient, cache.get(tz)!, data.profile?.company_name ?? null, mode);
      if ("failed" in res && res.failed?.length) out.retryLater++; else out.sent++;
    } catch (err) {
      out.retryLater++;
      console.error(JSON.stringify({ event: "briefing_recipient_failed", ownerId, member: pref.team_member_id, error: String(err) }));
    }
  }
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), secret = Deno.env.get("BRIEFING_CRON_SECRET");
  if (!url || !key || !secret) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = Date.now();

  const provided = req.headers.get("x-briefing-secret");
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  // ---- self: the signed-in user rebuilds their own dashboard card
  if (!provided) {
    if (!bearer) return json({ error: "Unauthorized" }, 401);
    const { data: u, error } = await admin.auth.getUser(bearer);
    if (error || !u?.user) return json({ error: "Unauthorized" }, 401);
    await admin.rpc("ensure_briefing_defaults");
    // The caller's own row: owner row first, otherwise their team-member row.
    let mine: PrefRow | null = ((await admin.from("briefing_preferences").select("*")
      .eq("account_owner_id", u.user.id).is("team_member_id", null).maybeSingle()).data as PrefRow | null);
    if (!mine) {
      const { data: tm } = await admin.from("team_members").select("id").eq("user_id", u.user.id);
      const ids = (tm ?? []).map((t: { id: string }) => t.id);
      if (ids.length > 0) {
        mine = ((await admin.from("briefing_preferences").select("*").in("team_member_id", ids).limit(1).maybeSingle()).data as PrefRow | null);
      }
    }
    if (!mine) return json({ error: "No briefing preferences for this user" }, 404);
    const res = await runAccount(admin, mine.account_owner_id, [mine], now, "self");
    return json({ ok: true, ...res });
  }

  // ---- cron
  if (!timingSafeEqual(provided, secret)) return json({ error: "Unauthorized" }, 401);
  await admin.rpc("ensure_briefing_defaults");

  const { data: all, error } = await admin.from("briefing_preferences").select("*").eq("enabled", true).limit(5000);
  if (error) return json({ error: "Failed to load preferences" }, 500);
  const due = ((all ?? []) as PrefRow[]).filter((p) => isDue(rowToPrefs(p), now));
  const byOwner = new Map<string, PrefRow[]>();
  for (const p of due) byOwner.set(p.account_owner_id, [...(byOwner.get(p.account_owner_id) ?? []), p]);

  const queue = [...byOwner.entries()];
  const totals = { accounts: 0, sent: 0, retryLater: 0, skipped: 0, deferred: 0 };
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (Date.now() - now > TIME_BUDGET_MS) { totals.deferred++; continue; }
      const [ownerId, prefs] = next;
      try {
        const r = await runAccount(admin, ownerId, prefs, now, "cron");
        totals.accounts++; totals.sent += r.sent; totals.retryLater += r.retryLater; totals.skipped += r.skipped;
      } catch (err) {
        totals.retryLater += prefs.length;
        console.error(JSON.stringify({ event: "briefing_account_failed", ownerId, error: String(err) }));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(JSON.stringify({ event: "daily_briefing_run", dueRecipients: due.length, ...totals }));
  return json({ ok: true, dueRecipients: due.length, ...totals });
});
