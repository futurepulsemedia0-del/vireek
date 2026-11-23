// supabase/functions/_shared/shadow/liveListen.ts
//
// Shadow Mode, Mode B (live-listen) — pure rules. No I/O, no clock (callers pass `nowIso`), no randomness.
// Design: docs/SHADOW_LIVE_LISTEN_DESIGN.md.
//
// SAFETY MODEL
//   * Live-listen is OFF unless ALL of these hold (fail closed on anything unknown):
//       kill switch `shadow_live_listen` not stopped  ->  flag `shadow_live_listen` ON for the tenant
//       -> trial active and not expired  ->  inbound call  ->  consent gate (evaluateConsent, live mode)
//       -> jurisdiction explicitly cleared by the PLATFORM (counsel_cleared_states), never by the owner.
//   * The audio fork is ONE-WAY: only the caller's inbound track is sent to us. Nothing is ever sent back to the
//     call (no <Say>/<Play>/<Dial>/<Connect>), so Sarah cannot speak or act. `assertOneWayForkTwiml` is the guard.
//   * Raw audio is never persisted by this module family. Only a metadata ledger row is written (shadow_live_sessions).
//
// NOT LEGAL ADVICE. Every consent rule below is a conservative engineering default marked [COUNSEL] in the design doc.

import { evaluateConsent, type ConsentConfig, type ConsentDecision } from "./logic.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Feature flag key (config/flags.registry.json) AND kill-switch capability key. Same string, two mechanisms. */
export const LIVE_FLAG_KEY = "shadow_live_listen";
export const LIVE_KILL_SWITCH = "shadow_live_listen";
/**
 * Marker the PLATFORM puts into shadow_trials.counsel_cleared_states to clear NANP callers whose area code is NOT on the
 * all-party heuristic list (recordingConsent.ts). The list is "commonly cited", not exhaustive, so live-listen does not
 * treat "unlisted" as "one-party". [COUNSEL]
 */
export const NANP_UNLISTED_CLEARANCE = "NANP_UNLISTED";
/** Hard ceiling for one live session. A stream still open after this is stopped. */
export const LIVE_SESSION_MAX_SECONDS = 2 * 60 * 60;
/** How often an open stream must re-check flag + kill switch. The guard itself caches for 15 s. */
export const LIVE_RECHECK_SECONDS = 20;
/** Audit events (no PII) outlive session rows. [COUNSEL] — confirm. */
export const LIVE_EVENT_RETENTION_DAYS = 365;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type LiveDirection = "inbound" | "outbound";

export type LiveBlockReason =
  | "kill_switch"
  | "flag_off"
  | "trial_inactive"
  | "trial_expired"
  | "outbound_unsupported"
  | "nanp_unlisted_not_cleared"
  | Exclude<ConsentDecision["reason"], "ok">;

export interface LiveTrialView {
  status: string;
  endsAt: string;
}

export interface LiveGateInput {
  /** Kill-switch guard result. The guard already fails closed, so `true` also covers "unknown". */
  killSwitchStopped: boolean;
  /** Flag evaluated server-side (createFlagEvaluator; unknown => false). */
  flagOn: boolean;
  trial: LiveTrialView | null;
  nowIso: string;
  direction: LiveDirection;
  callerPhone: string | null;
  consent: ConsentConfig;
}

export interface LiveGateDecision {
  allowed: boolean;
  reason: "ok" | LiveBlockReason;
  /** Jurisdiction recorded on the ledger: an all-party state code, or NANP_UNLISTED. Null when undeterminable/blocked early. */
  jurisdiction: string | null;
  needsLegalReview: boolean;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
const blocked = (reason: LiveBlockReason, jurisdiction: string | null = null, needsLegalReview = false): LiveGateDecision => ({
  allowed: false, reason, jurisdiction, needsLegalReview,
});

/**
 * Order matters and is part of the contract (tests pin it):
 * kill switch -> flag -> trial -> direction -> consent -> NANP-unlisted clearance.
 * The cheap, global stops come first so a stopped capability never reads tenant data.
 */
export function evaluateLiveListenGate(input: LiveGateInput): LiveGateDecision {
  if (input.killSwitchStopped) return blocked("kill_switch");
  if (!input.flagOn) return blocked("flag_off");

  if (!input.trial || input.trial.status !== "active") return blocked("trial_inactive");
  const ends = Date.parse(input.trial.endsAt);
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(ends) || !Number.isFinite(now) || now >= ends) return blocked("trial_expired");

  if (input.direction !== "inbound") return blocked("outbound_unsupported");

