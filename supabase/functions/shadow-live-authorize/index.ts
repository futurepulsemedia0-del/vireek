// supabase/functions/shadow-live-authorize/index.ts
//
// Shadow Mode live-listen gatekeeper (Mode B). DEFAULT OFF: with flag `shadow_live_listen` OFF (the shipped state) every
// authorize request answers {authorized:false, reason:"flag_off"} and writes nothing.
//
// Caller: server-to-server only (the telephony webhook), header x-shadow-live-secret = SHADOW_LIVE_SECRET.
//   POST {action:"authorize", user_id, call_ref, caller_phone, direction}  -> {authorized, reason, session_id?, twiml?}
//   POST {action:"end", session_id, reason}                                 -> {ended}
//   POST {action:"purge"}   (scheduler, e.g. hourly)                        -> {purged_sessions}
//
// It never speaks to a caller, sends SMS/email, books, dials or transfers; it returns a one-way, inbound-only fork
// directive that the telephony layer MAY apply. The stream RECEIVER (speech-to-text -> Shadow Cards) is not built yet
// (docs/SHADOW_LIVE_LISTEN_DESIGN.md §10). This function must not import notify / dispatch / telephony modules.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHADOW_LIVE_SECRET,
//          SHADOW_LIVE_STREAM_URL (wss://…), SHADOW_LIVE_STREAM_HOSTS (comma-separated exact host names).
// Deploy:  supabase functions deploy shadow-live-authorize   (verify_jwt = false in config.toml; the secret is the control)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { timingSafeEqualStr } from "../_shared/voice-hardening/webhookAuth.ts";
import { createFlagEvaluator } from "../_shared/flags/flagEval.ts";
import { getKillSwitchGuard } from "../_shared/flags/killSwitch.ts";
import {
  LIVE_FLAG_KEY, LIVE_KILL_SWITCH, NANP_UNLISTED_CLEARANCE,
  assertOneWayForkTwiml, buildOneWayForkTwiml, consentSnapshot, evaluateLiveListenGate, last4,
  type LiveDirection,
} from "../_shared/shadow/liveListen.ts";
import type { ConsentConfig } from "../_shared/shadow/logic.ts";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

