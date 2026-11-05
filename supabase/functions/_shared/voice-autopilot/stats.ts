// supabase/functions/_shared/voice-autopilot/stats.ts
//
// Pure statistics for Voice Autopilot (no I/O). Shared by the Edge Function
// and the React UI so the numbers on screen are the numbers that drove the decision.
//
// DESIGN (pre-registered group-sequential test):
//  - Two-sided alpha = 0.05, exactly K = 4 equally spaced looks (25/50/75/100 % of the
//    pre-registered maximum sample per arm), O'Brien-Fleming boundaries.
//  - A win/loss decision is ONLY taken AT a look. Between looks the UI may show
//    descriptive numbers, but they can never trigger a promotion (no peeking bias).
//  - Intervals shown at a look are *repeated confidence intervals* (estimate +/- boundary*SE):
//    they are valid at every look, i.e. honest about sequential testing.
//  - Bayesian numbers (posterior, pooled priors) are DISPLAY ONLY. They never promote anything.

import { normalCdf } from "../call-scripts/logic.ts";

export const ALPHA = 0.05;
/** Two-sided O'Brien-Fleming critical values, K = 4 equally spaced looks, alpha = 0.05 (Jennison & Turnbull). */
export const OBF_BOUNDARIES = [4.049, 2.863, 2.337, 2.024] as const;
export const LOOK_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
export const K_LOOKS = LOOK_FRACTIONS.length;
/** Sample-size inflation for OBF with 4 looks (~2%); we round up to 3% to stay conservative. */
export const OBF_INFLATION = 1.03;
/** Never run a statistical test below this many observations per arm, whatever the schedule says. */
export const ABSOLUTE_MIN_PER_ARM = 30;

export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in (0,1)");
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- tallies ----------
export interface BinaryTally { n: number; k: number }
export interface ContinuousTally { n: number; mean: number; variance: number }

export function binaryRate(t: BinaryTally): number | null {
  return t.n > 0 ? t.k / t.n : null;
}

export interface DiffStat {
  estimate: number; // challenger - control
  se: number;
  z: number | null;
}

export function diffBinary(control: BinaryTally, challenger: BinaryTally): DiffStat | null {
  if (control.n < 2 || challenger.n < 2) return null;
  const p1 = control.k / control.n;
  const p2 = challenger.k / challenger.n;
  const pooled = (control.k + challenger.k) / (control.n + challenger.n);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / control.n + 1 / challenger.n));
  const seUnpooled = Math.sqrt((p1 * (1 - p1)) / control.n + (p2 * (1 - p2)) / challenger.n);
  const estimate = p2 - p1;
  // z uses the pooled SE (null-hypothesis SE); intervals use the unpooled SE.
  return { estimate, se: seUnpooled, z: sePooled > 0 ? estimate / sePooled : estimate === 0 ? 0 : null };
}

export function diffContinuous(control: ContinuousTally, challenger: ContinuousTally): DiffStat | null {
  if (control.n < 2 || challenger.n < 2) return null;
  const se = Math.sqrt(control.variance / control.n + challenger.variance / challenger.n);
  const estimate = challenger.mean - control.mean;
  return { estimate, se, z: se > 0 ? estimate / se : estimate === 0 ? 0 : null };
}

export interface Interval { low: number; high: number }
export const intervalAt = (d: DiffStat, z: number): Interval => ({ low: d.estimate - z * d.se, high: d.estimate + z * d.se });

// ---------- schedule ----------
export function lookThresholds(nMaxPerArm: number): number[] {
  return LOOK_FRACTIONS.map((f) => Math.max(ABSOLUTE_MIN_PER_ARM, Math.ceil(f * nMaxPerArm)));
}

/** The next not-yet-analysed look whose sample size has been reached (1-based), or null. Looks are never skipped silently:
 * if two thresholds are crossed at once we analyse the EARLIEST unanalysed one first. */
export function nextLookDue(nMinPerArm: number, nMaxPerArm: number, lastLookDone: number): number | null {
  const th = lookThresholds(nMaxPerArm);
  const next = lastLookDone + 1;
  if (next > K_LOOKS) return null;
  return nMinPerArm >= th[next - 1] ? next : null;
}

