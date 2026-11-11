// supabase/functions/_shared/fraud/inboundGate.ts
//
// Free-plan inbound minute gate for the earliest redirectable point of an inbound call (vapi-webhook
// assistant-request, once the account owner is known).
//
// Rules (deliberate):
//   * SHADOW is the default. In shadow the call is never changed and the check runs in the background, so it adds
//     no latency; a 'would_block' row (user_id, plan, used, included, call_id) goes to fraud_events.
//   * ENFORCE only when fraud_settings.enforcement_mode = 'enforce'. The blocking path is capped by a hard timeout.
//   * FAIL-OPEN everywhere: RPC error, unexpected shape, timeout, VIP lookup failure => the call continues and a
//     structured warning (ids only, no phone numbers) is logged.
//   * EMERGENCY SAFETY: callers whose number is an on-call / escalation / owner-flagged priority number, and
//     customers tagged VIP, are never blocked. Priority numbers are checked BEFORE any database work.
//   * Pure policy lives in SQL (fraud_inbound_allowance); nothing here changes plan numbers or semantics.

import type { FraudDb } from "./guard.ts";
import {
  checkInboundAllowanceDetailed,
  exhaustedResponse,
  type ExhaustedResponse,
  type InboundAllowance,
} from "./inbound.ts";

export type EnforcementMode = "shadow" | "enforce";

export const INBOUND_GATE_TIMEOUT_MS = 120;        // hard cap on the blocking (enforce) path
const BACKGROUND_TIMEOUT_MS = 2_000;               // shadow work runs after the response, so it may be slower
const EXHAUSTED_RESPONSE_TIMEOUT_MS = 1_500;       // building the forward/announce response (block path only)
export const INBOUND_EXHAUSTED_CODE = "INBOUND_FREE_EXHAUSTED";

export interface InboundGateLookups {
  /** fraud_settings.enforcement_mode (anything other than "enforce" is treated as shadow). */
  enforcementMode(): PromiseLike<string | null | undefined>;
  /** True when the caller is a customer of this owner tagged VIP. Only consulted when the call WOULD be blocked. */
  isVipCaller(): PromiseLike<boolean>;
  /** profiles.plan, only read when a would_block row is written. */
  plan(): PromiseLike<string | null | undefined>;
}

export interface InboundGateInput {
  userId: string;
  requestId: string;
  callId: string | null;
  callerNumber: string | null;
  /** Owner's forwarding number, used by exhaustedResponse(). */
  forwardingNumber: string | null;
  /** On-call numbers, escalation targets and any other owner-flagged priority numbers. Never blocked. */
  priorityNumbers: ReadonlyArray<string | null | undefined>;
  source?: string;
}

export interface InboundGateDeps {
  timeoutMs?: number;
  /** Schedule work that must outlive the response. Defaults to EdgeRuntime.waitUntil when present. */
  background?: (p: Promise<unknown>) => void;
  log?: (level: "info" | "warn", payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type InboundGateReason =
  | "allowed" | "emergency_bypass" | "vip_bypass" | "shadow" | "fail_open" | "exhausted";

export type InboundGateOutcome =
  | { action: "continue"; reason: Exclude<InboundGateReason, "exhausted">; mode: EnforcementMode; latencyMs: number }
  | { action: "respond"; reason: "exhausted"; mode: "enforce"; response: ExhaustedResponse; latencyMs: number };

// ---------------------------------------------------------------------------------------------------------------

type Settled<T> = { ok: true; value: T } | { ok: false; reason: "timeout" | "exception"; error?: string };

/** Runs `fn`, never throws, never waits longer than `ms`. */
function settle<T>(fn: () => PromiseLike<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms);
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn());
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, reason: "exception", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    p.then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      (e) => { clearTimeout(timer); resolve({ ok: false, reason: "exception", error: e instanceof Error ? e.message : String(e) }); },
    );
  });
}

const digitsOf = (v: string | null | undefined): string => String(v ?? "").replace(/\D/g, "");

/** Same matching rule as the SQL consent/marketing lookups: compare the last 10 digits. */
export function isPriorityCaller(caller: string | null | undefined, priority: ReadonlyArray<string | null | undefined>): boolean {
  const c = digitsOf(caller);
  if (c.length < 7) return false; // anonymous / withheld numbers never match
  const key = c.slice(-10);
  return priority.some((p) => {
    const d = digitsOf(p);
    return d.length >= 7 && d.slice(-10) === key;
  });
}

function defaultBackground(p: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  else void p;
}

