// Phase 1 of the WhatsApp channel: verifies Meta's webhook handshake,
// receives inbound messages, stores the conversation, and replies using the
// same Knowledge Base search Sarah uses on calls (toolSearchKnowledge) —
// NOT full booking parity with the voice agent yet. That's a real follow-up
// phase (tool-calling, booking, escalation) once this receiving pipeline is
// proven live.
//
// Meta setup: Webhook URL = this function's URL, Verify Token =
// WHATSAPP_VERIFY_TOKEN. Subscribe to the "messages" field.
//
// VERIFY before production: Meta's Cloud API payload shape is stable and
// well-documented, but confirm field names against
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
// against a live test message before going to real customers.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { toolSearchKnowledge } from "../_shared/knowledge/search.ts";
import { safeEqual, verifyMetaSignature } from "../_shared/dmChannels/protocol.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Meta webhook verification handshake (GET).
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expectedVerifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
    if (mode === "subscribe" && expectedVerifyToken && token && safeEqual(token, expectedVerifyToken)) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  // Meta signs every POST: X-Hub-Signature-256 = sha256 HMAC(app secret, raw body). Fail closed.
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) {
    console.error(JSON.stringify({ event: "whatsapp_webhook_misconfigured", error: "META_APP_SECRET is not set" }));
    return new Response("Not configured", { status: 500 });
  }
  const rawBody = await req.text();
  if (!(await verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const payload = JSON.parse(rawBody);
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;

    // Meta sends delivery/read status callbacks too — only handle real inbound text messages.
    if (!message || !phoneNumberId || message.type !== "text") {
      return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
    }

    const { data: connection } = await admin
      .from("dm_channel_connections")
      .select("user_id, access_token")
      .eq("channel", "whatsapp")
      .eq("external_account_id", phoneNumberId)
      .eq("status", "connected")
      .maybeSingle();

    if (!connection) {
      console.error(JSON.stringify({ event: "whatsapp_webhook_unknown_phone_number_id", phoneNumberId }));
      return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
    }

    const customerNumber = message.from as string;
    const customerName = value?.contacts?.[0]?.profile?.name ?? null;
    const inboundBody = message.text?.body ?? "";

    const { data: conversation } = await admin
      .from("dm_conversations")
      .upsert(
        { user_id: connection.user_id, channel: "whatsapp", customer_external_id: customerNumber, customer_name: customerName, unread: true, last_message_at: new Date().toISOString() },
        { onConflict: "user_id,channel,customer_external_id" },
      )
      .select("id")
      .single();

    if (!conversation) throw new Error("Failed to upsert conversation");

    await admin.from("dm_messages").insert({ conversation_id: conversation.id, direction: "inbound", body: inboundBody });

    const replyBody = await toolSearchKnowledge(admin, { userId: connection.user_id }, { question: inboundBody }, null);

    const sendRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: customerNumber,
        text: { body: replyBody },
      }),
    });

    if (sendRes.ok) {
      await admin.from("dm_messages").insert({ conversation_id: conversation.id, direction: "outbound", body: replyBody });
    } else {
      console.error(JSON.stringify({ event: "whatsapp_send_failed", status: sendRes.status, body: await sendRes.text() }));
    }

    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error(JSON.stringify({ event: "whatsapp_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } }); // 200 so Meta doesn't retry-storm
  }
});
