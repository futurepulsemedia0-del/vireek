// Sends a reply from the Unified Communications Inbox's Email pane, via
// Resend (same provider _shared/notify/deliver.ts already uses for
// transactional email). reply_to is set to the tenant's own inbound
// alias so the customer's next reply routes back through
// email-webhook into this same conversation.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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

  const { conversationId, subject, body } = await req.json().catch(() => ({}));
  if (!conversationId || !body?.trim()) return json({ error: "conversationId and body are required" }, 400);

  const { data: conversation } = await admin
    .from("email_conversations")
    .select("id, customer_email, subject")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!conversation) return json({ error: "Conversation not found" }, 404);

  const { data: profile } = await admin
    .from("profiles")
    .select("company_name, inbound_email_token")
    .eq("id", userId)
    .maybeSingle();

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  const inboundDomain = Deno.env.get("INBOUND_EMAIL_DOMAIN");
  if (!apiKey) return json({ error: "NOT_CONFIGURED", detail: "Email isn't configured yet (missing RESEND_API_KEY)." }, 422);

  const finalSubject = subject?.trim() || conversation.subject || "Re: your message";
  const replyTo =
    inboundDomain && profile?.inbound_email_token ? `${profile.inbound_email_token}@${inboundDomain}` : undefined;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: profile?.company_name ? `${profile.company_name} <${fromAddress.split("<").pop()?.replace(">", "") ?? fromAddress}>` : fromAddress,
      to: [conversation.customer_email],
      reply_to: replyTo,
      subject: finalSubject,
      text: body.trim(),
    }),
  });

  if (!res.ok) return json({ error: "PROVIDER_ERROR", detail: await res.text() }, 422);

  const { data: message } = await admin
    .from("email_messages")
    .insert({ conversation_id: conversation.id, direction: "outbound", subject: finalSubject, body_text: body.trim() })
    .select("*")
    .single();

  await admin.from("email_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversation.id);

  return json({ message });
});
