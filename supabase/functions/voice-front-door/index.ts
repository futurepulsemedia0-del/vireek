// supabase/functions/voice-front-door/index.ts
//
// OPT-IN Twilio "front door": a number's Voice URL points here, and this function decides, per call, between the
// AI engine (L0/L1) and the engine-independent paths (L2 voicemail+alert, L3 forward, L4 static). Every path ends in a
// defined outcome: a call is never dropped silently. The emergency key/keyword works at EVERY level.
//
// NOT LIVE-VERIFIED against Twilio or the engine's SIP endpoint. Do not point a production number here before the
// game-day drills in docs/runbooks/voice-resilience.md have passed in staging.
//
// Secrets: TWILIO_AUTH_TOKEN, VOICE_FRONT_DOOR_BASE (public URL of this function, no trailing slash),
//          VOICE_ENGINE_SIP_URI (e.g. the engine's SIP address for the number; if unset, L0/L1 are served as L2),
//          TWILIO_ACCOUNT_SID/TWILIO_FROM_NUMBER (owner SMS), optional TELNYX_* (secondary SMS).
// Deploy: supabase functions deploy voice-front-door --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { validTwilioSignature } from "../_shared/pbx/twilio.ts";
import { detectEmergencyGather } from "../_shared/voice-resilience/emergencyFastPath.ts";
import { degradeFrom, type Level } from "../_shared/voice-resilience/ladder.ts";
import { ALL_HEALTHY } from "../_shared/voice-resilience/ladder.ts";
import { arrivalMatches, evaluateForwardTest, type ForwardCheck } from "../_shared/voice-resilience/carrierForwarding.ts";
import {
  emergencyTwiml, forwardTwiml, thanksTwiml, twimlForLevel, voicemailTwiml, wrap, xmlEsc, type FallbackCtx,
} from "../_shared/voice-resilience/twimlFallback.ts";
import { activeChaos, effectiveLevel, loadOrgContact, notifyInApp, recordOutcome, sendOwnerSms } from "../_shared/voice-resilience/runtime.ts";

const xml = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "inbound";
  const params: Record<string, string> = {};
  (await req.formData()).forEach((v, k) => { if (typeof v === "string") params[k] = v.slice(0, 4000); });

  const base = Deno.env.get("VOICE_FRONT_DOOR_BASE") ?? "";
  if (!(await validTwilioSignature(base + url.search, params, req.headers.get("X-Twilio-Signature"), Deno.env.get("TWILIO_AUTH_TOKEN") ?? ""))) {
    return new Response("Forbidden", { status: 403 });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const sid = params.CallSid ?? "";
  const hookFor = (owner: string, extra: Record<string, string> = {}) => (a: string, p: Record<string, string> = {}) => {
    const q = new URLSearchParams({ action: a, o: owner, ...extra, ...p });
    return `${base}?${q.toString()}`;
  };

  // The outbound wizard call reports status to a different action that carries no owner.
  if (action === "check-status") return await checkStatus(admin, url.searchParams.get("check") ?? "", params);

  try {
    if (action === "inbound") return await inbound(admin, params, hookFor);

    const owner = url.searchParams.get("o") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(owner) || !sid) return xml(wrap("<Say>Sorry, an error occurred.</Say><Hangup/>"));
    const contact = await loadOrgContact(admin, owner);
    const ctx: FallbackCtx = { ...contact, hook: hookFor(owner), callerId: params.To };
    const emergencyFlag = url.searchParams.get("e") === "1";

    switch (action) {
      case "engine-done": {
        const st = params.DialCallStatus ?? "";
        const ok = st === "completed";
        void recordOutcome(admin, { providerId: "vapi", capability: "voice_engine", ok, errorCode: ok ? undefined : st || "unknown", userId: owner });
        if (ok) return xml(wrap("<Hangup/>"));
        // Engine did not answer THIS call: degrade just this call, regardless of the org-wide level.
        const next = degradeFrom(1, ALL_HEALTHY);
        await markFallback(admin, owner, sid, next, params.From);
        return xml(twimlForLevel(next, ctx));
      }
      case "emergency-check": {
        const v = detectEmergencyGather(params);
        if (!v.emergency) return xml(voicemailTwiml(ctx, { skipPrompt: true }));
        await raiseEmergency(admin, owner, sid, params.From ?? null, contact.ownerPhone, "keypad_or_speech");
        return xml(emergencyTwiml(ctx));
      }
      case "forward-done": {
        const st = params.DialCallStatus ?? "";
        const i = Number(url.searchParams.get("i") ?? "1");
        if (st === "completed") {
          await admin.from("voice_fallback_calls").update({ outcome: emergencyFlag ? "emergency_forwarded" : "forwarded", updated_at: new Date().toISOString() }).eq("call_sid", sid);
          return xml(wrap("<Hangup/>"));
        }
        if (i < ctx.forwardTargets.length && Number.isInteger(i) && i > 0) return xml(forwardTwiml(ctx, i, emergencyFlag));
        // Nobody answered: capture a message; the emergency flag (if any) is already raised and alerted.
        await admin.from("voice_fallback_calls").update({ outcome: "voicemail", updated_at: new Date().toISOString() }).eq("call_sid", sid);
        return xml(voicemailTwiml(ctx, { noOneAvailable: true }));
      }
      case "vm-done":
        return xml(thanksTwiml(ctx));
      case "vm-recording": {
        await admin.from("voice_fallback_calls").update({ recording_url: params.RecordingUrl ? `${params.RecordingUrl}.mp3` : null, outcome: "voicemail", updated_at: new Date().toISOString() }).eq("call_sid", sid);
        return new Response(null, { status: 204 });
      }
      case "vm-transcript": {
        const text = (params.TranscriptionText ?? "").trim();
        const { data: fb } = await admin.from("voice_fallback_calls").select("is_emergency, caller_phone").eq("call_sid", sid).maybeSingle();
        await upsertCall(admin, owner, sid, { caller_phone: fb?.caller_phone ?? params.From ?? null, summary: text || "Voicemail (transcription unavailable)", is_voicemail: true, is_emergency: !!fb?.is_emergency });
        if (contact.ownerPhone) {
          const msg = `${fb?.is_emergency ? "EMERGENCY voicemail" : "New voicemail"} from ${fb?.caller_phone ?? "unknown"}: ${text.slice(0, 220) || "(no transcript)"}`;
          const sent = await sendOwnerSms(admin, owner, contact.ownerPhone, msg, sid);
          if (!sent) await notifyInApp(admin, owner, "New voicemail", msg);
        } else {
          await notifyInApp(admin, owner, "New voicemail", text.slice(0, 300) || "Voicemail received");
        }
        return new Response(null, { status: 204 });
      }
      default:
        return xml(wrap("<Say>Sorry, an error occurred.</Say><Hangup/>"));
    }
  } catch (e) {
    // Last-resort net: even an internal error must not hang up on a caller with nothing said.
    console.error(JSON.stringify({ event: "voice_front_door_error", action, error: e instanceof Error ? e.message : String(e) }));
    return xml(wrap(`<Say>We are having technical difficulties. If this is an emergency, hang up and call 9 1 1. Please call back in a few minutes.</Say><Hangup/>`));
  }
});

