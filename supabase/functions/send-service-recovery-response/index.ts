// supabase/functions/send-service-recovery-response/index.ts
//
// Sends the apology / recovery message a human approved on the Service Recovery page
// (src/pages/ServiceRecoveryPage.tsx -> handleSend).
//
// Body:    { signal_id: uuid, message: string, channel: 'sms' | 'email' }
// Success: { ok: true, channel, status, deferred?, send_at? }
// Failure: HTTP 200 { error } for anything the operator can act on (the page shows `data.error` in its toast);
//          401 / 405 / 500 for auth and unexpected failures.
//
// GUARANTEES
//   * Exactly-once: the signal is atomically claimed (open -> action_queued) BEFORE anything is sent, so a
//     double click, a retry, or two staff members acting at once can never text a customer twice. A failed
//     send releases the claim again.
//   * Compliance: SMS goes through sendCompliantSms() (A2P 10DLC approval, opt-out/DNC, quiet hours).
//     Email goes through sendGatedEmail() (quiet hours + the shared Resend sender).
//   * Tenant safety: the signal is loaded with the owner id resolved HERE (never client-supplied), and the
//     caller must be the owner or a team member with can_view_all_jobs.
//   * Only signals that still need a decision can be answered (open / playbook_enrolled / escalated).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendGatedEmail } from "../_shared/messaging/gatedSend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMS_MAX = 480;
const EMAIL_MAX = 2000;
const ANSWERABLE = ["open", "playbook_enrolled", "escalated"] as const;
type Channel = "sms" | "email";

