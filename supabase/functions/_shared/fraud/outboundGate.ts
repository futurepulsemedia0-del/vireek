// supabase/functions/_shared/fraud/outboundGate.ts
//
// The ONE adapter every customer-driven outbound sender (campaign / follow-up / workflow SMS + calls, speed-to-lead,
// customer notifications, power dialer, onboarding demo calls) uses to reach guardOutbound() BEFORE any Twilio / Vapi
// request. It adds what the raw guard does not give a caller:
//
//   * a typed, caller-friendly block result (code, message, httpStatus, retryable, retryAfterSeconds, retryAt),
//   * the staged-rollout switch (rollout: "outbound" -> fraud_settings.outbound_guard_mode, default 'shadow'),
//   * the provider duration cap helper (PLAN_LIMITS[plan].maxCallSeconds, emergency legs never lowered),
//   * reservation lifecycle helpers (attach the provider call id, or release the reservation when the provider
//     never placed the call), so reserved cost is always settled.
//
// Pure module: no Deno globals, no I/O except through the injected FraudDb, so Vitest and edge functions share it.
//
// PURPOSE SEMANTICS (owned by guard.ts, repeated here because callers choose the value):
//   "marketing"  campaigns / promotions / review requests. Consent ledger + campaign approval + only MARKETING_CAP_SHARE
//                of the shared daily caps.
//   "service"    transactional customer messages and calls (appointment confirmations / reminders, payment links,
//                refunds, signatures). No marketing gate; full daily caps. Needs an unlocked (verified) account.
//   "emergency"  dispatch alerts and emergency hand-offs to a DOMESTIC number: never blocked by kill switches,
//                throttling, suspension, verification or spend caps; only the separate runaway ceiling applies.
//   "otp"        verification codes (handled by the OTP flow, not by this adapter's callers).

import {
  attachCallRef,
  guardDestination,
  guardOutbound,
  settleCall,
  type FraudDb,
  type GuardCode,
  type GuardKind,
} from "./guard.ts";
import { PLAN_LIMITS, normalizePlan, type Purpose } from "./planLimits.ts";

export type { FraudDb, GuardCode, Purpose };

/** Treat any supabase-js client as the narrow FraudDb the guard needs. */
export const asFraudDb = (admin: unknown): FraudDb => admin as FraudDb;

export interface BlockedSend {
  code: GuardCode;
  /** Human-readable, safe to show to the account owner. */
  message: string;
  httpStatus: 403 | 429 | 503;
  /** true = the SAME send may succeed later without anyone changing anything (a cap resets, an outage ends). */
  retryable: boolean;
  /** Seconds the caller must wait before trying again; null when a retry cannot help. */
  retryAfterSeconds: number | null;
  /** ISO timestamp of now + retryAfterSeconds; null when not retryable. */
  retryAt: string | null;
}

export type OutboundGate =
  | {
      allowed: true;
      /** Canonical E.164 when the guard evaluated the number, otherwise (shadow denial) the number as given. */
      e164: string;
      country: string | null;
      /** Provider duration cap for this account's plan (seconds). Always PLAN_LIMITS[plan].maxCallSeconds. */
      maxCallSeconds: number;
      reservedCents: number;
      /** Pass to settleOutboundCall() once the provider returns its call id. */
      eventRef: string | null;
      emergency: boolean;
      /** Set in shadow mode: the guard WOULD have blocked this send with this code. */
      shadowDenied?: GuardCode;
    }
  | { allowed: false; blocked: BlockedSend };

export interface OutboundRequest {
  userId: string;
  kind: GuardKind;
  to: string;
  purpose: Purpose;
  /** Calling function / module name for the audit trail, e.g. "followup-agent-dispatcher". */
  source: string;
  /** Campaign key for new-account campaign approval (marketing only). Defaults to `source`. */
  campaign?: string;
  now?: Date;
}

// ---- retry policy -------------------------------------------------------------------------------------------------

const RETRY_SECONDS: Partial<Record<GuardCode, number>> = {
  GUARD_UNAVAILABLE: 120,
  KILL_SWITCH: 900,
  CAMPAIGN_APPROVAL_REQUIRED: 6 * 3600,
};
const DAILY_CODES: ReadonlySet<GuardCode> = new Set<GuardCode>(["DAILY_CALLS", "DAILY_SMS", "DAILY_COST"]);

export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5); // +5s: be past the reset
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

export function buildBlocked(code: GuardCode, message: string, httpStatus: 403 | 429 | 503, now: Date = new Date()): BlockedSend {
  const seconds = DAILY_CODES.has(code) ? secondsUntilNextUtcDay(now) : RETRY_SECONDS[code] ?? null;
  return {
    code,
    message,
    httpStatus,
    retryable: seconds !== null,
    retryAfterSeconds: seconds,
    retryAt: seconds === null ? null : new Date(now.getTime() + seconds * 1000).toISOString(),
  };
}

// ---- the gate -----------------------------------------------------------------------------------------------------

/**
 * Evaluate ONE customer-driven outbound send. Call it immediately before the provider request, after the caller's own
 * compliance gates (DNC, quiet hours, A2P). It reserves budget atomically; call settleOutboundCall() /
 * releaseOutboundReservation() afterwards for calls.
 *
 * It never throws: an unexpected failure becomes a retryable GUARD_UNAVAILABLE block (fail closed, as guard.ts does).
 */
