// supabase/functions/_shared/bank/provider/health.ts
//
// Pure provider-health state machine + circuit breaker. No I/O, no clock: callers pass `now`.
//
//   healthy ──(≥ degradedAfter consecutive provider-side failures)──▶ degraded
//   degraded ──(≥ downAfter)──▶ down  (circuit OPEN: calls are refused until circuitOpenUntil)
//   down ──(window elapsed)──▶ one PROBE call is admitted (half-open); success ⇒ healthy, failure ⇒ down again
//
// Only provider-side signals move the machine (see HEALTH_AFFECTING_KINDS). A single customer whose
// bank asks them to sign in again must never mark Plaid "degraded" for everybody.

import { HEALTH_AFFECTING_KINDS, type ProviderErrorKind } from "./types.ts";

export type HealthState = "healthy" | "degraded" | "down";

export interface HealthSnapshot {
  state: HealthState;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorKind: ProviderErrorKind | null;
  circuitOpenUntil: string | null;
}

export interface HealthPolicy {
  degradedAfter: number;
  downAfter: number;
  baseOpenMs: number;
  maxOpenMs: number;
  /** While a probe is in flight, other callers are refused for this long. */
  probeLeaseMs: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  degradedAfter: 2,
  downAfter: 5,
  baseOpenMs: 30_000,
  maxOpenMs: 15 * 60_000,
  probeLeaseMs: 30_000,
};

export const INITIAL_HEALTH: HealthSnapshot = {
  state: "healthy",
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastErrorKind: null,
  circuitOpenUntil: null,
};

/**
 * Errors that prove the provider answered us, even though the answer was "no" for this item.
 * `invalid_request` / `not_configured` are OUR faults and prove nothing either way.
 */
const REACHABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "auth_required",
  "product_not_ready",
  "institution_unavailable",
  "pagination_mutation",
]);

const iso = (ms: number) => new Date(ms).toISOString();

export function onSuccess(prev: HealthSnapshot, now: Date): HealthSnapshot {
  return { ...prev, state: "healthy", consecutiveFailures: 0, lastSuccessAt: now.toISOString(), circuitOpenUntil: null };
}

export function onFailure(
  prev: HealthSnapshot,
  kind: ProviderErrorKind,
  now: Date,
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): HealthSnapshot {
  if (REACHABLE_KINDS.has(kind)) return onSuccess(prev, now);
  if (!HEALTH_AFFECTING_KINDS.has(kind)) return prev; // our own fault: no signal about the provider
  const n = prev.consecutiveFailures + 1;
  const state: HealthState = n >= policy.downAfter ? "down" : n >= policy.degradedAfter ? "degraded" : "healthy";
  let circuitOpenUntil: string | null = null;
  if (state === "down") {
    const exp = Math.min(n - policy.downAfter, 20); // clamp the exponent before multiplying
    circuitOpenUntil = iso(now.getTime() + Math.min(policy.maxOpenMs, policy.baseOpenMs * 2 ** exp));
  }
  return { state, consecutiveFailures: n, lastSuccessAt: prev.lastSuccessAt, lastFailureAt: now.toISOString(), lastErrorKind: kind, circuitOpenUntil };
}

export type Admission =
  | { allowed: true; probe: false }
  | { allowed: true; probe: true; lease: HealthSnapshot }
  | { allowed: false; retryAfterMs: number };

export function admit(prev: HealthSnapshot, now: Date, policy: HealthPolicy = DEFAULT_HEALTH_POLICY): Admission {
  if (prev.state !== "down" || !prev.circuitOpenUntil) return { allowed: true, probe: false };
  const until = Date.parse(prev.circuitOpenUntil);
  if (Number.isNaN(until)) return { allowed: true, probe: false }; // corrupt row must not lock everyone out
  if (now.getTime() < until) return { allowed: false, retryAfterMs: until - now.getTime() };
  return { allowed: true, probe: true, lease: { ...prev, circuitOpenUntil: iso(now.getTime() + policy.probeLeaseMs) } };
}

// ---------------------------------------------------------------------------------------------
// What the user sees. Pure so UI, API and tests agree.
// ---------------------------------------------------------------------------------------------
export type Freshness = "fresh" | "stale" | "never";

export interface ProviderStatusView {
  providerState: HealthState;
  /** True when Vireek is serving previously synced data instead of live data. */
  servingCachedData: boolean;
  freshness: Freshness;
  lastSyncedAt: string | null;
  /** Stable i18n key under the `bank` namespace; no prose is generated here. */
  messageKey: "bank.status.ok" | "bank.status.degraded" | "bank.status.down" | "bank.status.stale" | "bank.status.never";
  retryAfterSeconds: number | null;
}

export const DEFAULT_STALE_AFTER_MS = 36 * 3_600_000;

export function buildStatusView(
  health: HealthSnapshot,
  lastSyncedAt: string | null,
  now: Date,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): ProviderStatusView {
  const last = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
  const freshness: Freshness = Number.isNaN(last) ? "never" : now.getTime() - last > staleAfterMs ? "stale" : "fresh";
  const open = health.circuitOpenUntil ? Date.parse(health.circuitOpenUntil) : NaN;
  const retryAfterSeconds = health.state === "down" && !Number.isNaN(open) && open > now.getTime() ? Math.ceil((open - now.getTime()) / 1000) : null;
  const servingCachedData = health.state !== "healthy" && freshness !== "never";
  const messageKey: ProviderStatusView["messageKey"] =
    health.state === "down" ? "bank.status.down"
    : health.state === "degraded" ? "bank.status.degraded"
    : freshness === "never" ? "bank.status.never"
    : freshness === "stale" ? "bank.status.stale"
    : "bank.status.ok";
  return { providerState: health.state, servingCachedData, freshness, lastSyncedAt, messageKey, retryAfterSeconds };
}