const SMS_ERRORS: Record<string, string> = {
  A2P_NOT_APPROVED: "Text messaging is not approved yet for this account (A2P registration is pending).",
  OPTED_OUT: "This customer opted out of text messages.",
  NOT_CONFIGURED: "Text messaging is not configured yet.",
  TWILIO_ERROR: "The text message provider rejected the message.",
  QUIET_HOURS: "It's outside the customer's allowed contact hours.",
  QUEUE_ERROR: "The message could not be queued for the next allowed window.",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cleanMessage(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

const ANSWERABLE_STATUS = new Set<string>(ANSWERABLE);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    // ---- authenticate -------------------------------------------------
    const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
    const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
    const userId = userData.user.id;

    // ---- tenant + permission -----------------------------------------
    const { data: tm, error: tmError } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .eq("user_id", userId)
      .eq("invite_status", "active")
      .maybeSingle();
    if (tmError) {
      console.error("[send-service-recovery-response] team lookup failed:", tmError.message);
      return json({ error: "Could not verify your permissions. Please try again." }, 500);
    }
    const ownerId: string = tm?.account_owner_id ?? userId;
    if (tm) {
      const custom = (tm as { custom_role?: { permissions?: Record<string, boolean> } | null }).custom_role?.permissions ?? {};
      const effective = { ...((tm.permissions as Record<string, boolean> | null) ?? {}), ...custom };
      if (!effective.can_view_all_jobs) return json({ error: "You don't have permission to message customers." });
    }

    // ---- validate input ----------------------------------------------
    const body = await req.json().catch(() => ({}));
    const signalId = typeof body?.signal_id === "string" ? body.signal_id : "";
    const channel: Channel | null = body?.channel === "sms" || body?.channel === "email" ? body.channel : null;
    if (!UUID_RE.test(signalId)) return json({ error: "signal_id is required." });
    if (!channel) return json({ error: "Choose text or email." });
    const message = cleanMessage(body?.message, channel === "sms" ? SMS_MAX : EMAIL_MAX);
    if (!message) return json({ error: "Write a message first." });

    // ---- load the signal (owner-scoped) ------------------------------
    const { data: signal, error: signalError } = await admin
      .from("service_recovery_signals")
      .select("id, status, customer_id, job_id, customer_name, customer_phone, customer_email")
      .eq("id", signalId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (signalError) {
      console.error("[send-service-recovery-response] signal lookup failed:", signalError.message);
      return json({ error: "Could not load this signal." }, 500);
    }
    if (!signal) return json({ error: "Signal not found." });
    if (!ANSWERABLE_STATUS.has(signal.status)) {
      return json({
        error:
          signal.status === "action_sent" || signal.status === "action_queued"
            ? "A response was already sent for this signal."
            : "This signal is already closed.",
      });
    }

    // ---- contact details (signal first, then the linked customer / job) ----
    let phone: string | null = signal.customer_phone ?? null;
    let email: string | null = signal.customer_email ?? null;
    let customerId: string | null = signal.customer_id ?? null;

    if ((!phone || !email) && !customerId && signal.job_id) {
      const { data: job } = await admin
        .from("jobs")
        .select("customer_id, customer_phone")
        .eq("id", signal.job_id)
        .eq("user_id", ownerId)
        .maybeSingle();
      customerId = job?.customer_id ?? null;
      phone = phone ?? job?.customer_phone ?? null;
    }
    if ((!phone || !email) && customerId) {
      const { data: customer } = await admin
        .from("customers")
        .select("phone, email")
        .eq("id", customerId)
        .eq("user_id", ownerId)
        .maybeSingle();
      phone = phone ?? customer?.phone ?? null;
      email = email ?? customer?.email ?? null;
    }

    const to = channel === "sms" ? phone : email;
    if (!to) {
      return json({ error: channel === "sms" ? "This customer has no phone number on file." : "This customer has no email address on file." });
    }

    const { data: profile } = await admin.from("profiles").select("company_name").eq("id", ownerId).maybeSingle();
    const business = (profile?.company_name as string | null)?.trim() || "Your service provider";

    // ---- claim the signal (exactly-once) -----------------------------
    const previousStatus: string = signal.status;
    const { data: claimed, error: claimError } = await admin
      .from("service_recovery_signals")
      .update({ status: "action_queued" })
      .eq("id", signal.id)
      .eq("user_id", ownerId)
      .eq("status", previousStatus)
      .select("id")
      .maybeSingle();
    if (claimError) {
      console.error("[send-service-recovery-response] claim failed:", claimError.message);
      return json({ error: "Could not start the send. Please try again." }, 500);
    }
    if (!claimed) return json({ error: "Someone else just handled this signal." });

    const release = () =>
      admin
        .from("service_recovery_signals")
        .update({ status: previousStatus })
        .eq("id", signal.id)
        .eq("user_id", ownerId)
        .eq("status", "action_queued");

    // ---- send ---------------------------------------------------------
    let failure: string | null = null;
    let deferred = false;
    let sendAt: string | undefined;

    try {
      if (channel === "sms") {
        const text = message.toLowerCase().includes(business.toLowerCase()) ? message : `${message} - ${business}`.slice(0, SMS_MAX);
        const result = await sendCompliantSms(admin, ownerId, to, text, {
          purpose: "service",
          customerId,
          source: "service-recovery",
          dedupeKey: `service-recovery:${signal.id}`,
        });
        if (!result.ok) {
          failure = SMS_ERRORS[result.reason] ?? "The text message could not be sent.";
        } else if (result.deferred) {
          deferred = true;
          sendAt = result.sendAt;
        }
      } else {
        const subject = `${business}: following up on your service`;
        const html =
          `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#111">` +
          `<p>${esc(message).replace(/\n/g, "<br>")}</p>` +
          `<p style="color:#555">- ${esc(business)}</p></div>`;
        const result = await sendGatedEmail(admin, ownerId, to, subject, html, `${message}\n\n- ${business}`, {
          purpose: "service",
          customerId,
          source: "service-recovery",
          dedupeKey: `service-recovery:${signal.id}`,
        });
        if (!result.ok) failure = result.error?.startsWith("Email isn't configured") ? "Email isn't configured yet." : "The email could not be sent.";
        else if (result.deferred) {
          deferred = true;
          sendAt = result.sendAt;
        }
      }
    } catch (err) {
      console.error("[send-service-recovery-response] send threw:", err);
      failure = "The message could not be sent. Please try again.";
    }

    if (failure) {
      await release();
      return json({ error: failure });
    }

    // ---- record the outcome ------------------------------------------
    const { error: finishError } = await admin
      .from("service_recovery_signals")
      .update({
        status: "action_sent",
        executed_at: new Date().toISOString(),
        executed_channel: channel,
        recommended_channel: channel,
        recommended_message: message,
      })
      .eq("id", signal.id)
      .eq("user_id", ownerId);
    if (finishError) {
      // The customer HAS been messaged; never release the claim here or a retry would double-send.
      console.error("[send-service-recovery-response] message sent but could not record it:", finishError.message);
    }

    return json({ ok: true, channel, status: "action_sent", deferred, send_at: sendAt });
  } catch (err) {
    console.error("[send-service-recovery-response] unexpected error:", err);
    return json({ error: "Could not send the response right now." }, 500);
  }
});