type HookFor = (owner: string, extra?: Record<string, string>) => (a: string, p?: Record<string, string>) => string;

async function inbound(admin: ReturnType<typeof createClient>, params: Record<string, string>, hookFor: HookFor): Promise<Response> {
  const to = params.To ?? "", from = params.From ?? "", sid = params.CallSid ?? "";
  const { data: pn } = await admin.from("phone_numbers").select("account_id").eq("phone_number", to).maybeSingle();
  if (!pn?.account_id) {
    return xml(wrap(`<Say>We are unable to connect your call. If this is an emergency, hang up and call 9 1 1.</Say><Hangup/>`));
  }
  const owner = pn.account_id as string;

  // Carrier-forwarding wizard: does this inbound match a pending test? Then confirm audibly and finish.
  const matched = await recordWizardArrival(admin, owner, { to, from, forwardedFrom: params.ForwardedFrom ?? null });
  if (matched) return xml(wrap(`<Say>Vireek forwarding test successful. You can hang up now.</Say><Hangup/>`));

  const [{ level }, contact, chaos] = await Promise.all([effectiveLevel(admin, owner), loadOrgContact(admin, owner), activeChaos(admin)]);
  const ctx: FallbackCtx = { ...contact, hook: hookFor(owner), callerId: to };
  const sip = Deno.env.get("VOICE_ENGINE_SIP_URI");

  if (level <= 1 && sip && !chaos.has("engine_down")) {
    await admin.from("voice_fallback_calls").upsert({ user_id: owner, call_sid: sid, level, caller_phone: from, outcome: "entered" }, { onConflict: "call_sid", ignoreDuplicates: true });
    return xml(wrap(`<Dial timeout="15" answerOnBridge="true" action="${xmlEsc(ctx.hook("engine-done"))}"><Sip>${xmlEsc(sip)}</Sip></Dial>`));
  }
  if (level <= 1 && chaos.has("engine_down")) void recordOutcome(admin, { providerId: "vapi", capability: "voice_engine", ok: false, errorCode: "chaos", userId: owner });

  // Engine unavailable (by ladder, config, or chaos): serve at least L2.
  const served = Math.max(level, 2) as Level;
  await markFallback(admin, owner, sid, served, from);
  return xml(twimlForLevel(served, ctx));
}

