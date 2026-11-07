// supabase/functions/_shared/outcomes/experiment.ts
// Honest effect estimation with a comparison group. Every estimator reports an
// interval and sample sizes, and is suppressed below a minimum n per arm.
//
//  - diffProportions: randomized holdout, binary outcome (Newcombe-Wilson 95% CI)
//  - diffInDiff:      matched/non-randomized cohorts, continuous outcome (Welch-style 95% CI)
//  - naiveBeforeAfter: the LEGACY design (no comparison group). Kept only to label
//    legacy numbers "unadjusted" and to demonstrate its bias in simulations.

import { wilsonInterval } from "./intervals.ts";

export const MIN_N_PER_ARM = 30;
const Z = 1.959964;

export interface Arm { k: number; n: number }

export interface EffectEstimate {
  method: string;
  effect: number | null;
  lower: number | null;
  upper: number | null;
  nTreated: number; nControl: number;
  suppressed: boolean;
  /** true only when the 95% interval excludes 0. */
  significant: boolean;
  label: "adjusted" | "unadjusted";
}

const suppressed = (method: string, nT: number, nC: number, label: EffectEstimate["label"] = "adjusted"): EffectEstimate => ({
  method, effect: null, lower: null, upper: null, nTreated: nT, nControl: nC, suppressed: true, significant: false, label,
});

export function diffProportions(treated: Arm, control: Arm, minN = MIN_N_PER_ARM): EffectEstimate {
  const m = "randomized_holdout_newcombe";
  if (!(treated.n >= minN) || !(control.n >= minN)) return suppressed(m, treated.n, control.n);
  const a = wilsonInterval(treated.k, treated.n), b = wilsonInterval(control.k, control.n);
  if (!a || !b) return suppressed(m, treated.n, control.n);
  const p1 = treated.k / treated.n, p0 = control.k / control.n, d = p1 - p0;
  const lower = d - Math.sqrt((p1 - a.lower) ** 2 + (b.upper - p0) ** 2);
  const upper = d + Math.sqrt((a.upper - p1) ** 2 + (p0 - b.lower) ** 2);
  return { method: m, effect: d, lower, upper, nTreated: treated.n, nControl: control.n, suppressed: false, significant: lower > 0 || upper < 0, label: "adjusted" };
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: number[]) => { const m = mean(xs); return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1); };

export interface DidInput { treatedPre: number[]; treatedPost: number[]; controlPre: number[]; controlPost: number[] }

export function diffInDiff(d: DidInput, minN = MIN_N_PER_ARM): EffectEstimate {
  const m = "difference_in_differences";
  const cells = [d.treatedPre, d.treatedPost, d.controlPre, d.controlPost];
  const nT = Math.min(d.treatedPre.length, d.treatedPost.length);
  const nC = Math.min(d.controlPre.length, d.controlPost.length);
  if (cells.some((c) => c.length < minN || c.some((x) => !Number.isFinite(x)))) return suppressed(m, nT, nC);
  const effect = (mean(d.treatedPost) - mean(d.treatedPre)) - (mean(d.controlPost) - mean(d.controlPre));
  // Cells are treated as independent (unit-level repeated measures would need clustered SEs;
  // this is conservative only when pre/post are positively correlated). Documented limitation.
  const se = Math.sqrt(cells.reduce((s, c) => s + variance(c) / c.length, 0));
  const lower = effect - Z * se, upper = effect + Z * se;
  return { method: m, effect, lower, upper, nTreated: nT, nControl: nC, suppressed: false, significant: lower > 0 || upper < 0, label: "adjusted" };
}

/** LEGACY: before/after without a control group. Always labelled "unadjusted". */
export function naiveBeforeAfter(pre: number[], post: number[], minN = MIN_N_PER_ARM): EffectEstimate {
  const m = "naive_before_after";
  if (pre.length < minN || post.length < minN) return suppressed(m, post.length, pre.length, "unadjusted");
  const effect = mean(post) - mean(pre);
  const se = Math.sqrt(variance(pre) / pre.length + variance(post) / post.length);
  const lower = effect - Z * se, upper = effect + Z * se;
  return { method: m, effect, lower, upper, nTreated: post.length, nControl: pre.length, suppressed: false, significant: lower > 0 || upper < 0, label: "unadjusted" };
}
