// supabase/functions/lifecycle-touch-tick/index.ts
//
// Customer lifecycle touches: birthday · home-purchase anniversary · equipment-install anniversary ·
// first-service anniversary. Runs hourly (pg_cron → dispatch_lifecycle_touch_tick(), or any scheduler).
//
// Per account with at least one ACTIVE lifecycle marketing campaign:
//   1. lifecycle_occurrences()  → every anniversary in [today-2d, today+max lead] (single SQL source of truth;
//      already filtered to customers who opted in to that touch, years window, equipment types).
//   2. evaluateDue()            → is it time (lead days, send hour in the BUSINESS time zone, 2-day grace)?
//   3. planChannelActions()     → per channel: consent → contact → preference center → STOP/DNC → dedupe/retry.
//   4. claim a ledger row       → unique per occurrence × channel, so overlapping ticks can never double-send.
//   5. quiet-hours gate → send (existing senders) → update ledger → mirror into marketing_campaign_* tables.
//
// Reused, not rebuilt: marketing_campaigns/steps (templates + on/off switch), sendEmail, sendCompliantSms
// (A2P + STOP gates), gateOutbound (quiet hours), preferenceCheck (customer preference center).
//
// Auth:    header `x-lifecycle-secret` must equal LIFECYCLE_CRON_SECRET (deploy with --no-verify-jwt).
// Secrets: LIFECYCLE_CRON_SECRET (required) · SITE_URL (required for the unsubscribe link) ·
//          LIFECYCLE_OFFER_SECRET (optional; falls back to the service-role key) · RESEND_*/TWILIO_* as usual.
// Body:    { "dry_run": true, "user_id": "<uuid>" }  — both optional. dry_run sends/writes nothing and returns the plan.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { gateOutbound } from "../_shared/messaging/quietHours.ts";
import { getPreferences, mayContact } from "../_shared/compliance/preferenceCheck.ts";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";
import {
  LATE_GRACE_DAYS,
  MAX_ATTEMPTS,
  addDays,
  buildEmailHtml,
  buildEmailText,
  buildSmsBody,
  buildTemplateVars,
  evaluateDue,
  formatLongDate,
  formatOffer,
  isTouchType,
  offerCodeFromDigest,
  offerExpiry,
  occurrenceKey,
  planChannelActions,
  renderTemplate,
  safeTimeZone,
  zonedNow,
  type ChannelPlan,
  type ExistingLog,
  type LogStatus,
  type OfferSettings,
  type Occurrence,
  type StepLike,
  type TouchType,
} from "../_shared/lifecycle/lifecycleCore.ts";

const SOURCE = "lifecycle-touch-tick";
const MAX_OCCURRENCES_PER_ACCOUNT = 300; // per tick; the remainder is picked up by the next hourly run
const RUNTIME_BUDGET_MS = 100_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-lifecycle-secret, apikey, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event: `lifecycle_${event}`, ...data })); // never log contact details
}

interface TouchSettingsRow extends OfferSettings {
  id: string;
  user_id: string;
  touch_type: string;
  campaign_id: string | null;
  lead_days: number;
  send_hour: number;
}

interface ActiveTouch {
  settings: TouchSettingsRow;
  campaignId: string;
  steps: StepLike[];
}

interface LogRow extends ExistingLog {
  id: string;
  offer_code: string | null;
  offer_expires_at: string | null;
}

interface Counters {
  considered: number;
  sent: number;
  deferred: number;
  failed: number;
  skipped: number;
}

