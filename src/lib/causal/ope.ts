/**
 * Off-policy evaluation (pure): what would outcome Y have averaged if a different dispatch policy had chosen among the
 * SAME near-equal technicians? Uses only logged randomized decisions (sets of >= 2 with known probabilities).
 *
 * Estimators for a candidate policy π (π_ij = probability π picks member j of row i's set), logging policy p:
 *   SNIPS: V̂ = Σ w_i Y_i / Σ w_i,  w_i = π_iA / p̃_iA                       (self-normalised IPS; bounded by max Y)
 *   DR   : ψ_i = Σ_j π_ij m̂_ij + (π_iA / p̃_iA)(Y_i − m̂_iA),  V̂ = mean ψ_i   (m̂ cross-fitted)
 * Uplift vs what actually happened = mean(ψ_i(π) − ψ_i(p)), with cluster-robust SE on the paired difference.
 *
 * The result REFUSES to give a number when overlap is poor (few effective observations, one row dominating, or many
 * propensities clipped). The value applies ONLY to decisions that had a set of >= 2 (the randomizable subpopulation);
 * it says nothing about emergencies, VIP, SLA or any hard-excluded job.
 */

import type { OutcomeKey } from '../causalDispatch';
import { clusterRobustSe, crossFitPredictions, DEFAULT_ESTIMATOR_OPTIONS, prepareRows, type EstimatorOptions, type EstRow } from './estimators';
import { Z95 } from './normal';

/** Per-member probabilities of the candidate policy, aligned with row.members. Must be >= 0 and sum to 1. */
export type PolicyFn = (row: EstRow) => number[];

export const OPE_MIN_ROWS = 50;
export const OPE_MIN_ESS = 30;
export const OPE_MIN_ESS_SHARE = 0.05;
export const OPE_MAX_WEIGHT_SHARE = 0.2;
export const OPE_MAX_CLIPPED_SHARE = 0.1;

const oneHot = (n: number, i: number) => Array.from({ length: n }, (_, j) => (j === i ? 1 : 0));

/** Always the top-scored member (ties: earlier in the logged order, which puts the engine's own pick first). */
export const topRankedPolicy: PolicyFn = (row) => {
  let best = 0;
  row.members.forEach((m, i) => { if (m.score > row.members[best].score + 1e-9) best = i; });
  return oneHot(row.members.length, best);
};

/** The logging policy itself (sanity check: its value must equal the observed mean). */
export const loggedPolicy: PolicyFn = (row) => row.members.map((m) => m.p);

/**
 * Re-rank by a re-weighted score: score' = score + Σ_f (ratio_f − 1) · points_f, where ratio = suggested / current
 * weight of rule f (from suggestWeightChanges). Deterministic argmax, ties keep the earlier logged member.
 */
export function weightChangePolicy(ratios: Record<string, number>): PolicyFn {
  return (row) => {
    const sc = row.members.map((m) => m.score + Object.entries(ratios).reduce((s, [f, r]) => s + (Number.isFinite(r) ? (r - 1) * (m.f[f] ?? 0) : 0), 0));
    let best = 0;
    sc.forEach((v, i) => { if (v > sc[best] + 1e-9) best = i; });
    return oneHot(sc.length, best);
  };
}

export interface OpeOptions {
  outcome?: OutcomeKey;
  estimator?: Partial<EstimatorOptions>;
  minRows?: number;
  minEss?: number;
}

export interface ValueEstimate { value: number; se: number | null; ciLow: number | null; ciHigh: number | null }

export interface OpeResult {
  status: 'ok' | 'refused';
  refusals: string[];
  scope: string;
  n: number;
  ess: number;
  essShare: number;
  maxWeightShare: number;
  clippedShare: number;
  behaviour: number | null;
  snips: ValueEstimate | null;
  dr: ValueEstimate | null;
  uplift: (ValueEstimate & { excludesZero: boolean }) | null;
}

const SCOPE = 'Applies only to decisions that had >= 2 near-equal technicians; hard-excluded jobs are outside this estimate.';
const est = (value: number, se: number | null): ValueEstimate => ({ value, se, ciLow: se === null ? null : value - Z95 * se, ciHigh: se === null ? null : value + Z95 * se });

