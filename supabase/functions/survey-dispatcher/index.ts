// supabase/functions/survey-dispatcher/index.ts
//
// Post-job NPS/CSAT survey dispatcher.
//
// Two entry points:
//   1. CRON (header X-Cron-Secret == CRON_SECRET):  enqueue + deliver.
//        - ENQUEUE: for every active auto-send template, find jobs completed
//          after the moment auto-send was switched on (never the historical
//          backlog), older than the template's delay, and not yet surveyed
//          for that template; skip customers surveyed within the cooldown;
//          write a survey_invitations row (idempotent via the unique index).
//        - DELIVER: claim due invitations, send SMS through sendCompliantSms()
//          (A2P 10DLC + opt-out gates, same as every other SMS path) and/or
//          email via Resend, honour the template's quiet hours for SMS, retry
//          transient failures up to MAX_ATTEMPTS.
//   2. USER (Authorization: Bearer <JWT>, body {action:"send_now", templateId, jobId}):
//        a manager sends one survey immediately. Authorisation is enforced by
//        reading the template/job through the CALLER's RLS-scoped client.
//
// DEPLOYMENT: supabase functions deploy survey-dispatcher --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto),
//      CRON_SECRET (required for cron), SITE_URL, Twilio + Resend secrets (already set).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { getPreferences, getPreferencesBatch, mayContact } from "../_shared/compliance/preferenceCheck.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const LOOKBACK_HOURS = 72;        // never survey a job completed longer ago than this
const ENQUEUE_JOBS_PER_TEMPLATE = 200;
const DELIVER_BATCH = 100;
const MAX_ATTEMPTS = 3;
const STUCK_SENDING_MINUTES = 15;
const SMS_WINDOW_START_HOUR = 8;  // local business time, inclusive
const SMS_WINDOW_END_HOUR = 20;   // exclusive

type Admin = SupabaseClient;

interface Template {
  id: string; user_id: string; name: string; survey_type: "nps" | "csat"; question: string;
  follow_up_question: string | null; thank_you_message: string; channel: "sms" | "email" | "both";
  sms_body: string; email_subject: string; send_delay_minutes: number; cooldown_days: number;
  timezone: string; low_score_threshold: number; auto_send_enabled_at: string | null;
}

interface Invitation {
  id: string; user_id: string; job_id: string | null; customer_id: string | null; channel: "sms" | "email" | "both";
  sms_body: string; email_subject: string; question: string; timezone: string;
  customer_name: string; customer_phone: string | null; customer_email: string | null;
  token: string; attempts: number;
}

const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

function firstName(full: string | null | undefined): string {
  const n = (full ?? "").trim().split(/\s+/)[0];
  return n || "there";
}

function render(tpl: string, vars: { customer_first_name: string; business_name: string; link: string }): string {
  return tpl.replace(/\{\{\s*(customer_first_name|business_name|link)\s*\}\}/g, (_m, k: keyof typeof vars) => vars[k]);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Local hour (0-23) in an IANA timezone; falls back to UTC on a bad zone name. */
function localHour(tz: string, at = new Date()): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(at);
    return Number(h);
  } catch {
    return at.getUTCHours();
  }
}

function inSmsWindow(tz: string): boolean {
  const h = localHour(tz);
  return h >= SMS_WINDOW_START_HOUR && h < SMS_WINDOW_END_HOUR;
}

const digits = (p: string | null) => (p ? p.replace(/\D/g, "").slice(-10) : "");