async function markFallback(admin: ReturnType<typeof createClient>, owner: string, sid: string, level: Level, from?: string): Promise<void> {
  await admin.from("voice_fallback_calls").upsert(
    { user_id: owner, call_sid: sid, level, caller_phone: from ?? null, outcome: level === 3 ? "forwarded" : level === 4 ? "static" : "entered", updated_at: new Date().toISOString() },
    { onConflict: "call_sid" },
  );
}

async function upsertCall(admin: ReturnType<typeof createClient>, owner: string, sid: string, f: { caller_phone: string | null; summary: string; is_voicemail: boolean; is_emergency: boolean }): Promise<void> {
  // vapi_call_id carries a "twilio:" namespaced key purely for idempotency (unique index idx_calls_vapi_call_id_full).
  await admin.from("calls").upsert({ user_id: owner, vapi_call_id: `twilio:${sid}`, status: "new_lead", source_channel: "voice_fallback", ...f }, { onConflict: "vapi_call_id" });
}

async function raiseEmergency(admin: ReturnType<typeof createClient>, owner: string, sid: string, from: string | null, ownerPhone: string | null, why: string): Promise<void> {
  await admin.from("voice_fallback_calls").upsert({ user_id: owner, call_sid: sid, level: 2, caller_phone: from, outcome: "emergency_forwarded", is_emergency: true, updated_at: new Date().toISOString() }, { onConflict: "call_sid" });
  // calls.is_emergency = true fires the existing trigger_notify_emergency_call (dashboard alert).
  await upsertCall(admin, owner, sid, { caller_phone: from, summary: `Emergency (${why}) during degraded phone service`, is_voicemail: false, is_emergency: true });
  const msg = `EMERGENCY call from ${from ?? "unknown"}. The AI assistant is degraded; the caller is being connected to your on-call phone.`;
  const sent = ownerPhone ? await sendOwnerSms(admin, owner, ownerPhone, msg, sid) : false;
  if (!sent) await notifyInApp(admin, owner, "Emergency call", msg, "emergency");
}

// ------------------------------------------------------------------ carrier-forwarding wizard hooks
const rowToCheck = (r: Record<string, unknown>): ForwardCheck => ({
  id: String(r.id), kind: r.kind as ForwardCheck["kind"], businessNumber: String(r.business_number), vireekNumber: String(r.vireek_number),
  probeFrom: String(r.probe_from), startedAt: Date.parse(String(r.started_at)), expiresAt: Date.parse(String(r.expires_at)),
  outboundStatus: (r.outbound_status as ForwardCheck["outboundStatus"]) ?? null,
});

async function recordWizardArrival(admin: ReturnType<typeof createClient>, owner: string, a: { to: string; from: string; forwardedFrom: string | null }): Promise<boolean> {
  const { data } = await admin.from("voice_forward_checks").select("*").eq("user_id", owner).eq("status", "pending").eq("vireek_number", a.to).order("started_at", { ascending: false }).limit(3);
  let any = false;
  for (const row of data ?? []) {
    const check = rowToCheck(row);
    const arrival = { ...a, at: Date.now() };
    if (!arrivalMatches(check, arrival)) continue;
    const arrivals = [...((row.arrivals as unknown[]) ?? []), arrival];
    const status = evaluateForwardTest(check, [arrival], Date.now());
    await admin.from("voice_forward_checks").update({ arrivals, status, finished_at: status === "pending" ? null : new Date().toISOString() }).eq("id", check.id);
    any = any || check.kind === "forward_on";
  }
  return any;
}

async function checkStatus(admin: ReturnType<typeof createClient>, checkId: string, p: Record<string, string>): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(checkId)) return new Response(null, { status: 204 });
  const { data: row } = await admin.from("voice_forward_checks").select("*").eq("id", checkId).maybeSingle();
  if (!row || row.outbound_sid !== p.CallSid) return new Response(null, { status: 204 }); // only our own outbound call may update it
  const outbound = p.CallStatus ?? null;
  const check = { ...rowToCheck(row), outboundStatus: outbound as ForwardCheck["outboundStatus"] };
  const status = row.status === "pending" ? evaluateForwardTest(check, (row.arrivals as never[]) ?? [], Date.now()) : row.status;
  await admin.from("voice_forward_checks").update({ outbound_status: outbound, status, finished_at: status === "pending" ? null : new Date().toISOString() }).eq("id", checkId);
  return new Response(null, { status: 204 });
}
