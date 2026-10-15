// supabase/functions/call-queue-sms/index.ts
//
// One-click text from the Priority Call Queue. Same compliance posture as
// sms-send: every message goes through sendCompliantSms() (A2P 10DLC gate +
// STOP/DNC suppression). Unlike sms-send it does not need an existing
// conversation — it finds or creates the thread for this phone, so a CSR can
// text a missed caller who has never messaged in.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const FRIENDLY: Record<string, string> = {
  A2P_NOT_APPROVED: "Texting isn't enabled yet — your A2P 10DLC registration isn't approved.",
  OPTED_OUT: "This customer opted out of texts.",
  NOT_CONFIGURED: "Texting isn't configured for this account.",
  TWILIO_ERROR: "The carrier rejected this message.",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await callerClient.auth.getUser();
  if (!user) return json({ error: "Not authenticated." }, 401);

  // Team members text on behalf of the account owner (same rule as RLS).
  const { data: ownerId } = await callerClient.rpc("get_account_owner_id");
  const accountId: string = (ownerId as string | null) ?? user.id;

  const payload = await req.json().catch(() => ({}));
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  const rawPhone = typeof payload?.phone === "string" ? payload.phone : "";
  const customerName = typeof payload?.customerName === "string" ? payload.customerName.trim().slice(0, 120) : "";

  if (!body || body.length > 640) return json({ error: "Message must be 1–640 characters." }, 400);
  if (rawPhone.replace(/\D/g, "").length < 10) return json({ error: "A valid phone number is required." }, 400);
  const phone = normalizePhone(rawPhone);

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const result = await sendCompliantSms(admin, accountId, phone, body);
  if (!result.ok) {
    return json({ error: FRIENDLY[result.reason] ?? "Could not send the text.", reason: result.reason, detail: result.detail }, 422);
  }

  // Record the message in the Unified Inbox thread (best effort — the text is already sent).
  try {
    const { data: convo } = await admin
      .from("sms_conversations")
      .upsert(
        { user_id: accountId, customer_phone: phone, ...(customerName ? { customer_name: customerName } : {}), last_message_at: new Date().toISOString() },
        { onConflict: "user_id,customer_phone" },
      )
      .select("id")
      .single();
    if (convo?.id) {
      await admin.from("sms_messages").insert({ conversation_id: convo.id, direction: "outbound", body, provider_sid: result.sid });
    }
  } catch (err) {
    console.error("[call-queue-sms] inbox log failed", err instanceof Error ? err.message : err);
  }

  return json({ ok: true });
});