// ---------------------------------------------------------------------------
// ENQUEUE
// ---------------------------------------------------------------------------
async function enqueueAuto(admin: Admin): Promise<{ queued: number; skipped: number }> {
  const { data: templates, error } = await admin
    .from("survey_templates")
    .select("*")
    .eq("auto_send", true)
    .eq("is_active", true);
  if (error) throw error;

  let queued = 0;
  let skipped = 0;
  const now = Date.now();

  for (const t of (templates ?? []) as Template[]) {
    const lookbackFloor = now - LOOKBACK_HOURS * 3600_000;
    const enabledAt = t.auto_send_enabled_at ? Date.parse(t.auto_send_enabled_at) : now;
    const from = new Date(Math.max(lookbackFloor, enabledAt)).toISOString();
    const dueBefore = new Date(now - t.send_delay_minutes * 60_000).toISOString();

    const { data: jobs } = await admin
      .from("jobs")
      .select("id, customer_id, customer_name, customer_phone, service_type, assigned_technician_id, completed_at")
      .eq("user_id", t.user_id)
      .eq("job_status", "completed")
      .gte("completed_at", from)
      .lte("completed_at", dueBefore)
      .order("completed_at", { ascending: true })
      .limit(ENQUEUE_JOBS_PER_TEMPLATE);
    if (!jobs?.length) continue;

    const jobIds = jobs.map((j) => j.id);
    const { data: existing } = await admin
      .from("survey_invitations")
      .select("job_id")
      .eq("template_id", t.id)
      .in("job_id", jobIds);
    const alreadySurveyed = new Set((existing ?? []).map((r) => r.job_id as string));
    const fresh = jobs.filter((j) => !alreadySurveyed.has(j.id));
    if (!fresh.length) continue;

    // Customer emails/phones (jobs only carry a phone).
    const customerIds = [...new Set(fresh.map((j) => j.customer_id).filter(Boolean))] as string[];
    const customers = new Map<string, { email: string | null; phone: string | null }>();
    if (customerIds.length) {
      const { data: cs } = await admin.from("customers").select("id, email, phone").in("id", customerIds);
      for (const c of cs ?? []) customers.set(c.id, { email: c.email, phone: c.phone });
    }

    // Honour the customer's preference center (opted out of surveys / channel / unsubscribed from all).
    const prefMap = await getPreferencesBatch(admin, customerIds);
    if (prefMap === "error") {
      console.error("[survey-dispatcher] could not read preferences; skipping template", t.id);
      continue; // fail closed: never survey someone whose opt-out we couldn't verify
    }

    // Cooldown: anyone surveyed (any template of this type) within cooldown_days is skipped.
    const recentKeys = new Set<string>();
    if (t.cooldown_days > 0) {
      const since = new Date(now - t.cooldown_days * 86_400_000).toISOString();
      const { data: recent } = await admin
        .from("survey_invitations")
        .select("customer_id, customer_phone, customer_email")
        .eq("user_id", t.user_id)
        .eq("survey_type", t.survey_type)
        .in("status", ["pending", "sending", "sent", "responded"])
        .gte("created_at", since);
      for (const r of recent ?? []) {
        if (r.customer_id) recentKeys.add(`id:${r.customer_id}`);
        if (r.customer_phone) recentKeys.add(`ph:${digits(r.customer_phone)}`);
        if (r.customer_email) recentKeys.add(`em:${String(r.customer_email).toLowerCase()}`);
      }
    }

    const rows: Record<string, unknown>[] = [];
    for (const j of fresh) {
      const c = j.customer_id ? customers.get(j.customer_id) : undefined;
      const rawPhone = j.customer_phone || c?.phone || null;
      const rawEmail = c?.email || null;
      const pref = j.customer_id ? prefMap.get(j.customer_id) : undefined;
      const phone = rawPhone && (!pref || mayContact(pref, "surveys", "sms").ok) ? rawPhone : null;
      const email = rawEmail && (!pref || mayContact(pref, "surveys", "email").ok) ? rawEmail : null;
      const optedOut = (!!rawPhone || !!rawEmail) && !phone && !email && !!pref;
      const keys = [
        j.customer_id ? `id:${j.customer_id}` : null,
        phone ? `ph:${digits(phone)}` : null,
        email ? `em:${email.toLowerCase()}` : null,
      ].filter(Boolean) as string[];

      const hasContact = t.channel === "sms" ? !!phone : t.channel === "email" ? !!email : !!(phone || email);
      let status: "pending" | "skipped" = "pending";
      let note: string | null = null;
      if (!hasContact && optedOut) {
        status = "skipped";
        note = "Customer opted out of survey messages in their preference center.";
      } else if (!hasContact) {
        status = "skipped";
        note = `No ${t.channel === "both" ? "phone or email" : t.channel === "sms" ? "phone number" : "email address"} on file.`;
      } else if (keys.some((k) => recentKeys.has(k))) {
        status = "skipped";
        note = `Customer was surveyed within the last ${t.cooldown_days} days.`;
      }
      keys.forEach((k) => recentKeys.add(k)); // dedupe within this batch too

      rows.push({
        user_id: t.user_id, template_id: t.id, job_id: j.id, customer_id: j.customer_id,
        technician_id: j.assigned_technician_id,
        template_name: t.name, survey_type: t.survey_type, question: t.question,
        follow_up_question: t.follow_up_question, thank_you_message: t.thank_you_message,
        low_score_threshold: t.low_score_threshold, channel: t.channel, sms_body: t.sms_body,
        email_subject: t.email_subject, timezone: t.timezone,
        customer_name: j.customer_name || "Customer", customer_phone: phone, customer_email: email,
        service_type: j.service_type, trigger_source: "auto", status, delivery_error: note,
        send_at: new Date().toISOString(),
      });
    }

    if (rows.length) {
      // ignoreDuplicates => a concurrent run (or manual send) that won the race is left untouched.
      const { error: insErr } = await admin
        .from("survey_invitations")
        .upsert(rows, { onConflict: "template_id,job_id", ignoreDuplicates: true });
      if (insErr) {
        console.error("[survey-dispatcher] enqueue failed", t.id, insErr.message);
        continue;
      }
      queued += rows.filter((r) => r.status === "pending").length;
      skipped += rows.filter((r) => r.status === "skipped").length;
    }
  }
  return { queued, skipped };
}