export function evaluatePolicy(rows: EstRow[], policy: PolicyFn, options: OpeOptions = {}): OpeResult {
  const outcome = options.outcome ?? 'ftf';
  const opts: EstimatorOptions = { ...DEFAULT_ESTIMATOR_OPTIONS, ...options.estimator };
  const usable = prepareRows(rows, outcome, opts);
  const n = usable.length;
  const refused = (refusals: string[], extra: Partial<OpeResult> = {}): OpeResult => ({
    status: 'refused', refusals, scope: SCOPE, n, ess: 0, essShare: 0, maxWeightShare: 0, clippedShare: 0, behaviour: null, snips: null, dr: null, uplift: null, ...extra,
  });
  if (n < (options.minRows ?? OPE_MIN_ROWS)) return refused([`only ${n} usable randomized decisions (need ${options.minRows ?? OPE_MIN_ROWS})`]);

  const pi = usable.map((u) => {
    const v = policy(u.row);
    if (v.length !== u.row.members.length || v.some((x) => !(x >= 0) || !Number.isFinite(x)) || Math.abs(v.reduce((s, x) => s + x, 0) - 1) > 1e-6) {
      throw new RangeError(`policy must return one non-negative probability per set member, summing to 1 (job ${u.row.jobId})`);
    }
    return v;
  });
  const aIdx = usable.map((u) => u.row.members.findIndex((m) => m.id === u.row.chosenId));
  const pTil = usable.map((u, i) => Math.max(u.row.members[aIdx[i]].p, opts.pClip));
  const w = usable.map((_, i) => pi[i][aIdx[i]] / pTil[i]);
  const sw = w.reduce((s, v) => s + v, 0);
  const sw2 = w.reduce((s, v) => s + v * v, 0);
  if (!(sw > 0)) return refused(['the candidate policy never agrees with a logged assignment: no overlap, so it cannot be evaluated']);
  const ess = (sw * sw) / sw2;
  const essShare = ess / n;
  const maxWeightShare = Math.max(...w) / sw;
  const clippedRows = usable.filter((u, i) => w[i] > 0 && u.row.members[aIdx[i]].p < opts.pClip).length;
  const matched = w.filter((x) => x > 0).length;
  const clippedShare = matched > 0 ? clippedRows / matched : 0;

  const refusals: string[] = [];
  if (ess < (options.minEss ?? OPE_MIN_ESS)) refusals.push(`effective sample ${ess.toFixed(1)} (need ${options.minEss ?? OPE_MIN_ESS})`);
  if (essShare < OPE_MIN_ESS_SHARE) refusals.push(`overlap too low: effective sample is ${(essShare * 100).toFixed(1)}% of decisions (need ${(OPE_MIN_ESS_SHARE * 100).toFixed(0)}%)`);
  if (maxWeightShare > OPE_MAX_WEIGHT_SHARE) refusals.push(`one decision carries ${(maxWeightShare * 100).toFixed(0)}% of the total weight (limit ${(OPE_MAX_WEIGHT_SHARE * 100).toFixed(0)}%)`);
  if (clippedShare > OPE_MAX_CLIPPED_SHARE) refusals.push(`${(clippedShare * 100).toFixed(0)}% of matched decisions needed propensity clipping (limit ${(OPE_MAX_CLIPPED_SHARE * 100).toFixed(0)}%)`);
  const base = { n, ess, essShare, maxWeightShare, clippedShare };
  if (refusals.length) return refused(refusals, base);

  const behaviour = usable.reduce((s, u) => s + u.y, 0) / n;

  // SNIPS with cluster-robust linearised SE
  const vS = usable.reduce((s, u, i) => s + w[i] * u.y, 0) / sw;
  const sEntries = usable.map((u, i) => ({ phi: (w[i] * (u.y - vS) * n) / sw, cluster: u.cluster }));
  const sSe = clusterRobustSe(sEntries, 0).se;

  // Doubly robust + paired uplift over the logging policy
  const m = crossFitPredictions(usable, opts);
  const psiPi: number[] = [];
  const diff: { phi: number; cluster: string }[] = [];
  usable.forEach((u, i) => {
    const members = u.row.members;
    const a = aIdx[i];
    const resid = u.y - m[i][a];
    const dPi = pi[i].reduce((s, x, j) => s + x * m[i][j], 0) + (pi[i][a] / pTil[i]) * resid;
    const d0 = members.reduce((s, mem, j) => s + mem.p * m[i][j], 0) + (members[a].p / pTil[i]) * resid;
    psiPi.push(dPi);
    diff.push({ phi: dPi - d0, cluster: u.cluster });
  });
  const vD = psiPi.reduce((s, v) => s + v, 0) / n;
  const dSe = clusterRobustSe(psiPi.map((v, i) => ({ phi: v, cluster: usable[i].cluster })), vD).se;
  const upl = diff.reduce((s, d) => s + d.phi, 0) / n;
  const uSe = clusterRobustSe(diff, upl).se;
  const uplift = est(upl, uSe);
  return {
    status: 'ok', refusals: [], scope: SCOPE, ...base, behaviour,
    snips: est(vS, sSe), dr: est(vD, dSe),
    uplift: { ...uplift, excludesZero: uplift.ciLow !== null && uplift.ciHigh !== null && (uplift.ciLow > 0 || uplift.ciHigh < 0) },
  };
}
