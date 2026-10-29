// Sends a human reply from the Unified Inbox to a Telegram or Messenger conversation.
//
// Server-side gates (never trust the browser): conversation belongs to the caller, customer has not
// sent STOP, Messenger 24-hour window is open, the channel connection is healthy, length limits.
// Handled failures return HTTP 200 { ok:false, code, message } so the UI can show the reason.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendMessenger, sendTelegram } from "../_shared/dmChannels/api.ts";
import { messengerWindowOpen, validateOutbound, type DmChannel } from "../_shared/dmChannels/protocol.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (code: string, message: string) => json({ ok: false, code, message });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  const { conversationId, body } = await req.json().catch(() => ({})) as { conversationId?: string; body?: unknown };
  if (!conversationId) return json({ error: "conversationId is required" }, 400);

  try {
    const { data: conv } = await admin.from("dm_conversations")
      .select("id, channel, customer_external_id, last_inbound_at, opted_out_at")
      .eq("id", conversationId).eq("user_id", userId).maybeSingle();
    if (!conv) return fail("not_found", "Conversation not found.");
    if (conv.channel !== "telegram" && conv.channel !== "messenger") return fail("unsupported_channel", "Replying isn't available for this channel yet.");
    const channel = conv.channel as DmChannel;

    if (conv.opted_out_at) return fail("opted_out", "This customer opted out. Messages are blocked until they reply START.");
    if (channel === "messenger" && !messengerWindowOpen(conv.last_inbound_at)) {
      return fail("window_closed", "Outside Messenger's 24-hour reply window. The customer must message you again first.");
    }

    const valid = validateOutbound(channel, body);
    if (!valid.ok) return fail(valid.code, valid.message);

    const { data: conn } = await admin.from("dm_channel_connections")
      .select("id, access_token, status").eq("user_id", userId).eq("channel", channel).maybeSingle();
    if (!conn || conn.status !== "connected" || !conn.access_token) {
      return fail("not_connected", "This channel is not connected. Reconnect it in Messaging channels settings.");
    }

    const result = channel === "telegram"
      ? await sendTelegram(conn.access_token, conv.customer_external_id, valid.text)
      : await sendMessenger(conn.access_token, conv.customer_external_id, valid.text);

    if (!result.ok) {
      if (result.code === "unauthorized") {
        await admin.from("dm_channel_connections").update({ status: "error", last_error: result.message.slice(0, 300) }).eq("id", conn.id);
      }
      return fail(result.code, result.message);
    }

    const { error: insertError } = await admin.from("dm_messages").insert({
      conversation_id: conv.id, direction: "outbound", body: valid.text,
      provider_message_id: result.providerMessageId, sent_by: "human", sender_user_id: userId,
    });
    if (insertError) throw insertError;
    await admin.from("dm_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);

    return json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "dm_send_failed", error: error instanceof Error ? error.message : String(error) }));
    return fail("failed", "Something went wrong. Please try again.");
  }
});