// ---------------------------------------------------------------------------
// DELIVER
// ---------------------------------------------------------------------------
interface DeliveryOutcome {
  status: "sent" | "pending" | "failed" | "skipped" | "deferred";
  channel?: string;
  error?: string;
  retryInMinutes?: number;
}

async function deliver(admin: Admin, inv: Invitation, businessName: string): Promise<DeliveryOutcome> {
  const link = `${siteUrl()}/s/${inv.token}`;
  const vars = { customer_first_name: firstName(inv.customer_name), business_name: businessName, link };

  // Re-check at send time: the customer may have opted out since the survey was queued.
  const prefs = await getPreferences(admin, inv.customer_id);
  if (prefs === "error") {
    return inv.attempts < MAX_ATTEMPTS
      ? { status: "pending", error: "Preferences could not be verified.", retryInMinutes: 15 * inv.attempts }
      : { status: "failed", error: "Preferences could not be verified." };
  }
  const wantSms = (inv.channel === "sms" || inv.channel === "both") && !!inv.customer_phone && mayContact(prefs, "surveys", "sms").ok;
  const wantEmail = (inv.channel === "email" || inv.channel === "both") && !!inv.customer_email && mayContact(prefs, "surveys", "email").ok;
  if (!wantSms && !wantEmail) return { status: "skipped", error: "No usable contact method, or the customer opted out." };

  // Quiet hours apply to SMS. If SMS is the only usable channel, wait for the window; otherwise email goes now.
  const smsAllowedNow = wantSms && inSmsWindow(inv.timezone);
  if (wantSms && !smsAllowedNow && !wantEmail) return { status: "deferred" };

  const used: string[] = [];
  const errors: string[] = [];
  let transient = false;
  let optedOut = false;

  if (smsAllowedNow) {
    const r = await sendCompliantSms(admin, inv.user_id, inv.customer_phone!, render(inv.sms_body, vars));
    if (r.ok) used.push("sms");
    else {
      if (r.reason === "OPTED_OUT") optedOut = true;
      if (r.reason === "TWILIO_ERROR") transient = true;
      errors.push(`SMS: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
    }
  }

  if (wantEmail) {
    const subject = render(inv.email_subject, vars);
    const q = escapeHtml(inv.question);
    const href = escapeHtml(link);
    const html =
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">` +
      `<p style="font-size:16px">Hi ${escapeHtml(vars.customer_first_name)},</p>` +
      `<p style="font-size:16px">Thanks for choosing ${escapeHtml(businessName)}. ${q}</p>` +
      `<p style="margin:28px 0"><a href="${href}" style="background:#2563eb;color:#fff;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:600;display:inline-block">Share your feedback</a></p>` +
      `<p style="font-size:13px;color:#666">It takes about 10 seconds. If the button doesn't work, open this link: ${href}</p></div>`;
    const text = `Hi ${vars.customer_first_name},\n\nThanks for choosing ${businessName}. ${inv.question}\n\nShare your feedback (10 seconds): ${link}`;
    const r = await sendEmail(inv.customer_email!, subject, html, text);
    if (r.ok) used.push("email");
    else {
      transient = true;
      errors.push(`Email: ${(r.error ?? "provider error").slice(0, 200)}`);
    }
  }

  if (used.length) return { status: "sent", channel: used.join("+") };
  if (optedOut && !transient && !wantEmail) return { status: "skipped", error: errors.join(" | ") };
  if (transient && inv.attempts < MAX_ATTEMPTS) {
    return { status: "pending", error: errors.join(" | "), retryInMinutes: 15 * inv.attempts };
  }
  return { status: "failed", error: errors.join(" | ") || "Delivery failed." };
}

async function deliverDue(admin: Admin): Promise<{ sent: number; failed: number; deferred: number; retried: number; skipped: number }> {
  const result = { sent: 0, failed: 0, deferred: 0, retried: 0, skipped: 0 };

  // Crash recovery: anything stuck in 'sending' goes back to the queue.
  await admin
    .from("survey_invitations")
    .update({ status: "pending", claimed_at: null })
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - STUCK_SENDING_MINUTES * 60_000).toISOString());

  const { data: due } = await admin
    .from("survey_invitations")
    .select("id")
    .eq("status", "pending")
    .lte("send_at", new Date().toISOString())
    .order("send_at", { ascending: true })
    .limit(DELIVER_BATCH);

  const businessNames = new Map<string, string>();

  for (const { id } of due ?? []) {
    // Atomic claim: only one worker can flip pending -> sending.
    const { data: peek } = await admin.from("survey_invitations").select("attempts").eq("id", id).maybeSingle();
    const { data: claimed } = await admin
      .from("survey_invitations")
      .update({ status: "sending", claimed_at: new Date().toISOString(), attempts: (peek?.attempts ?? 0) + 1 })
      .eq("id", id)
      .eq("status", "pending")
      .select("id,user_id,job_id,customer_id,channel,sms_body,email_subject,question,timezone,customer_name,customer_phone,customer_email,token,attempts")
      .maybeSingle();
    if (!claimed) continue;
    const inv = claimed as Invitation;

    let businessName = businessNames.get(inv.user_id);
    if (!businessName) {
      const { data: p } = await admin.from("profiles").select("company_name").eq("id", inv.user_id).maybeSingle();
      businessName = p?.company_name?.trim() || "us";
      businessNames.set(inv.user_id, businessName);
    }

    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver(admin, inv, businessName);
    } catch (e) {
      outcome = inv.attempts < MAX_ATTEMPTS
        ? { status: "pending", error: String((e as Error).message).slice(0, 300), retryInMinutes: 15 * inv.attempts }
        : { status: "failed", error: String((e as Error).message).slice(0, 300) };
    }

    const base = { claimed_at: null as string | null };
    if (outcome.status === "sent") {
      await admin.from("survey_invitations").update({
        ...base, status: "sent", sent_at: new Date().toISOString(), channel_used: outcome.channel, delivery_error: null,
      }).eq("id", inv.id);
      result.sent++;
    } else if (outcome.status === "deferred") {
      // Outside SMS hours: put it back without burning an attempt, check again in 30 min.
      await admin.from("survey_invitations").update({
        ...base, status: "pending", attempts: Math.max(0, inv.attempts - 1),
        send_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }).eq("id", inv.id);
      result.deferred++;
    } else if (outcome.status === "pending") {
      await admin.from("survey_invitations").update({
        ...base, status: "pending", delivery_error: outcome.error ?? null,
        send_at: new Date(Date.now() + (outcome.retryInMinutes ?? 15) * 60_000).toISOString(),
      }).eq("id", inv.id);
      result.retried++;
    } else if (outcome.status === "skipped") {
      await admin.from("survey_invitations").update({ ...base, status: "skipped", delivery_error: outcome.error ?? null }).eq("id", inv.id);
      result.skipped++;
    } else {
      await admin.from("survey_invitations").update({ ...base, status: "failed", delivery_error: outcome.error ?? "Delivery failed." }).eq("id", inv.id);
      result.failed++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// MANUAL "send now"
// ---------------------------------------------------------------------------
async function sendNow(admin: Admin, accessToken: string, templateId: string, jobId: string): Promise<Response> {
  const userClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });

  // RLS does the authorisation: only a manager of the owning account can read the template.
  const { data: template } = await userClient.from("survey_templates").select("*").eq("id", templateId).maybeSingle();
  if (!template) return json({ error: "NOT_FOUND", detail: "Survey not found, or you don't have permission to send it." }, 404);
  const t = template as Template;

  const { data: job } = await userClient
    .from("jobs")
    .select("id, user_id, customer_id, customer_name, customer_phone, service_type, assigned_technician_id, job_status")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.user_id !== t.user_id) return json({ error: "NOT_FOUND", detail: "Job not found." }, 404);
  if (job.job_status !== "completed") return json({ error: "JOB_NOT_COMPLETED", detail: "Surveys can only be sent for completed jobs." }, 422);

  let email: string | null = null;
  let phone: string | null = job.customer_phone;
  if (job.customer_id) {
    const { data: c } = await admin.from("customers").select("email, phone").eq("id", job.customer_id).eq("user_id", t.user_id).maybeSingle();
    email = c?.email ?? null;
    phone = phone || c?.phone || null;
  }
  const hasContact = t.channel === "sms" ? !!phone : t.channel === "email" ? !!email : !!(phone || email);
  if (!hasContact) return json({ error: "NO_CONTACT", detail: "This customer has no phone/email for the selected channel." }, 422);

  const { data: existing } = await admin
    .from("survey_invitations").select("id,status").eq("template_id", t.id).eq("job_id", job.id).maybeSingle();
  if (existing && ["sent", "responded", "sending", "pending"].includes(existing.status)) {
    return json({ error: "ALREADY_SENT", detail: existing.status === "responded" ? "This customer already answered this survey." : "This survey was already sent (or is queued) for this job." }, 409);
  }

  const row = {
    user_id: t.user_id, template_id: t.id, job_id: job.id, customer_id: job.customer_id,
    technician_id: job.assigned_technician_id,
    template_name: t.name, survey_type: t.survey_type, question: t.question,
    follow_up_question: t.follow_up_question, thank_you_message: t.thank_you_message,
    low_score_threshold: t.low_score_threshold, channel: t.channel, sms_body: t.sms_body,
    email_subject: t.email_subject, timezone: t.timezone,
    customer_name: job.customer_name || "Customer", customer_phone: phone, customer_email: email,
    service_type: job.service_type, trigger_source: "manual", status: "pending",
    send_at: new Date().toISOString(), delivery_error: null, attempts: 0, claimed_at: null,
  };

  // Re-queue a previously failed/skipped invitation in place, otherwise insert.
  const write = existing
    ? await admin.from("survey_invitations").update(row).eq("id", existing.id).select("id").single()
    : await admin.from("survey_invitations").insert(row).select("id").single();
  if (write.error) return json({ error: "DB_ERROR", detail: write.error.message }, 500);

  // Deliver just this one immediately.
  const result = await deliverOne(admin, write.data.id);
  if (result.status === "sent") return json({ status: "sent", channel: result.channel });
  if (result.status === "queued") return json({ status: "queued", channel: null });
  return json({ error: "DELIVERY_FAILED", detail: result.error ?? "Delivery failed." }, 422);
}

