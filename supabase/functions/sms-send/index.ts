// Sends a reply from the Unified Communications Inbox's SMS pane.
// Every outbound tenant SMS goes through sendCompliantSms() — the A2P
// 10DLC + opt-out gates are enforced here exactly like every other SMS
// send path in this codebase (marketing-campaign-dispatcher,
// followup-agent-dispatcher, etc.) — never bypassed for the inbox.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  const { conversationId, body } = await req.json().catch(() => ({}));
  if (!conversationId || !body?.trim()) return json({ error: "conversationId and body are required" }, 400);

  const { data: conversation } = await admin
    .from("sms_conversations")
    .select("id, customer_phone")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!conversation) return json({ error: "Conversation not found" }, 404);

  const result = await sendCompliantSms(admin, userId, conversation.customer_phone, body.trim());
  if (!result.ok) return json({ error: result.reason, detail: result.detail }, 422);

  const { data: message } = await admin
    .from("sms_messages")
    .insert({ conversation_id: conversation.id, direction: "outbound", body: body.trim(), provider_sid: result.sid })
    .select("*")
    .single();

  await admin.from("sms_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversation.id);

  return json({ message });
});