function defaultLog(level: "info" | "warn", payload: Record<string, unknown>): void {
  (level === "warn" ? console.warn : console.log)(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------------------------------------------

export async function runInboundAllowanceGate(
  db: FraudDb,
  input: InboundGateInput,
  lookups: InboundGateLookups,
  deps: InboundGateDeps = {},
): Promise<InboundGateOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const timeoutMs = deps.timeoutMs ?? INBOUND_GATE_TIMEOUT_MS;
  const background = deps.background ?? defaultBackground;
  const log = deps.log ?? defaultLog;
  const source = input.source ?? "inbound-allowance-gate";
  const ids = { user_id: input.userId, request_id: input.requestId, call_id: input.callId };
  const lat = () => now() - t0;
  const failOpen = (mode: EnforcementMode, stage: string, why: string, error?: string): InboundGateOutcome => {
    log("warn", { event: "inbound_allowance_fail_open", stage, reason: why, error: error?.slice(0, 200), ...ids });
    return { action: "continue", reason: "fail_open", mode, latencyMs: lat() };
  };

  // 1. Emergency / on-call / priority numbers: no database work, never gated.
  if (isPriorityCaller(input.callerNumber, input.priorityNumbers)) {
    return { action: "continue", reason: "emergency_bypass", mode: "shadow", latencyMs: lat() };
  }

  // 2. Mode. Unknown, missing or unreadable => shadow (the safe default).
  const m = await settle(() => lookups.enforcementMode(), timeoutMs);
  const mode: EnforcementMode = m.ok && m.value === "enforce" ? "enforce" : "shadow";
  if (!m.ok) log("warn", { event: "inbound_allowance_mode_unavailable", reason: m.reason, error: m.error?.slice(0, 200), ...ids });

  // 3. Shadow: never touch the call, never add latency.
  if (mode === "shadow") {
    background(shadowEvaluate(db, input, lookups, source, log, ids).catch(() => undefined));
    return { action: "continue", reason: "shadow", mode, latencyMs: lat() };
  }

  // 4. Enforce.
  const r = await settle(() => checkInboundAllowanceDetailed(db, input.userId), timeoutMs);
  if (!r.ok) return failOpen(mode, "allowance", r.reason, r.error);
  if (r.value.failOpen) return failOpen(mode, "allowance", r.value.failOpen, r.value.error);
  if (r.value.allowance.allowed) return { action: "continue", reason: "allowed", mode, latencyMs: lat() };

  // Would block: rule out a VIP first. If that cannot be established, do not block.
  const vip = await settle(() => lookups.isVipCaller(), timeoutMs);
  if (!vip.ok) return failOpen(mode, "vip_lookup", vip.reason, vip.error);
  if (vip.value) return { action: "continue", reason: "vip_bypass", mode, latencyMs: lat() };

  const resp = await settle(() => exhaustedResponse(db, input.userId, input.forwardingNumber), EXHAUSTED_RESPONSE_TIMEOUT_MS);
  if (!resp.ok) return failOpen(mode, "exhausted_response", resp.reason, resp.error);

  background(
    recordEvent(db, input.userId, "denied", source, await planOf(lookups), r.value.allowance, input.callId, "enforce", log, ids).catch(() => undefined),
  );
  return { action: "respond", reason: "exhausted", mode: "enforce", response: resp.value, latencyMs: lat() };
}

// ---------------------------------------------------------------------------------------------------------------

async function planOf(lookups: InboundGateLookups): Promise<string> {
  const p = await settle(() => lookups.plan(), 500);
  return p.ok && typeof p.value === "string" && p.value ? p.value : "free";
}

async function shadowEvaluate(
  db: FraudDb, input: InboundGateInput, lookups: InboundGateLookups, source: string,
  log: NonNullable<InboundGateDeps["log"]>, ids: Record<string, unknown>,
): Promise<void> {
  const r = await settle(() => checkInboundAllowanceDetailed(db, input.userId), BACKGROUND_TIMEOUT_MS);
  if (!r.ok) { log("warn", { event: "inbound_allowance_fail_open", stage: "shadow_allowance", reason: r.reason, error: r.error?.slice(0, 200), ...ids }); return; }
  if (r.value.failOpen) { log("warn", { event: "inbound_allowance_fail_open", stage: "shadow_allowance", reason: r.value.failOpen, error: r.value.error?.slice(0, 200), ...ids }); return; }
  if (r.value.allowance.allowed) return;
  // A VIP would not be blocked in enforce mode, so it must not be counted as would_block either.
  const vip = await settle(() => lookups.isVipCaller(), BACKGROUND_TIMEOUT_MS);
  if (!vip.ok) { log("warn", { event: "inbound_allowance_fail_open", stage: "shadow_vip_lookup", reason: vip.reason, ...ids }); return; }
  if (vip.value) return;
  await recordEvent(db, input.userId, "would_block", source, await planOf(lookups), r.value.allowance, input.callId, "shadow", log, ids);
}

async function recordEvent(
  db: FraudDb, userId: string, kind: "would_block" | "denied", source: string, plan: string,
  a: InboundAllowance, callId: string | null, enforcement: EnforcementMode,
  log: NonNullable<InboundGateDeps["log"]>, ids: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await db.from("fraud_events").insert({
      user_id: userId, kind, code: INBOUND_EXHAUSTED_CODE, source, country: null,
      detail: { plan, used: a.used ?? null, included: a.included ?? null, mode: a.mode ?? null, enforcement, call_id: callId },
    });
    if (error) log("warn", { event: "inbound_allowance_record_failed", error: error.message.slice(0, 200), ...ids });
  } catch (e) {
    log("warn", { event: "inbound_allowance_record_failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 200), ...ids });
  }
}