export async function gateCustomerOutbound(db: FraudDb, req: OutboundRequest): Promise<OutboundGate> {
  const now = req.now ?? new Date();
  try {
    const g = await guardOutbound(db, {
      userId: req.userId, kind: req.kind, to: req.to, purpose: req.purpose, source: req.source,
      campaign: req.campaign, now, rollout: "outbound",
    });
    if (!g.ok) return { allowed: false, blocked: buildBlocked(g.code, g.message, g.httpStatus, now) };
    return {
      allowed: true,
      e164: g.e164 ?? req.to,
      country: g.country,
      maxCallSeconds: g.maxCallSeconds,
      reservedCents: g.reservedCents,
      eventRef: g.eventRef ?? null,
      emergency: g.emergency,
      ...(g.shadowDenied ? { shadowDenied: g.shadowDenied } : {}),
    };
  } catch {
    return { allowed: false, blocked: buildBlocked("GUARD_UNAVAILABLE", "Safety checks are temporarily unavailable. Try again shortly.", 503, now) };
  }
}

/**
 * Destination-only gate for hops that already hold a reservation or dial the owner's own number (demo / test calls,
 * the contact leg of a bridge). Honors the same shadow/enforce rollout switch.
 */
export async function gateDestinationOnly(db: FraudDb, userId: string, to: string, source: string, now: Date = new Date()): Promise<OutboundGate> {
  try {
    const g = await guardDestination(db, userId, to, { rollout: "outbound", source });
    if (!g.ok) return { allowed: false, blocked: buildBlocked(g.code, g.message, g.httpStatus, now) };
    return {
      allowed: true, e164: g.e164 ?? to, country: g.country, maxCallSeconds: g.maxCallSeconds, reservedCents: 0, eventRef: null,
      emergency: g.emergency, ...(g.shadowDenied ? { shadowDenied: g.shadowDenied } : {}),
    };
  } catch {
    return { allowed: false, blocked: buildBlocked("GUARD_UNAVAILABLE", "Safety checks are temporarily unavailable. Try again shortly.", 503, now) };
  }
}

// ---- reservation lifecycle ----------------------------------------------------------------------------------------

/** The provider accepted the call: link its id to the reservation so the real duration settles it (settleCall). */
export async function attachOutboundCall(db: FraudDb, gate: OutboundGate, providerCallId: string | null | undefined): Promise<void> {
  if (!gate.allowed) return;
  await attachCallRef(db, gate.eventRef, providerCallId);
}

/**
 * The provider did NOT place the call (HTTP error, network error, missing config after the gate): release the worst-case
 * reservation in full. Implemented with the existing attach + settle(0) RPCs so no new SQL is needed:
 * a zero-second call refunds the whole reservation, and the synthetic id can never match a real provider id.
 */
export async function releaseOutboundReservation(db: FraudDb, gate: OutboundGate): Promise<void> {
  if (!gate.allowed || !gate.eventRef) return;
  const id = `unplaced:${gate.eventRef}`;
  await attachCallRef(db, gate.eventRef, id);
  await settleCall(db, id, 0);
}

export { settleCall };

// ---- duration cap -------------------------------------------------------------------------------------------------

/**
 * maxDurationSeconds for a provider payload.
 *  - no existing limit            -> the plan cap
 *  - normal leg with a limit      -> the lower of the two (a 45 s test call stays 45 s)
 *  - emergency / transfer leg     -> keeps its existing limit when that is higher (never cut a live hand-off short)
 */
export function capDurationSeconds(planCapSeconds: number, existingSeconds?: number | null, opts: { emergency?: boolean } = {}): number {
  const cap = Math.max(10, Math.floor(planCapSeconds)); // Vapi rejects < 10 s
  if (existingSeconds == null || !Number.isFinite(existingSeconds) || existingSeconds <= 0) return cap;
  const existing = Math.floor(existingSeconds);
  return opts.emergency ? Math.max(existing, cap) : Math.min(existing, cap);
}

/** Plan cap for an unknown / missing plan string: the most restrictive plan (normalizePlan). */
export function planMaxCallSeconds(plan: string | null | undefined): number {
  return PLAN_LIMITS[normalizePlan(plan)].maxCallSeconds;
}

/**
 * Cap for INBOUND calls and assistant configuration. Returns null when the account's plan cannot be read, so inbound
 * answering never changes (fail open: a fraud-store hiccup must not cut live customer calls short). `enforce` is true
 * only when fraud_settings.outbound_guard_mode = 'enforce' and the global switch is on.
 */
export async function resolveInboundCap(db: FraudDb, userId: string): Promise<{ seconds: number; enforce: boolean } | null> {
  try {
    const { data, error } = await db.rpc("fraud_guard_context", { p_user: userId });
    if (error || !data || typeof data !== "object") return null;
    const ctx = data as { plan?: string; enforce?: boolean; outbound_guard_mode?: string };
    return { seconds: planMaxCallSeconds(ctx.plan), enforce: ctx.enforce !== false && ctx.outbound_guard_mode === "enforce" };
  } catch {
    return null;
  }
}

/** Standard JSON body for HTTP callers that must tell their client why a send was blocked. */
export function blockedBody(b: BlockedSend): { error: GuardCode; message: string; retryable: boolean; retry_after_seconds: number | null } {
  return { error: b.code, message: b.message, retryable: b.retryable, retry_after_seconds: b.retryAfterSeconds };
}
