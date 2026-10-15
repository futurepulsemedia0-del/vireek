// Preventive Maintenance Command Center: notify the customer about a scheduled maintenance visit.
//
// Every text goes through sendCompliantSms() (A2P 10DLC + STOP/opt-out gates), exactly like every other
// SMS path in this codebase. Email uses the shared Resend helper. This function is the single source of
// truth for the message template: the page calls it with dryRun:true to preview, lets the operator edit,
// then calls it again to send.
//
// Body: { workItemId: uuid, channel?: 'sms'|'email'|'auto', message?: string, dryRun?: boolean, force?: boolean }

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_MS = 10 * 60 * 1000;
const MAX_MESSAGE = 480;

const SMS_ERRORS: Record<string, string> = {
  A2P_NOT_APPROVED: "Text messaging is not approved yet for this account (A2P registration is pending).",
  OPTED_OUT: "This customer opted out of text messages.",
  NOT_CONFIGURED: "Text messaging is not configured yet.",
  TWILIO_ERROR: "The text message provider rejected the message.",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "•••• ••••";
}

function maskEmail(e: string): string {
  const [user, domain] = e.split("@");
  return domain ? `${user.slice(0, 1)}•••@${domain}` : "••••";
}

function cleanOverride(s: unknown): string | null {
  if (typeof s !== "string") return null;
  // deno-lint-ignore no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return t ? t.slice(0, MAX_MESSAGE) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  // Team members act on behalf of the account owner; they need job visibility to notify customers.
  const { data: tm } = await admin
    .from("team_members")
    .select("account_owner_id, permissions")
    .eq("user_id", userId)
    .eq("invite_status", "active")
    .maybeSingle();
  const ownerId: string = tm?.account_owner_id ?? userId;
  if (tm && !(tm.permissions as { can_view_all_jobs?: boolean } | null)?.can_view_all_jobs) {
    return json({ error: "You do not have permission to notify customers." }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const workItemId = typeof body?.workItemId === "string" ? body.workItemId : "";
  if (!UUID_RE.test(workItemId)) return json({ error: "workItemId is required" }, 400);
  const requested = body?.channel === "sms" || body?.channel === "email" ? body.channel : "auto";
  const dryRun = body?.dryRun === true;
  const force = body?.force === true;

  const { data: item } = await admin
    .from("pm_work_items")
    .select("id, equipment_id, customer_id, job_id, status, signals, notified_at")
    .eq("id", workItemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!item) return json({ error: "Maintenance item not found." }, 404);
  if (!item.job_id || !["scheduled", "notified"].includes(item.status)) {
    return json({ error: "Schedule the visit first, then notify the customer." }, 409);
  }
  if (!dryRun && !force && item.notified_at && Date.now() - new Date(item.notified_at).getTime() < RECENT_MS) {
    return json({ error: "The customer was notified a few minutes ago. Wait a bit or confirm to send again." }, 409);
  }

  const [{ data: job }, { data: customer }, { data: equipment }, { data: profile }] = await Promise.all([
    admin.from("jobs").select("id, reschedule_token, scheduled_datetime, job_status").eq("id", item.job_id).eq("user_id", ownerId).maybeSingle(),
    item.customer_id
      ? admin.from("customers").select("name, phone, email").eq("id", item.customer_id).eq("user_id", ownerId).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("equipment").select("make, model, equipment_type").eq("id", item.equipment_id).eq("user_id", ownerId).maybeSingle(),
    admin.from("profiles").select("company_name").eq("id", ownerId).maybeSingle(),
  ]);

  if (!job || !["scheduled", "en_route"].includes(job.job_status) || !job.scheduled_datetime) {
    return json({ error: "The linked job is no longer scheduled." }, 409);
  }
  if (!customer) return json({ error: "This unit has no customer on file." }, 422);

  const channel: "sms" | "email" | null =
    requested === "sms" ? (customer.phone ? "sms" : null)
    : requested === "email" ? (customer.email ? "email" : null)
    : customer.phone ? "sms" : customer.email ? "email" : null;
  if (!channel) {
    return json({ error: requested === "auto" ? "This customer has no phone number or email on file." : `This customer has no ${requested === "sms" ? "phone number" : "email"} on file.` }, 422);
  }

  const business = (profile?.company_name as string | null)?.trim() || "Your service provider";
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const link = `${siteUrl}/reschedule/${job.reschedule_token}`;
  const when = new Date(job.scheduled_datetime).toUTCString().replace(/:\d\d GMT$/, " UTC");
  const friendly = [equipment?.make, equipment?.model].filter(Boolean).join(" ") || equipment?.equipment_type || "equipment";
  const signals = Array.isArray(item.signals) ? (item.signals as string[]) : [];

  let reason = "";
  if (signals.includes("warranty")) reason = " Regular service helps keep your warranty valid.";
  else if (signals.includes("contract")) reason = " This visit is covered by your maintenance plan.";

  const defaultMessage =
    `${business}: Your ${friendly} is due for preventive maintenance. We've booked you for ${when}.${reason} Need another time? ${link}`;
  let message = cleanOverride(body?.message) ?? defaultMessage;
  if (!message.includes(link)) message = `${message} Need another time? ${link}`;

  const to = channel === "sms" ? (customer.phone as string) : (customer.email as string);

  if (dryRun) {
    return json({ ok: true, channel, message, to: channel === "sms" ? maskPhone(to) : maskEmail(to) });
  }

  let failure: string | null = null;
  if (channel === "sms") {
    const result = await sendCompliantSms(admin, ownerId, to, message);
    if (!result.ok) failure = SMS_ERRORS[result.reason] ?? "The text message could not be sent.";
  } else {
    const subject = `${business}: your maintenance visit`;
    const html = `<p>${esc(message).replace(/\n/g, "<br>")}</p>`;
    const result = await sendEmail(to, subject, html, message);
    if (!result.ok) failure = "The email could not be sent.";
  }

  if (failure) {
    await admin.from("pm_work_items").update({ notify_error: failure }).eq("id", item.id);
    return json({ error: failure }, 422);
  }

  await admin
    .from("pm_work_items")
    .update({ status: "notified", notified_at: new Date().toISOString(), notified_channel: channel, notify_error: null })
    .eq("id", item.id);

  return json({ ok: true, channel, message, to: channel === "sms" ? maskPhone(to) : maskEmail(to) });
});
