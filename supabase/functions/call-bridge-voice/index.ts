// supabase/functions/call-bridge-voice/index.ts
//
// Public Twilio webhook (verify_jwt=false) for BOTH call masking and the power dialer.
// Every request is authenticated with X-Twilio-Signature; destinations are always resolved from the
// database by id, never taken from the URL, so nobody can make this endpoint dial an arbitrary number.
//
// Actions (?action=):
//   proxy-inbound      Twilio "A call comes in" URL of every number in the proxy pool
//   proxy-bridge-join  technician answered the server-placed bridge call -> dial the customer
//   proxy-status       <Dial action> result for proxy calls (status + duration)
//   proxy-leg          status callback of the technician leg of a bridge call
//   dialer-join        agent answered the dialer call -> dial the contact
//   dialer-status      <Dial action> result for dialer calls
//   dialer-leg         status callback of the agent leg (agent never picked up)
//
// Required secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CALL_BRIDGE_WEBHOOK_BASE
//   (= the full public URL of this function, no query string).
// NOT LIVE-VERIFIED against Twilio: run the test checklist in the guide before pointing numbers here.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { twiml, validTwilioSignature } from "../_shared/pbx/twilio.ts";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";
import {
  callbackUrl, dialTwiml, last4, mapTwilioStatus, normalizeE164, parseDuration, sayHangup,
} from "../_shared/call-bridge/logic.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = "Sorry, that person can't take your call right now. Please try again in a little while.";
const log = (event: string, extra: Row = {}) => console.log(JSON.stringify({ event, ...extra }));

async function proxyInbound(a: SupabaseClient, base: string, p: Record<string, string>): Promise<Response> {
  const to = normalizeE164(p.To) ?? p.To ?? "";
  const from = normalizeE164(p.From);
  const sid = p.CallSid || null;

  const { data: hit } = from
    ? await a.rpc("proxy_resolve_inbound", { p_proxy_e164: to, p_from_e164: from })
    : { data: null };
  const route = (Array.isArray(hit) ? hit[0] : hit) as Row | null;

  if (!route) {
    const { data: num } = await a.from("proxy_numbers").select("id, account_owner_id").eq("e164", to).maybeSingle();
    if (num) {
      await a.from("proxy_call_events").upsert({
        account_owner_id: num.account_owner_id, proxy_number_id: num.id, direction: "blocked", call_sid: sid,
        status: "blocked", caller_hint: last4(from),
      }, { onConflict: "call_sid", ignoreDuplicates: true });
    }
    return twiml(sayHangup("This number is no longer in service."));
  }

  await a.from("proxy_call_events").upsert({
    account_owner_id: route.account_owner_id, session_id: route.session_id, proxy_number_id: route.proxy_number_id,
    direction: route.direction, call_sid: sid, status: "initiated", caller_hint: last4(from),
  }, { onConflict: "call_sid", ignoreDuplicates: true });

  return twiml(dialTwiml({
    callerId: to, number: route.destination_e164, action: callbackUrl(base, "proxy-status"), timeout: 25,
  }));
}

async function proxyBridgeJoin(a: SupabaseClient, base: string, session: string): Promise<Response> {
  if (!UUID.test(session)) return twiml(sayHangup("This call can't be connected."));
  const { data: s } = await a.from("proxy_sessions")
    .select("customer_e164, status, expires_at, proxy_numbers(e164)").eq("id", session).maybeSingle();
  const pn = Array.isArray(s?.proxy_numbers) ? s?.proxy_numbers[0] : s?.proxy_numbers;
  if (!s || s.status !== "active" || new Date(s.expires_at).getTime() <= Date.now() || !pn?.e164) {
    return twiml(sayHangup("This conversation has ended."));
  }
  return twiml(
    `<Say>Connecting you to the customer.</Say>` +
    dialTwiml({ callerId: pn.e164, number: s.customer_e164, action: callbackUrl(base, "proxy-status"), timeout: 30 }),
  );
}

async function proxyStatus(a: SupabaseClient, p: Record<string, string>): Promise<Response> {
  const status = mapTwilioStatus(p.DialCallStatus);
  if (p.CallSid) {
    await a.from("proxy_call_events").update({
      status, duration_seconds: parseDuration(p.DialCallDuration), updated_at: new Date().toISOString(),
    }).eq("call_sid", p.CallSid);
  }
  return twiml(status === "completed" ? "<Hangup/>" : sayHangup(UNAVAILABLE));
}