/** Sample per arm for a two-proportion test (power 0.8 by default), inflated for the 4-look design. */
export function requiredSamplePerArm(baseline: number, mdeAbsolute: number, power = 0.8, alpha = ALPHA): number {
  const p1 = Math.min(0.999, Math.max(0.001, baseline));
  const p2 = Math.min(0.999, Math.max(0.001, baseline + mdeAbsolute));
  const d = Math.abs(p2 - p1);
  if (d === 0) return Number.POSITIVE_INFINITY;
  const za = normalInv(1 - alpha / 2);
  const zb = normalInv(power);
  const n = ((za + zb) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (d * d);
  return Math.max(ABSOLUTE_MIN_PER_ARM, Math.ceil(n * OBF_INFLATION));
}

export interface Feasibility {
  nPerArm: number;
  daysNeeded: number | null;
  feasible: boolean;
}
/** Small businesses: can this ever conclude within `maxDays`? callsPerDayPerArm must be >0 to be feasible. */
export function feasibility(baseline: number, mdeAbsolute: number, callsPerDayPerArm: number, maxDays = 90): Feasibility {
  const nPerArm = requiredSamplePerArm(baseline, mdeAbsolute);
  if (!Number.isFinite(nPerArm) || !(callsPerDayPerArm > 0)) return { nPerArm, daysNeeded: null, feasible: false };
  const daysNeeded = Math.ceil(nPerArm / callsPerDayPerArm);
  return { nPerArm, daysNeeded, feasible: daysNeeded <= maxDays };
}

// ---------- sequential decision at a look ----------
export type LookVerdict = "challenger_better" | "control_better" | "no_boundary_crossed";
export interface LookResult {
  look: number;
  boundary: number;
  z: number | null;
  verdict: LookVerdict;
  estimate: number;
  /** Repeated CI (valid at every look) of the challenger-minus-control difference, in the metric's own units. */
  rci: Interval;
}
/** `higherIsBetter` only affects the label: the test itself is on the raw difference. */
export function evaluateLook(d: DiffStat, look: number, higherIsBetter: boolean): LookResult {
  const boundary = OBF_BOUNDARIES[look - 1];
  const crossed = d.z !== null && Math.abs(d.z) >= boundary;
  let verdict: LookVerdict = "no_boundary_crossed";
  if (crossed && d.z !== null) {
    const challengerHigher = d.z > 0;
    verdict = challengerHigher === higherIsBetter ? "challenger_better" : "control_better";
  }
  return { look, boundary, z: d.z, verdict, estimate: d.estimate, rci: intervalAt(d, boundary) };
}

// ---------- guardrails ----------
export interface GuardrailResult {
  /** Estimated harm in the metric's "bad" direction (positive = challenger is worse). */
  harm: number;
  /** One-sided 95 % upper bound of harm: used for NON-INFERIORITY before promotion. */
  harmUpper95: number;
  /** Conservative (z = 3) lower bound of harm: used for ROLLBACK; checked continuously because safety > purity. */
  harmLower3: number;
}
export const GUARDRAIL_Z_PROMOTE = 1.645;
export const GUARDRAIL_Z_ROLLBACK = 3;
export function guardrailStats(d: DiffStat, higherIsBetter: boolean): GuardrailResult {
  const harm = higherIsBetter ? -d.estimate : d.estimate;
  return { harm, harmUpper95: harm + GUARDRAIL_Z_PROMOTE * d.se, harmLower3: harm - GUARDRAIL_Z_ROLLBACK * d.se };
}

// ---------- Bayesian (display only) ----------
export interface BetaPrior { a: number; b: number }
export const FLAT_PRIOR: BetaPrior = { a: 1, b: 1 };
/** Pooled priors are capped so one large pool can never overwhelm a business's own data. */
export const MAX_PRIOR_STRENGTH = 20;
export const MIN_POOL_ACCOUNTS = 10;

/** Opt-in, anonymised pool -> Beta prior. Requires >= MIN_POOL_ACCOUNTS accounts (k-anonymity); otherwise a flat prior. */
export function priorFromPool(pool: { successes: number; trials: number; accounts: number } | null): BetaPrior {
  if (!pool || pool.accounts < MIN_POOL_ACCOUNTS || pool.trials <= 0) return FLAT_PRIOR;
  const p = Math.min(0.999, Math.max(0.001, pool.successes / pool.trials));
  const strength = Math.min(MAX_PRIOR_STRENGTH, pool.trials);
  return { a: Math.max(0.5, p * strength), b: Math.max(0.5, (1 - p) * strength) };
}

export function posteriorMeanVar(t: BinaryTally, prior: BetaPrior): { mean: number; variance: number } {
  const a = prior.a + t.k;
  const b = prior.b + (t.n - t.k);
  const s = a + b;
  return { mean: a / s, variance: (a * b) / (s * s * (s + 1)) };
}

/** P(challenger rate > control rate) via the normal approximation to the Beta difference. Display only. */
export function probChallengerBetter(control: BinaryTally, challenger: BinaryTally, prior: BetaPrior = FLAT_PRIOR): number {
  const c = posteriorMeanVar(control, prior);
  const h = posteriorMeanVar(challenger, prior);
  const sd = Math.sqrt(c.variance + h.variance);
  return sd === 0 ? 0.5 : normalCdf((h.mean - c.mean) / sd);
}

export type DataSufficiency = "enough" | "not_enough_data" | "cannot_conclude_in_time";
export function dataSufficiency(nMinPerArm: number, nMaxPerArm: number, f: Feasibility | null): DataSufficiency {
  if (f && !f.feasible) return "cannot_conclude_in_time";
  return nMinPerArm >= Math.max(ABSOLUTE_MIN_PER_ARM, lookThresholds(nMaxPerArm)[0]) ? "enough" : "not_enough_data";
}

/** Deterministic PRNG (mulberry32) for reproducible simulations. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
