// supabase/functions/proxy-call-bridge/index.ts
//
// "Call customer" button for technicians (and dispatchers). Runs AS the signed-in user: the database
// function proxy_prepare_bridge() proves the caller is the assigned technician or a manager and that the
// session is still active. Twilio then rings the technician's phone showing the proxy number; when they
// answer, call-bridge-voice connects the customer. The browser only sends { session_id } and never learns
// the customer's number.
//
// Required secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CALL_BRIDGE_WEBHOOK_BASE

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { twilioApi } from "../_shared/pbx/twilio.ts";
import { callbackUrl } from "../_shared/call-bridge/logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, [number, string]> = {
  session_not_found: [404, "That conversation was not found."],
  not_allowed: [403, "You can't call on this conversation."],
  session_not_active: [409, "This conversation has ended."],
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    let body: { session_id?: string } = {};
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    if (!body.session_id || !UUID.test(body.session_id)) return json({ error: "session_id is required." }, 400);

    const base = Deno.env.get("CALL_BRIDGE_WEBHOOK_BASE");
    if (!base || !Deno.env.get("TWILIO_ACCOUNT_SID") || !Deno.env.get("TWILIO_AUTH_TOKEN")) {
      return json({ error: "not_configured" }, 503);
    }

    const { data, error } = await authClient.rpc("proxy_prepare_bridge", { p_session_id: body.session_id });
    if (error) {
      const known = ERRORS[error.message];
      if (known) return json({ error: error.message, message: known[1] }, known[0]);
      throw error;
    }
    const s = (Array.isArray(data) ? data[0] : data) as { account_owner_id: string; proxy_e164: string; technician_e164: string };
    if (!s) return json({ error: "session_not_found", message: ERRORS.session_not_found[1] }, 404);

    const q = { session: body.session_id };
    let sid: string;
    try {
      const res = await twilioApi("Calls.json", { form: {
        To: s.technician_e164, From: s.proxy_e164,
        Url: callbackUrl(base, "proxy-bridge-join", q), Method: "POST",
        StatusCallback: callbackUrl(base, "proxy-leg", q), StatusCallbackMethod: "POST",
        StatusCallbackEvent: "completed", Timeout: "25",
      } });
      sid = res.sid as string;
    } catch (e) {
      console.error("proxy_bridge_twilio_failed", e instanceof Error ? e.message : e);
      return json({ error: "twilio_failed", message: "Could not start the call. Please try again." }, 502);
    }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    await admin.from("proxy_call_events").insert({
      account_owner_id: s.account_owner_id, session_id: body.session_id, direction: "bridge_technician_to_customer",
      call_sid: sid, status: "initiated",
    });
    return json({ ok: true });
  } catch (err) {
    console.error("proxy-call-bridge failed", err instanceof Error ? err.message : err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
