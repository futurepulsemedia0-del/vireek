// supabase/functions/dialer-call/index.ts
//
// "Call" button of the power dialer. Runs AS the signed-in agent. Order of checks (all on the server):
//   1. dialer_begin_attempt()  claim ownership, campaign active, hourly cap, no call already in progress
//   2. DNC suppression         -> disposition do_not_call, nothing is dialed
//   3. quiet hours gate        -> contact is deferred to the next allowed time
//   4. Twilio rings the AGENT's own phone (profile phone), call-bridge-voice then connects the contact
//      showing the campaign's caller ID.
// The browser only sends { contact_id }; numbers are resolved here.
//
// Required secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CALL_BRIDGE_WEBHOOK_BASE
// Without them the function answers 503 "not_configured" and the UI falls back to a tel: link.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { twilioApi } from "../_shared/pbx/twilio.ts";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";
import { gateOutbound } from "../_shared/messaging/quietHours.ts";
import { callbackUrl, normalizeE164 } from "../_shared/call-bridge/logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, number> = {
  not_authenticated: 401, not_allowed: 403, not_claimed_by_you: 403, contact_not_found: 404,
  campaign_not_active: 409, call_in_progress: 409, hourly_cap_reached: 429,
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
    if (!user) return json({ error: "not_authenticated" }, 401);

    let body: { contact_id?: string } = {};
    try { body = await req.json(); } catch { return json({ error: "invalid_body" }, 400); }
    if (!body.contact_id || !UUID.test(body.contact_id)) return json({ error: "invalid_body" }, 400);

    const base = Deno.env.get("CALL_BRIDGE_WEBHOOK_BASE");
    if (!base || !Deno.env.get("TWILIO_ACCOUNT_SID") || !Deno.env.get("TWILIO_AUTH_TOKEN")) {
      return json({ error: "not_configured" }, 503);
    }

    const { data: me } = await authClient.from("profiles").select("phone").eq("id", user.id).maybeSingle();
    const agentPhone = normalizeE164(me?.phone);
    if (!agentPhone) return json({ error: "agent_phone_missing" }, 422);

    const { data: attemptData, error: beginErr } = await authClient.rpc("dialer_begin_attempt", { p_contact_id: body.contact_id });
    if (beginErr) {
      const status = ERRORS[beginErr.message];
      if (status) return json({ error: beginErr.message }, status);
      throw beginErr;
    }
    const attempt = (Array.isArray(attemptData) ? attemptData[0] : attemptData) as { id: string; account_owner_id: string; campaign_id: string };

    const { data: contact } = await authClient.from("dialer_contacts").select("id, phone_e164").eq("id", body.contact_id).maybeSingle();
    const { data: camp } = await authClient.from("dialer_campaigns").select("phone_number_id").eq("id", attempt.campaign_id).maybeSingle();
    if (!contact || !camp) return json({ error: "contact_not_found" }, 404);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    if (await isDncSuppressed(admin, attempt.account_owner_id, contact.phone_e164)) {
      await authClient.rpc("dialer_complete_attempt", { p_contact_id: contact.id, p_disposition: "do_not_call", p_note: "Suppressed by DNC list at dial time." });
      return json({ blocked: "dnc" }, 200);
    }

    const gate = await gateOutbound(admin, attempt.account_owner_id, {
      channel: "call", to: contact.phone_e164, purpose: "marketing", source: "dialer-call",
    });
    if (!gate.proceed) {
      await authClient.rpc("dialer_defer_contact", { p_contact_id: contact.id, p_until: gate.sendAt });
      return json({ blocked: "quiet_hours", retry_at: gate.sendAt }, 200);
    }

    const { data: line } = await admin.from("phone_numbers").select("phone_number")
      .eq("id", camp.phone_number_id).eq("account_id", attempt.account_owner_id).maybeSingle();
    const callerId = normalizeE164(line?.phone_number);
    if (!callerId) return json({ error: "caller_id_missing" }, 422);

    let sid: string;
    try {
      const res = await twilioApi("Calls.json", { form: {
        To: agentPhone, From: callerId,
        Url: callbackUrl(base, "dialer-join", { attempt: attempt.id }), Method: "POST",
        StatusCallback: callbackUrl(base, "dialer-leg", { attempt: attempt.id }), StatusCallbackMethod: "POST",
        StatusCallbackEvent: "completed", Timeout: "25",
      } });
      sid = res.sid as string;
    } catch (e) {
      console.error("dialer_twilio_failed", e instanceof Error ? e.message : e);
      return json({ error: "twilio_failed" }, 502);
    }

    await admin.rpc("dialer_attach_call", { p_attempt_id: attempt.id, p_call_sid: sid });
    return json({ ok: true, attempt_id: attempt.id });
  } catch (err) {
    console.error("dialer-call failed", err instanceof Error ? err.message : err);
    return json({ error: "internal_error" }, 500);
  }
});