  const consent = evaluateConsent("live_listen", input.callerPhone, input.consent);
  if (!consent.allowed) {
    return blocked(consent.reason as LiveBlockReason, consent.state, consent.needsLegalReview);
  }
  // evaluateConsent allowed it: the number is NANP and either an all-party state that counsel cleared (state !== null)
  // or an area code that is not on the all-party list (state === null).
  if (consent.state === null) {
    if (!input.consent.counselClearedStates.includes(NANP_UNLISTED_CLEARANCE)) {
      return blocked("nanp_unlisted_not_cleared", NANP_UNLISTED_CLEARANCE, true);
    }
    return { allowed: true, reason: "ok", jurisdiction: NANP_UNLISTED_CLEARANCE, needsLegalReview: true };
  }
  return { allowed: true, reason: "ok", jurisdiction: consent.state, needsLegalReview: consent.needsLegalReview };
}

/** Consent facts copied onto the ledger row (booleans only — no phone number, no names). */
export function consentSnapshot(cfg: ConsentConfig): Record<string, boolean> {
  return {
    replay_attested: cfg.replayAttested,
    caller_disclosure_configured: cfg.callerDisclosureConfigured,
    staff_notified: cfg.staffNotified,
    telephony_supports_fork: cfg.telephonySupportsFork,
  };
}

/** Last four digits only; the full number is never stored. */
export function last4(phone: string | null): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

// ---------------------------------------------------------------------------
// Open-stream rule (used by the future stream receiver on every re-check tick)
// ---------------------------------------------------------------------------
export type StreamStopReason = "kill_switch" | "flag_off" | "max_duration" | "bad_clock";

export function shouldContinueStreaming(input: {
  killSwitchStopped: boolean;
  flagOn: boolean;
  elapsedSeconds: number;
}): { continue: boolean; reason: "ok" | StreamStopReason } {
  if (input.killSwitchStopped) return { continue: false, reason: "kill_switch" };
  if (!input.flagOn) return { continue: false, reason: "flag_off" };
  if (!Number.isFinite(input.elapsedSeconds) || input.elapsedSeconds < 0) return { continue: false, reason: "bad_clock" };
  if (input.elapsedSeconds >= LIVE_SESSION_MAX_SECONDS) return { continue: false, reason: "max_duration" };
  return { continue: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// One-way fork directive (Twilio <Start><Stream>) — [VERIFY] against the current Twilio docs before enabling
// ---------------------------------------------------------------------------
const xmlAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export interface ForkOptions {
  /** wss:// URL of OUR stream receiver. */
  streamUrl: string;
  /** Exact host names the receiver may live on (from platform config). */
  allowedHosts: readonly string[];
  /** shadow_live_sessions.id — lets the receiver look up and re-verify the session. */
  sessionId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildOneWayForkTwiml(o: ForkOptions): string {
  let u: URL;
  try { u = new URL(o.streamUrl); } catch { throw new Error("stream url is not a valid URL"); }
  if (u.protocol !== "wss:") throw new Error("stream url must use wss://");
  if (u.username || u.password || u.search || u.hash) throw new Error("stream url must not carry credentials, query or fragment");
  if (!o.allowedHosts.includes(u.hostname)) throw new Error("stream host is not on the allow-list");
  if (!UUID_RE.test(o.sessionId)) throw new Error("session id must be a uuid");
  // <Start><Stream> is the unidirectional form; track is pinned to the caller's inbound audio only.
  return (
    `<Start><Stream url="${xmlAttr(u.toString())}" track="inbound_track">` +
    `<Parameter name="session_id" value="${xmlAttr(o.sessionId)}"/>` +
    `</Stream></Start>`
  );
}

const FORBIDDEN_TWIML = /<\s*(Connect|Say|Play|Dial|Gather|Record|Sms|Message|Redirect|Refer|Pay|Enqueue|Conference)\b|outbound_track|both_tracks|<\s*Stop\b/i;

/** Throws unless the fragment is exactly the unidirectional, inbound-only fork. Run on every directive before it leaves. */
export function assertOneWayForkTwiml(xml: string): void {
  if (!/^<Start><Stream url="wss:\/\/[^"]+" track="inbound_track">[\s\S]*<\/Stream><\/Start>$/.test(xml)) {
    throw new Error("fork directive must be <Start><Stream track=inbound_track> over wss://");
  }
  if (FORBIDDEN_TWIML.test(xml)) throw new Error("fork directive contains a verb that could speak, act or send audio back");
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
/** Ledger rows follow the trial's retention window (already clamped 1..90 by the DB). */
export function sessionPurgeAfter(startedAtIso: string, retentionDays: number): string {
  const t = Date.parse(startedAtIso);
  if (!Number.isFinite(t)) throw new Error("invalid start time");
  const days = Math.min(90, Math.max(1, Math.trunc(Number.isFinite(retentionDays) ? retentionDays : 30)));
  return new Date(t + days * 86_400_000).toISOString();
}
