// supabase/functions/_shared/outcomes/policyLearning.ts
// Bounded, reviewable policy learning primitives. No fine-tuning: simple
// Bayesian shrinkage + capped exploration + a monitored auto-rollback rule.

import { wilsonInterval } from "./intervals.ts";

/** Posterior mean of a Beta(prior*w, (1-prior)*w) prior updated with k/n. */
export function shrunkRate(k: number, n: number, priorRate = 0.5, priorWeight = 10): number {
  return (k + priorRate * priorWeight) / (n + priorWeight);
}

export interface Variant { key: string; k: number; n: number }

/**
 * Capped epsilon-greedy over shrunk rates. `explorationCap` bounds the share of
 * traffic that may go to non-best variants (default 10%, hard max 20%).
 * `rng` must return [0,1); inject a seeded one for reproducible tests.
 */
export function chooseVariant(variants: Variant[], rng: () => number, explorationCap = 0.1): { key: string; explored: boolean } | null {
  if (variants.length === 0) return null;
  const cap = Math.max(0, Math.min(0.2, explorationCap));
  const scored = variants.map((v) => ({ key: v.key, s: shrunkRate(v.k, v.n) }));
  const best = scored.reduce((a, b) => (b.s > a.s ? b : a));
  if (variants.length > 1 && rng() < cap) {
    const others = scored.filter((v) => v.key !== best.key);
    return { key: others[Math.floor(rng() * others.length)].key, explored: true };
  }
  return { key: best.key, explored: false };
}

/** Moves `current` toward `target` by at most maxStepPct of the allowed range, clamped to [lo, hi]. */
export function boundedStep(current: number, target: number, maxStepPct: number, lo: number, hi: number): number {
  const maxStep = Math.abs(hi - lo) * Math.max(0, Math.min(1, maxStepPct));
  const delta = Math.max(-maxStep, Math.min(maxStep, target - current));
  return Math.max(lo, Math.min(hi, current + delta));
}

export type ChangeKind = "relax_approval" | "tighten_approval";
export type RollbackAction = "continue" | "confirm" | "rollback";

export interface RollbackInput {
  kind: ChangeKind;
  baselineK: number; baselineN: number;
  postK: number; postN: number;
  windowElapsed: boolean;
  minPostN?: number;
  /** absolute drop in success rate the post-change upper bound must stay above */
  marginAbs?: number;
}

export interface RollbackDecision { action: RollbackAction; reason: string }

/**
 * Auto-rollback rule for an applied learning change.
 *  - degraded: Wilson 95% UPPER bound of post-change success < baseline rate - margin
 *  - not enough post data while monitoring -> continue
 *  - window over with too little data: relax changes fail safe (rollback); tighten changes confirm
 */
export function rollbackDecision(i: RollbackInput): RollbackDecision {
  const minPostN = i.minPostN ?? 20;
  const margin = i.marginAbs ?? 0.1;
  if (i.baselineN <= 0) return { action: i.kind === "relax_approval" ? "rollback" : "confirm", reason: "no_baseline" };
  if (i.postN < minPostN) {
    if (!i.windowElapsed) return { action: "continue", reason: "insufficient_post_data" };
    return i.kind === "relax_approval"
      ? { action: "rollback", reason: "window_over_insufficient_evidence_fail_safe" }
      : { action: "confirm", reason: "window_over_insufficient_data_tighten_is_safe" };
  }
  const ci = wilsonInterval(i.postK, i.postN);
  const baseRate = i.baselineK / i.baselineN;
  if (ci && ci.upper < baseRate - margin) return { action: "rollback", reason: "outcomes_degraded" };
  return i.windowElapsed ? { action: "confirm", reason: "no_degradation_detected" } : { action: "continue", reason: "monitoring" };
}