interface Ctx {
  admin: SupabaseClient;
  userId: string;
  companyName: string;
  timeZone: string;
  now: Date;
  today: string;
  offerSecret: string;
  dryRun: boolean;
  counters: Counters;
  preview: Record<string, unknown>[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("LIFECYCLE_CRON_SECRET");
  if (!url || !serviceKey || !secret) return json({ error: "Server not configured" }, 500);

  const provided = req.headers.get("x-lifecycle-secret") ?? "";
  if (!provided || !timingSafeEqual(provided, secret)) return json({ error: "Unauthorized" }, 401);

  let body: { dry_run?: boolean; user_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dry_run === true;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const offerSecret = Deno.env.get("LIFECYCLE_OFFER_SECRET") || serviceKey;
  const deadline = Date.now() + RUNTIME_BUDGET_MS;
  const totals: Counters = { considered: 0, sent: 0, deferred: 0, failed: 0, skipped: 0 };
  const preview: Record<string, unknown>[] = [];

  try {
    let q = admin.from("marketing_campaigns").select("user_id").eq("campaign_type", "lifecycle").eq("status", "active").like("trigger_event", "lifecycle_%").limit(5000);
    if (body.user_id) q = q.eq("user_id", body.user_id);
    const { data: camps, error } = await q;
    if (error) throw error;
    const userIds = [...new Set((camps ?? []).map((c: { user_id: string }) => c.user_id))];

    let accounts = 0;
    for (const userId of userIds) {
      if (Date.now() > deadline) {
        log("time_budget_reached", { accounts });
        break;
      }
      try {
        await processAccount({ admin, userId, offerSecret, dryRun, totals, preview, deadline });
        accounts += 1;
      } catch (e) {
        log("account_failed", { user_id: userId, error: String(e) }); // one tenant's failure never blocks the others
      }
    }
    return json({ ok: true, dry_run: dryRun, accounts, ...totals, ...(dryRun ? { preview } : {}) });
  } catch (e) {
    log("tick_failed", { error: String(e) });
    return json({ ok: false, error: "Tick failed" }, 500);
  }
});

async function processAccount(a: {
  admin: SupabaseClient;
  userId: string;
  offerSecret: string;
  dryRun: boolean;
  totals: Counters;
  preview: Record<string, unknown>[];
  deadline: number;
}) {
  const { admin, userId } = a;

  const [{ data: profile }, { data: biz }, { data: settingsRows }] = await Promise.all([
    admin.from("profiles").select("company_name").eq("id", userId).maybeSingle(),
    admin.from("business_profile").select("timezone").eq("user_id", userId).maybeSingle(),
    admin.from("lifecycle_touch_settings").select("*").eq("user_id", userId),
  ]);
  const timeZone = safeTimeZone(biz?.timezone);
  const now = new Date();
  const zoned = zonedNow(now, timeZone);

  // Active touches = settings row whose OWN campaign is active, lifecycle-type, and belongs to this account.
  const campaignIds = (settingsRows ?? []).map((s: TouchSettingsRow) => s.campaign_id).filter(Boolean) as string[];
  if (campaignIds.length === 0) return;
  const [{ data: campaigns }, { data: steps }] = await Promise.all([
    admin.from("marketing_campaigns").select("id").in("id", campaignIds).eq("user_id", userId).eq("campaign_type", "lifecycle").eq("status", "active"),
    admin.from("marketing_campaign_steps").select("id, campaign_id, step_order, channel, subject, body").in("campaign_id", campaignIds).order("step_order", { ascending: true }),
  ]);
  const activeCampaigns = new Set((campaigns ?? []).map((c: { id: string }) => c.id));

  const touches = new Map<TouchType, ActiveTouch>();
  for (const s of (settingsRows ?? []) as TouchSettingsRow[]) {
    if (!isTouchType(s.touch_type) || !s.campaign_id || !activeCampaigns.has(s.campaign_id)) continue;
    const campaignSteps = (steps ?? []).filter((st: StepLike & { campaign_id: string }) => st.campaign_id === s.campaign_id) as StepLike[];
    if (campaignSteps.length === 0) continue;
    touches.set(s.touch_type, { settings: s, campaignId: s.campaign_id, steps: campaignSteps });
  }
  if (touches.size === 0) return;

  const maxLead = Math.max(...[...touches.values()].map((t) => t.settings.lead_days));
  const from = addDays(zoned.date, -LATE_GRACE_DAYS);
  const to = addDays(zoned.date, maxLead);

  const { data: occRows, error: occError } = await admin.rpc("lifecycle_occurrences", { p_user_id: userId, p_from: from, p_to: to });
  if (occError) throw occError;

  const due: { occ: Occurrence; touch: ActiveTouch }[] = [];
  for (const o of (occRows ?? []) as Occurrence[]) {
    const touch = touches.get(o.touch_type);
    if (!touch || !o.opted_in) continue;
    if (evaluateDue(o.occurrence_date, touch.settings, zoned).due) due.push({ occ: o, touch });
  }
  if (due.length === 0) return;

  // One query for every existing ledger row in the window (instead of one per occurrence).
  const { data: logRows, error: logError } = await admin.from("lifecycle_touch_log").select("*").eq("user_id", userId).gte("occurrence_date", from).lte("occurrence_date", to);
  if (logError) throw logError;
  const logsByKey = new Map<string, LogRow[]>();
  for (const r of (logRows ?? []) as (LogRow & { touch_type: string; customer_id: string; equipment_id: string | null; occurrence_year: number })[]) {
    const k = occurrenceKey(userId, { touch_type: r.touch_type as TouchType, customer_id: r.customer_id, equipment_id: r.equipment_id, occurrence_year: r.occurrence_year });
    logsByKey.set(k, [...(logsByKey.get(k) ?? []), r]);
  }

  const ctx: Ctx = {
    admin,
    userId,
    companyName: (profile?.company_name ?? "").trim(),
    timeZone,
    now,
    today: zoned.date,
    offerSecret: a.offerSecret,
    dryRun: a.dryRun,
    counters: a.totals,
    preview: a.preview,
  };

  for (const { occ, touch } of due.slice(0, MAX_OCCURRENCES_PER_ACCOUNT)) {
    if (Date.now() > a.deadline) break;
    const existing = logsByKey.get(occurrenceKey(userId, occ)) ?? [];
    try {
      await processOccurrence(ctx, occ, touch, existing);
    } catch (e) {
      log("occurrence_failed", { user_id: userId, touch: occ.touch_type, error: String(e) });
    }
  }
}

async function processOccurrence(ctx: Ctx, occ: Occurrence, touch: ActiveTouch, existing: LogRow[]) {
  const { admin, userId } = ctx;

  // Cheap exit: nothing left to do for any channel (already sent / retries exhausted).
  const settled = (ch: string) => existing.some((e) => e.channel === ch && (e.status === "sent" || (e.status === "failed" && e.attempts >= MAX_ATTEMPTS)));
  if (touch.steps.every((s) => settled(s.channel))) return;

  const { data: customer } = await admin.from("customers").select("id, name, email, phone").eq("id", occ.customer_id).eq("user_id", userId).is("deleted_at", null).maybeSingle();
  if (!customer) return;

  const prefs = await getPreferences(admin, customer.id);
  if (prefs === "error") {
    log("preferences_unavailable", { user_id: userId });
    return; // fail closed: try again next tick, write nothing
  }
  const smsSuppressed = customer.phone ? await isDncSuppressed(admin, userId, customer.phone) : false;

  const plans = planChannelActions({
    steps: touch.steps,
    consent: { email: occ.email_consent, sms: occ.sms_consent },
    contact: { email: customer.email, phone: customer.phone },
    prefsAllowed: { email: mayContact(prefs, "marketing", "email").ok, sms: mayContact(prefs, "marketing", "sms").ok },
    smsSuppressed,
    existing,
    nowMs: ctx.now.getTime(),
  });
  if (plans.every((p) => p.action === "noop")) return;
  ctx.counters.considered += 1;

  if (ctx.dryRun) {
    ctx.preview.push({ touch: occ.touch_type, customer_id: occ.customer_id, date: occ.occurrence_date, plans: plans.map((p) => ({ channel: p.channel, action: p.action, reason: p.reason ?? null })) });
    return;
  }

  // Offer (deterministic code: both channels of one occurrence share it; a retry keeps its original expiry).
  const offerLabel = formatOffer(touch.settings);
  let offer: { label: string; code: string; expiresIso: string; display: string } | null = null;
  if (offerLabel) {
    const code = offerCodeFromDigest(await hmacHex(ctx.offerSecret, occurrenceKey(userId, occ)));
    const prior = existing.find((e) => e.offer_code === code && e.offer_expires_at);
    const expiresIso = prior?.offer_expires_at ?? offerExpiry(ctx.now.getTime(), touch.settings.offer_valid_days);
    offer = { label: offerLabel, code, expiresIso, display: formatLongDate(zonedNow(new Date(expiresIso), ctx.timeZone).date) };
  }

  const vars = buildTemplateVars({
    occ,
    companyName: ctx.companyName,
    offer: offer ? { label: offer.label, code: offer.code, expires: offer.display } : null,
  });

  for (const plan of plans) {
    if (plan.action === "noop") continue;
    if (plan.action === "record_skip") {
      await recordSkip(ctx, occ, touch, plan);
      continue;
    }

    const rowId = await claim(ctx, occ, touch, plan, offer, touch.settings.offer_terms);
    if (!rowId) continue; // lost the race to another run — that run owns the send

    const result = await deliver(ctx, occ, touch, plan, customer, vars, offer ? touch.settings.offer_terms : null);
    await finish(ctx, rowId, result, plan);
    await mirrorToMarketing(ctx, occ, touch, plan, customer, result);
    if (result.status === "sent") ctx.counters.sent += 1;
    else if (result.status === "deferred") ctx.counters.deferred += 1;
    else if (result.status === "skipped") ctx.counters.skipped += 1;
    else ctx.counters.failed += 1;
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

async function claim(
  ctx: Ctx,
  occ: Occurrence,
  touch: ActiveTouch,
  plan: ChannelPlan,
  offer: { label: string; code: string; expiresIso: string } | null,
  terms: string | null,
): Promise<string | null> {
  const { admin, userId } = ctx;
  const nowIso = ctx.now.toISOString();
  const prev = plan.reclaim as LogRow | undefined;

  if (prev) {
    // Compare-and-set on the status we planned from: only one concurrent run can win.
    const attempts = prev.status === "deferred" ? prev.attempts : prev.attempts + 1;
    const { data, error } = await admin
      .from("lifecycle_touch_log")
      .update({ status: "claimed", claimed_at: nowIso, attempts, skip_reason: null, error: null })
      .eq("id", prev.id)
      .eq("status", prev.status)
      .select("id");
    if (error) throw error;
    return data?.[0]?.id ?? null;
  }

  const { data, error } = await admin
    .from("lifecycle_touch_log")
    .insert({
      user_id: userId,
      touch_type: occ.touch_type,
      customer_id: occ.customer_id,
      equipment_id: occ.equipment_id,
      occurrence_year: occ.occurrence_year,
      occurrence_date: occ.occurrence_date,
      years_count: occ.years_count,
      channel: plan.channel,
      status: "claimed",
      attempts: 1,
      campaign_id: touch.campaignId,
      claimed_at: nowIso,
      offer_code: offer?.code ?? null,
      offer_label: offer?.label ?? null,
      offer_terms: offer ? terms : null,
      offer_expires_at: offer?.expiresIso ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null; // unique violation = already claimed elsewhere
    throw error;
  }
  return data.id;
}

async function recordSkip(ctx: Ctx, occ: Occurrence, touch: ActiveTouch, plan: ChannelPlan) {
  const { admin, userId } = ctx;
  const prev = plan.reclaim as LogRow | undefined;
  if (prev) {
    await admin.from("lifecycle_touch_log").update({ status: "skipped", skip_reason: plan.reason ?? null }).eq("id", prev.id).eq("status", prev.status);
  } else {
    await admin.from("lifecycle_touch_log").insert({
      user_id: userId,
      touch_type: occ.touch_type,
      customer_id: occ.customer_id,
      equipment_id: occ.equipment_id,
      occurrence_year: occ.occurrence_year,
      occurrence_date: occ.occurrence_date,
      years_count: occ.years_count,
      channel: plan.channel,
      status: "skipped",
      skip_reason: plan.reason ?? null,
      campaign_id: touch.campaignId,
    }); // a 23505 here just means a parallel run wrote the same skip
  }
  ctx.counters.skipped += 1;
}

interface DeliveryResult {
  status: Extract<LogStatus, "sent" | "failed" | "skipped" | "deferred">;
  providerRef?: string;
  error?: string;
  reason?: string;
}

async function finish(ctx: Ctx, rowId: string, r: DeliveryResult, _plan: ChannelPlan) {
  await ctx.admin
    .from("lifecycle_touch_log")
    .update({
      status: r.status,
      provider_ref: r.providerRef ?? null,
      error: r.error ? r.error.slice(0, 500) : null,
      skip_reason: r.reason ?? null,
      sent_at: r.status === "sent" ? new Date().toISOString() : null,
    })
    .eq("id", rowId);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function deliver(
  ctx: Ctx,
  occ: Occurrence,
  _touch: ActiveTouch,
  plan: ChannelPlan,
  customer: { id: string; name: string; email: string | null; phone: string | null },
  vars: ReturnType<typeof buildTemplateVars>,
  offerTerms: string | null,
): Promise<DeliveryResult> {
  const { admin, userId } = ctx;
  const rendered = renderTemplate(plan.step.body, vars);
  if (!rendered) return { status: "failed", error: "Template rendered empty" };

  const to = plan.channel === "email" ? (customer.email ?? "").trim() : (customer.phone ?? "").trim();
  const gate = await gateOutbound(admin, userId, { channel: plan.channel, to, purpose: "marketing", customerId: customer.id, source: SOURCE });
  if (!gate.proceed) return { status: "deferred", reason: "quiet_hours" };

  if (plan.channel === "email") {
    const subject = renderTemplate(plan.step.subject ?? "", vars);
    if (!subject) return { status: "failed", error: "Subject rendered empty" };
    const link = await preferenceUrl(admin, userId, customer.id);
    if (!link) return { status: "failed", error: "Unsubscribe link unavailable (set SITE_URL and check customer_communication_preferences)" };
    const companyName = ctx.companyName || "our team";
    const text = offerTerms && vars.offer ? `${rendered}\n\nOffer terms: ${offerTerms}` : rendered;
    const res = await sendEmail(to, subject, buildEmailHtml(text, { companyName, preferenceUrl: link }), buildEmailText(text, { companyName, preferenceUrl: link }));
    return res.ok ? { status: "sent" } : { status: "failed", error: res.error ?? "Email send failed" };
  }

  const res = await sendCompliantSms(admin, userId, to, buildSmsBody(rendered), {
    purpose: "marketing",
    customerId: customer.id,
    skipQuietHours: true, // the gate above already ran
    source: SOURCE,
  });
  if (res.ok) return { status: "sent", providerRef: res.sid };
  if (res.reason === "OPTED_OUT") return { status: "skipped", reason: "do_not_contact" };
  if (res.reason === "QUIET_HOURS") return { status: "deferred", reason: "quiet_hours" };
  return { status: "failed", error: `${res.reason}${res.detail ? `: ${res.detail}` : ""}` };
}

async function preferenceUrl(admin: SupabaseClient, userId: string, customerId: string): Promise<string | null> {
  const site = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
  if (!site) return null;
  const read = async () => (await admin.from("customer_communication_preferences").select("token").eq("customer_id", customerId).maybeSingle()).data?.token as string | undefined;
  let token = await read();
  if (!token) {
    const { error } = await admin.from("customer_communication_preferences").insert({ user_id: userId, customer_id: customerId });
    if (error && (error as { code?: string }).code !== "23505") return null;
    token = await read();
  }
  return token ? `${site}/preferences/${token}` : null;
}

// ---------------------------------------------------------------------------
// Mirror into the existing marketing tables (best effort — the lifecycle ledger is the source of truth)
// ---------------------------------------------------------------------------

async function mirrorToMarketing(
  ctx: Ctx,
  _occ: Occurrence,
  touch: ActiveTouch,
  plan: ChannelPlan,
  customer: { id: string; email: string | null; phone: string | null },
  r: DeliveryResult,
) {
  if (r.status !== "sent" && r.status !== "failed") return;
  const { admin, userId } = ctx;
  try {
    // One enrollment per campaign × customer (existing unique index), re-used every year. Status 'completed'
    // keeps marketing-campaign-dispatcher (which only reads 'active') away from it.
    const findEnrollment = async () =>
      (await admin.from("marketing_campaign_enrollments").select("id").eq("campaign_id", touch.campaignId).eq("customer_id", customer.id).maybeSingle()).data?.id as string | undefined;
    let enrollmentId = await findEnrollment();
    const fields = { status: "completed", current_step: plan.step.step_order, next_send_at: null, contact_email: customer.email, contact_phone: customer.phone };
    if (enrollmentId) {
      await admin.from("marketing_campaign_enrollments").update(fields).eq("id", enrollmentId);
    } else {
      const { error } = await admin.from("marketing_campaign_enrollments").insert({ campaign_id: touch.campaignId, user_id: userId, customer_id: customer.id, ...fields });
      if (error && (error as { code?: string }).code !== "23505") throw error;
      enrollmentId = await findEnrollment();
    }
    if (!enrollmentId) return;
    await admin.from("marketing_campaign_sends").insert({
      enrollment_id: enrollmentId,
      step_id: plan.step.id,
      user_id: userId,
      channel: plan.channel,
      status: r.status === "sent" ? "sent" : "failed",
      provider_ref: r.providerRef ?? null,
      error: r.status === "failed" ? (r.error ?? "unknown").slice(0, 500) : null,
    });
  } catch (e) {
    log("mirror_failed", { user_id: userId, error: String(e) });
  }
}