async function proxyLeg(a: SupabaseClient, p: Record<string, string>): Promise<Response> {
  const status = mapTwilioStatus(p.CallStatus);
  if (p.CallSid && ["busy", "no_answer", "failed", "canceled"].includes(status)) {
    await a.from("proxy_call_events").update({ status, updated_at: new Date().toISOString() })
      .eq("call_sid", p.CallSid).in("status", ["initiated", "ringing"]);
  }
  return new Response(null, { status: 204 });
}

async function dialerJoin(a: SupabaseClient, base: string, attemptId: string, callSid: string): Promise<Response> {
  if (!UUID.test(attemptId)) return twiml(sayHangup("This call can't be connected."));
  const { data: at } = await a.from("dialer_attempts")
    .select("id, account_owner_id, contact_id, disposition, call_sid, dialer_contacts(phone_e164, status), dialer_campaigns(phone_number_id, status)")
    .eq("id", attemptId).maybeSingle();
  const contact = Array.isArray(at?.dialer_contacts) ? at?.dialer_contacts[0] : at?.dialer_contacts;
  const camp = Array.isArray(at?.dialer_campaigns) ? at?.dialer_campaigns[0] : at?.dialer_campaigns;
  if (!at || at.disposition || at.call_sid !== callSid || contact?.status !== "claimed" || camp?.status !== "active") {
    return twiml(sayHangup("This call is no longer available."));
  }
  if (await isDncSuppressed(a, at.account_owner_id, contact.phone_e164)) {
    return twiml(sayHangup("This number is on the do not call list."));
  }
  const { data: line } = await a.from("phone_numbers").select("phone_number")
    .eq("id", camp.phone_number_id).eq("account_id", at.account_owner_id).maybeSingle();
  const callerId = normalizeE164(line?.phone_number);
  if (!callerId) return twiml(sayHangup("No caller ID is configured for this campaign."));

  await a.rpc("dialer_record_call_status", { p_call_sid: callSid, p_call_status: "connected", p_talk_seconds: null });
  return twiml(
    `<Say>Connecting your next call.</Say>` +
    dialTwiml({ callerId, number: contact.phone_e164, action: callbackUrl(base, "dialer-status"), timeout: 35 }),
  );
}

async function dialerStatus(a: SupabaseClient, p: Record<string, string>): Promise<Response> {
  const mapped = mapTwilioStatus(p.DialCallStatus);
  const status = ["completed", "busy", "no_answer", "canceled"].includes(mapped) ? mapped : "failed";
  if (p.CallSid) {
    await a.rpc("dialer_record_call_status", {
      p_call_sid: p.CallSid, p_call_status: status, p_talk_seconds: parseDuration(p.DialCallDuration),
    });
  }
  return twiml("<Hangup/>");
}

async function dialerLeg(a: SupabaseClient, p: Record<string, string>): Promise<Response> {
  const status = mapTwilioStatus(p.CallStatus);
  if (p.CallSid && ["busy", "no_answer", "failed", "canceled"].includes(status)) {
    // Only when the agent's own phone never connected (dialer-join sets "connected" first).
    const { data } = await a.from("dialer_attempts").select("call_status").eq("call_sid", p.CallSid).maybeSingle();
    if (data && (data.call_status === "queued" || data.call_status === null)) {
      await a.rpc("dialer_record_call_status", { p_call_sid: p.CallSid, p_call_status: "agent_unreachable", p_talk_seconds: null });
    }
  }
  return new Response(null, { status: 204 });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  const params: Record<string, string> = {};
  (await req.formData()).forEach((v, k) => { if (typeof v === "string") params[k] = v; });

  const base = Deno.env.get("CALL_BRIDGE_WEBHOOK_BASE") ?? "";
  const ok = base && await validTwilioSignature(
    base + url.search, params, req.headers.get("X-Twilio-Signature"), Deno.env.get("TWILIO_AUTH_TOKEN") ?? "",
  );
  if (!ok) return new Response("Forbidden", { status: 403 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    switch (action) {
      case "proxy-inbound": return await proxyInbound(admin, base, params);
      case "proxy-bridge-join": return await proxyBridgeJoin(admin, base, url.searchParams.get("session") ?? "");
      case "proxy-status": return await proxyStatus(admin, params);
      case "proxy-leg": return await proxyLeg(admin, params);
      case "dialer-join": return await dialerJoin(admin, base, url.searchParams.get("attempt") ?? "", params.CallSid ?? "");
      case "dialer-status": return await dialerStatus(admin, params);
      case "dialer-leg": return await dialerLeg(admin, params);
      default: return new Response("Unknown action", { status: 400 });
    }
  } catch (e) {
    log("call_bridge_voice_error", { action, error: e instanceof Error ? e.message : String(e) });
    return twiml(sayHangup("Sorry, something went wrong. Please try again."));
  }
});