async function deliverOne(admin: Admin, id: string): Promise<{ status: "sent" | "queued" | "failed"; channel?: string; error?: string }> {
  const { data: claimed } = await admin
    .from("survey_invitations")
    .update({ status: "sending", claimed_at: new Date().toISOString(), attempts: 1 })
    .eq("id", id).eq("status", "pending")
    .select("id,user_id,job_id,customer_id,channel,sms_body,email_subject,question,timezone,customer_name,customer_phone,customer_email,token,attempts")
    .maybeSingle();
  if (!claimed) return { status: "queued" };
  const inv = claimed as Invitation;

  const { data: p } = await admin.from("profiles").select("company_name").eq("id", inv.user_id).maybeSingle();
  const outcome = await deliver(admin, inv, p?.company_name?.trim() || "us");

  if (outcome.status === "sent") {
    await admin.from("survey_invitations").update({
      status: "sent", claimed_at: null, sent_at: new Date().toISOString(), channel_used: outcome.channel, delivery_error: null,
    }).eq("id", id);
    return { status: "sent", channel: outcome.channel };
  }
  if (outcome.status === "deferred") {
    // Outside SMS hours: the cron will deliver it when the window opens.
    await admin.from("survey_invitations").update({
      status: "pending", claimed_at: null, attempts: 0, send_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }).eq("id", id);
    return { status: "queued" };
  }
  // Manual sends fail fast so the user sees the real reason (A2P not approved, opted out, ...).
  await admin.from("survey_invitations").update({
    status: outcome.status === "skipped" ? "skipped" : "failed", claimed_at: null, delivery_error: outcome.error ?? "Delivery failed.",
  }).eq("id", id);
  return { status: "failed", error: outcome.error };
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  // ---- Cron path ----
  const cronHeader = req.headers.get("X-Cron-Secret");
  if (cronHeader !== null) {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || cronHeader !== cronSecret) return json({ error: "Unauthorized" }, 401);
    try {
      const enqueued = await enqueueAuto(admin);
      const delivered = await deliverDue(admin);
      return json({ ok: true, enqueued, delivered });
    } catch (e) {
      console.error("[survey-dispatcher] cron run failed", e);
      return json({ error: "RUN_FAILED", detail: String((e as Error).message ?? e) }, 500);
    }
  }

  // ---- Authenticated user path ----
  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);

  const body = await req.json().catch(() => ({}));
  if (body?.action !== "send_now") return json({ error: "Unknown action" }, 400);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(String(body.templateId ?? "")) || !uuid.test(String(body.jobId ?? ""))) {
    return json({ error: "templateId and jobId are required" }, 400);
  }
  try {
    return await sendNow(admin, accessToken, body.templateId, body.jobId);
  } catch (e) {
    console.error("[survey-dispatcher] send_now failed", e);
    return json({ error: "SEND_FAILED", detail: String((e as Error).message ?? e) }, 500);
  }
});
