// Circuit breaker + health score. Pure and STATELESS-friendly: edge functions are short-lived, so the
// breaker is a function (previous persisted state + recent outcomes + now) -> next state. The tick
// job persists the result in voice_provider_health; call paths only read it.

export type BreakerState = "closed" | "open" | "half_open";

export interface Outcome {
  at: number; // epoch ms
  ok: boolean;
  latencyMs?: number | null;
}

export interface BreakerConfig {
  windowMs: number;
  minSamples: number;
  /** Open when failures / samples >= this. */
  errorRateThreshold: number;
  /** Open when the window p95 latency >= this (ms). null disables the latency rule. */
  p95LatencyMs: number | null;
  /** First cool-down; doubles on each consecutive re-open up to maxCooldownMs. */
  baseCooldownMs: number;
  maxCooldownMs: number;
  /** Successful probes required in half_open to close. */
  successesToClose: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  windowMs: 5 * 60_000,
  minSamples: 5,
  errorRateThreshold: 0.3,
  p95LatencyMs: 4_000,
  baseCooldownMs: 30_000,
  maxCooldownMs: 10 * 60_000,
  successesToClose: 3,
};

export interface BreakerSnapshot {
  state: BreakerState;
  openedAt: number | null;
  consecutiveOpens: number;
  /** Outcomes counted since entering half_open (strictly after halfOpenAt). */
  halfOpenAt: number | null;
}

export const INITIAL_BREAKER: BreakerSnapshot = { state: "closed", openedAt: null, consecutiveOpens: 0, halfOpenAt: null };

export interface WindowStats {
  samples: number;
  failures: number;
  errorRate: number;
  p95LatencyMs: number | null;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function windowStats(outcomes: Outcome[], now: number, windowMs: number): WindowStats {
  const inWin = outcomes.filter((o) => o.at > now - windowMs && o.at <= now);
  const failures = inWin.filter((o) => !o.ok).length;
  const lat = inWin
    .map((o) => o.latencyMs)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  return {
    samples: inWin.length,
    failures,
    errorRate: inWin.length ? failures / inWin.length : 0,
    p95LatencyMs: percentile(lat, 0.95),
  };
}

export function cooldownMs(consecutiveOpens: number, cfg: BreakerConfig): number {
  const n = Math.max(0, consecutiveOpens - 1);
  return Math.min(cfg.maxCooldownMs, cfg.baseCooldownMs * 2 ** Math.min(n, 20));
}

export interface BreakerResult {
  snapshot: BreakerSnapshot;
  stats: WindowStats;
  /** 0..100. open = 0, half_open <= 50, closed derived from error rate and latency. */
  score: number;
  transitioned: boolean;
  reason: string;
}

export function evaluateBreaker(prev: BreakerSnapshot, outcomes: Outcome[], now: number, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerResult {
  const stats = windowStats(outcomes, now, cfg.windowMs);
  const tripped = (s: WindowStats): string | null => {
    if (s.samples < cfg.minSamples) return null;
    if (s.errorRate >= cfg.errorRateThreshold) return `error_rate ${(s.errorRate * 100).toFixed(0)}% >= ${(cfg.errorRateThreshold * 100).toFixed(0)}%`;
    if (cfg.p95LatencyMs != null && s.p95LatencyMs != null && s.p95LatencyMs >= cfg.p95LatencyMs) return `p95 ${s.p95LatencyMs}ms >= ${cfg.p95LatencyMs}ms`;
    return null;
  };

  let snap = prev;
  let reason = "unchanged";
  let transitioned = false;
  const to = (next: BreakerSnapshot, why: string) => { snap = next; reason = why; transitioned = true; };

  if (prev.state === "closed") {
    const why = tripped(stats);
    if (why) to({ state: "open", openedAt: now, consecutiveOpens: prev.consecutiveOpens + 1, halfOpenAt: null }, why);
  } else if (prev.state === "open") {
    const openedAt = prev.openedAt ?? now;
    if (now - openedAt >= cooldownMs(prev.consecutiveOpens, cfg)) to({ ...prev, state: "half_open", halfOpenAt: now }, "cooldown elapsed");
  } else {
    // half_open: judge ONLY outcomes after entering half_open, so stale pre-open failures cannot re-trip.
    const since = prev.halfOpenAt ?? now;
    const probes = outcomes.filter((o) => o.at > since && o.at <= now);
    if (probes.some((o) => !o.ok)) {
      to({ state: "open", openedAt: now, consecutiveOpens: prev.consecutiveOpens + 1, halfOpenAt: null }, "probe failed");
    } else if (probes.length >= cfg.successesToClose) {
      to({ state: "closed", openedAt: null, consecutiveOpens: 0, halfOpenAt: null }, "probes succeeded");
    }
  }

  return { snapshot: snap, stats, score: healthScore(snap.state, stats, cfg), transitioned, reason };
}

export function healthScore(state: BreakerState, s: WindowStats, cfg: BreakerConfig = DEFAULT_BREAKER): number {
  if (state === "open") return 0;
  if (s.samples === 0) return state === "half_open" ? 40 : 100; // no data is not "bad"; the synthetic probe covers silence
  const errPenalty = Math.min(70, (s.errorRate / Math.max(0.01, cfg.errorRateThreshold)) * 50);
  const latPenalty = cfg.p95LatencyMs && s.p95LatencyMs ? Math.min(30, Math.max(0, (s.p95LatencyMs / cfg.p95LatencyMs) * 20)) : 0;
  const raw = Math.max(0, Math.round(100 - errPenalty - latPenalty));
  return state === "half_open" ? Math.min(50, raw) : raw;
}

/** Whether a given call may use a provider whose breaker is `state`. half_open admits a deterministic canary slice. */
export function allowRequest(state: BreakerState, canaryKey: string, canaryPercent = 5): boolean {
  if (state === "closed") return true;
  if (state === "open") return false;
  return canaryBucket(canaryKey) < canaryPercent;
}

/** Stable 0..99 bucket (FNV-1a) so a retry of the same call stays on the same side of the canary. */
export function canaryBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}