interface TrialRow {
  id: string; status: string; ends_at: string; retention_days: number;
  replay_attested: boolean; caller_disclosure_configured: boolean; staff_notified: boolean;
  telephony_supports_fork: boolean; counsel_cleared_states: string[] | null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const expected = Deno.env.get("SHADOW_LIVE_SECRET") ?? "";
  const provided = req.headers.get("x-shadow-live-secret") ?? "";
  if (!expected || expected.length < 24) return json({ error: "Not configured." }, 503); // refuse to run without a strong secret
  if (!timingSafeEqualStr(provided, expected)) return json({ error: "Unauthorized." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (!body || typeof body !== "object") return json({ error: "Invalid body." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const action = body.action;

  if (action === "purge") {
    const { data, error } = await admin.rpc("shadow_live_purge_expired");
    if (error) return json({ error: "purge_failed" }, 500);
    return json({ purged_sessions: typeof data === "number" ? data : 0 });
  }

  if (action === "end") {
    if (!isUuid(body.session_id)) return json({ error: "session_id must be a uuid." }, 400);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 64) : "completed";
    const { data, error } = await admin.rpc("shadow_live_end", { p_session_id: body.session_id, p_reason: reason });
    if (error) return json({ error: "end_failed" }, 500);
    return json({ ended: data === true });
  }

  if (action !== "authorize") return json({ error: "Unknown action." }, 400);

  // ---- authorize -------------------------------------------------------------------------------------------------
  if (!isUuid(body.user_id)) return json({ error: "user_id must be a uuid." }, 400);
  const callRef = typeof body.call_ref === "string" ? body.call_ref.trim() : "";
  if (callRef.length < 1 || callRef.length > 128) return json({ error: "call_ref must be 1-128 characters." }, 400);
  const callerPhone = typeof body.caller_phone === "string" && body.caller_phone.length <= 32 ? body.caller_phone : null;
  const direction: LiveDirection = body.direction === "outbound" ? "outbound" : "inbound";
  const userId = body.user_id;

  // 1) Global/per-account stop and the flag come first: a stopped or OFF capability reads no tenant data and writes nothing.
  const killStopped = await getKillSwitchGuard(admin).isStopped(LIVE_KILL_SWITCH, userId);
  const flagOn = killStopped ? false : await createFlagEvaluator({ rpc: admin.rpc.bind(admin) }).isOn(LIVE_FLAG_KEY, userId, false);
  if (killStopped || !flagOn) {
    return json({ authorized: false, reason: killStopped ? "kill_switch" : "flag_off" });
  }

  // 2) Trial + consent facts (platform-set columns are read here, never taken from the request).
  const { data: trial, error: trialErr } = await admin
    .from("shadow_trials")
    .select("id,status,ends_at,retention_days,replay_attested,caller_disclosure_configured,staff_notified,telephony_supports_fork,counsel_cleared_states")
    .eq("user_id", userId)
    .maybeSingle<TrialRow>();
  if (trialErr) return json({ authorized: false, reason: "trial_inactive" }); // fail closed

  const consent: ConsentConfig = {
    replayAttested: trial?.replay_attested === true,
    callerDisclosureConfigured: trial?.caller_disclosure_configured === true,
    staffNotified: trial?.staff_notified === true,
    telephonySupportsFork: trial?.telephony_supports_fork === true,
    counselClearedStates: Array.isArray(trial?.counsel_cleared_states) ? trial!.counsel_cleared_states! : [],
  };

  const decision = evaluateLiveListenGate({
    killSwitchStopped: false, flagOn: true,
    trial: trial ? { status: trial.status, endsAt: trial.ends_at } : null,
    nowIso: new Date().toISOString(), direction, callerPhone, consent,
  });

  if (!trial) return json({ authorized: false, reason: decision.reason });

  // 3) Receiver configuration must be complete before anything is authorized.
  const streamUrl = Deno.env.get("SHADOW_LIVE_STREAM_URL") ?? "";
  const allowedHosts = (Deno.env.get("SHADOW_LIVE_STREAM_HOSTS") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const receiverConfigured = streamUrl !== "" && allowedHosts.length > 0;

  const recordBlocked = async (reason: string) => {
    // Audit consent-level blocks (flag is ON so this is rare and meaningful). Never store the full number.
    await admin.rpc("shadow_live_record", {
      p_user_id: userId, p_trial_id: trial.id, p_call_ref: callRef, p_caller_last4: last4(callerPhone),
      p_jurisdiction: decision.jurisdiction, p_decision: "blocked", p_reason: reason,
      p_consent: consentSnapshot(consent), p_retention_days: trial.retention_days,
    });
  };

  if (!decision.allowed) {
    await recordBlocked(decision.reason);
    return json({ authorized: false, reason: decision.reason, needs_legal_review: decision.needsLegalReview });
  }
  if (!receiverConfigured) {
    await recordBlocked("receiver_not_configured");
    return json({ authorized: false, reason: "receiver_not_configured" });
  }

  const { data: sessionId, error: recErr } = await admin.rpc("shadow_live_record", {
    p_user_id: userId, p_trial_id: trial.id, p_call_ref: callRef, p_caller_last4: last4(callerPhone),
    p_jurisdiction: decision.jurisdiction ?? NANP_UNLISTED_CLEARANCE, p_decision: "authorized", p_reason: null,
    p_consent: consentSnapshot(consent), p_retention_days: trial.retention_days,
  });
  if (recErr || !isUuid(sessionId)) return json({ authorized: false, reason: "record_failed" }); // DB backstop refused => fail closed

  let twiml: string;
  try {
    twiml = buildOneWayForkTwiml({ streamUrl, allowedHosts, sessionId });
    assertOneWayForkTwiml(twiml);
  } catch {
    await admin.rpc("shadow_live_end", { p_session_id: sessionId, p_reason: "fork_directive_invalid" });
    return json({ authorized: false, reason: "receiver_not_configured" });
  }
  return json({ authorized: true, reason: "ok", session_id: sessionId, twiml });
});
