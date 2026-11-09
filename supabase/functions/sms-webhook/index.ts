// Twilio inbound SMS webhook — set this function's URL as the "A MESSAGE
// COMES IN" webhook on the Twilio number (or Messaging Service) each
// tenant's phone_numbers row represents. Stores the message into the
// Unified Communications Inbox (sms_conversations/sms_messages) for a
// human to answer from /dashboard/inbox — no auto-reply here, unlike
// whatsapp-webhook, since SMS in this inbox is meant for a real person.
//
// Also enforces STOP-style opt-out at the one place every inbound SMS
// passes through, writing straight into dnc_suppressions (the same list
// sendCompliantSms() already checks before any future send).
//
// Twilio POSTs application/x-www-form-urlencoded with (at minimum) From,
// To, Body, MessageSid — stable, documented fields. Confirm against
// https://www.twilio.com/docs/messaging/guides/webhook-request before
// going live.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { validTwilioSignature } from "../_shared/pbx/twilio.ts";
import { applySigPolicy } from "../_shared/http/inboundSignature.ts";
import { runAutoReplyInBackground } from "../_shared/autoReply/runtime.ts";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";
import { recordLanguageFromMessage } from "../_shared/i18n/customerLanguage.ts";
import { STOP_WORDS } from "../_shared/messaging/optOut.ts";
import { classifySymptom } from "../_shared/mass-incident/core.ts";
import { ingestIncidentContact } from "../_shared/mass-incident/runtime.ts";
import { handleIncidentSms } from "../_shared/mass-incident/runtime.ts";


function emptyTwiml() {
  return new Response("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
const form = await req.formData();
const sigParams: Record<string, string> = {};
form.forEach((v, k) => { if (typeof v === "string") sigParams[k] = v; });
const sigOk = await validTwilioSignature(
  Deno.env.get("SMS_WEBHOOK_URL") ?? "",
  sigParams,
  req.headers.get("X-Twilio-Signature"),
  Deno.env.get("TWILIO_AUTH_TOKEN") ?? "",
);
const sigReject = applySigPolicy("twilio-sms", { ok: sigOk, reason: sigOk ? undefined : "invalid twilio signature" });
if (sigReject) return sigReject;
    const from = normalizePhone(String(form.get("From") ?? ""));
    const to = normalizePhone(String(form.get("To") ?? ""));
    const body = String(form.get("Body") ?? "").trim();
    const providerSid = String(form.get("MessageSid") ?? "") || null;

    if (!from || !to) return emptyTwiml();

    const { data: number } = await admin
      .from("phone_numbers")
      .select("account_id")
      .eq("phone_number", to)
      .maybeSingle();

    if (!number) {
      console.error(JSON.stringify({ event: "sms_webhook_unknown_to_number", to }));
      return emptyTwiml();
    }
    const userId = number.account_id as string;

    if (STOP_WORDS.has(body.toUpperCase())) {
      await admin
        .from("dnc_suppressions")
        .upsert({ user_id: userId, phone_number: from, reason: "customer_opt_out" }, { onConflict: "user_id,phone_number" });
    }

    // Site Safety Intelligence: a technician's SMS fallback ("OK 123456" / "HELP") never enters the customer inbox.
    const { data: safetyReply } = await admin.rpc("safety_checkin_by_sms", { p_user: userId, p_phone: from, p_body: body });
    if ((safetyReply as { handled?: boolean } | null)?.handled) return emptyTwiml();
    const { data: conversation } = await admin
      .from("sms_conversations")
      .upsert(
        { user_id: userId, customer_phone: from, unread: true, last_message_at: new Date().toISOString() },
        { onConflict: "user_id,customer_phone" },
      )
      .select("id")
      .single();

    if (!conversation) throw new Error("Failed to upsert sms_conversations");

    const { data: dupe } = await admin
      .from("sms_messages").select("id")
      .eq("conversation_id", conversation.id).eq("provider_sid", providerSid ?? "").maybeSingle();
    if (providerSid && dupe) return emptyTwiml(); // Twilio retry, already stored

    const { data: inboundMsg } = await admin.from("sms_messages").insert({
      conversation_id: conversation.id,
      direction: "inbound",
      body: body || "(empty message)",
      provider_sid: providerSid,
    }).select("id").single();

    await recordLanguageFromMessage(admin, userId, { phone: from }, body);
    let incidentReplied = false;
    if (inboundMsg && !STOP_WORDS.has(body.toUpperCase()) && classifySymptom(body).symptomClass !== "other") {
      incidentReplied = await handleIncidentSms(admin, { userId, sourceRef: String(inboundMsg.id), phone: from, body });
    }
    if (inboundMsg && !incidentReplied) {
      await runAutoReplyInBackground(admin, {
        userId, channel: "sms", conversationId: conversation.id,
        inboundMessageId: inboundMsg.id, text: body, customerLabel: from,
      });
    }

    return emptyTwiml();
  } catch (error) {
    console.error(JSON.stringify({ event: "sms_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return emptyTwiml(); // 200 so Twilio doesn't retry-storm
  }
});
