/**
 * Causal Dispatch Network — estimators (pure, no I/O).
 *
 * Data: one row per randomizable dispatch decision. Row i has an indifference set S_i (k_i >= 2 technicians), the
 * LOGGED assignment probability p_ij of every member, the technician A_i who actually got the job, a job type τ_i and
 * outcomes Y_i. Everything below conditions on the set composition of the row it comes from: all contrasts are taken
 * INSIDE a row's own set, and every weight is that row's own logged probability.
 *
 * Estimand (per technician t, job type τ, outcome Y):
 *     θ_tτ = E[ Y_i(t) − mean_{j ∈ S_i} Y_i(j)  |  t ∈ S_i, τ_i = τ ]
 * i.e. t's effect relative to the equal-weighted average of the peers it was interchangeable with on those jobs.
 * It is NOT an absolute skill score and it depends on who t was grouped with (see docs/causal-dispatch-network.md).
 *
 * Scores, with p̃_ij = max(p_ij, pClip):
 *     IPW :  ψ_ij = 1{A_i=j} Y_i / p̃_ij
 *     AIPW:  ψ_ij = m̂_ij + 1{A_i=j} (Y_i − m̂_ij) / p̃_ij          (doubly robust)
 *     φ_ij = ψ_ij − (1/k_i) Σ_l ψ_il ;   θ̂_tτ = mean of φ_it over rows with t ∈ S_i, τ_i = τ.
 * m̂ is CROSS-FITTED: a row's prediction never uses any row of its own cluster/fold.
 */

import type { CausalRow, OutcomeKey } from '../causalDispatch';
import { hashString, makeRng } from './rng';

export interface EstRow extends CausalRow {
  /** Dependence unit for standard errors, e.g. `${technicianId}|${isoWeek}` or a customer-site id. Default: the job. */
  clusterId?: string;
}

export interface EstimatorOptions {
  /** Propensities below this are replaced by it when used as a divisor (bias/variance trade-off, documented). */
  pClip: number;
  /** Cross-fitting folds (clusters are assigned to folds by hash, so results are deterministic). */
  folds: number;
  /** Pseudo-observations pulling thin outcome-model cells toward their parent mean. */
  priorStrength: number;
  seed: number;
  /** Cluster-bootstrap replicates; 0 disables the bootstrap (influence-function SEs are always computed). */
  bootstrapB: number;
}

export const DEFAULT_P_CLIP = 0.01;
export const DEFAULT_ESTIMATOR_OPTIONS: EstimatorOptions = { pClip: DEFAULT_P_CLIP, folds: 5, priorStrength: 5, seed: 20281102, bootstrapB: 0 };

export type EstimatorMethod = 'aipw' | 'ipw';

export interface UsableRow {
  row: EstRow;
  y: number;
  cluster: string;
  fold: number;
}

export interface RawCell {
  technicianId: string;
  jobType: string;
  outcome: OutcomeKey;
  method: EstimatorMethod;
  /** Rows in which the technician was a set member (the effective comparison sample). */
  nSet: number;
  /** Rows in which the technician actually got the job. */
  nChosen: number;
  /** Kish effective sample size of the inverse-propensity weights over chosen rows (0 when nChosen = 0). */
  ess: number;
  /** Share of chosen rows whose propensity was below pClip. */
  clippedShare: number;
  est: number;
  /** Cluster-robust (influence-function) standard error; null when fewer than 2 clusters. */
  se: number | null;
  clusters: number;
  bootLow: number | null;
  bootHigh: number | null;
}

export interface EstimationDiagnostics {
  outcome: OutcomeKey;
  method: EstimatorMethod;
  nRows: number;
  clippedRows: number;
  pClip: number;
  minChosenP: number | null;
  essOverall: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function prepareRows(rows: EstRow[], outcome: OutcomeKey, opts: EstimatorOptions): UsableRow[] {
  const out: UsableRow[] = [];
  for (const row of rows) {
    const y = row.outcomes[outcome];
    if (!isNum(y)) continue;
    if (row.members.length < 2 || !row.members.some((m) => m.id === row.chosenId)) continue;
    const cluster = row.clusterId ?? row.jobId;
    out.push({ row, y, cluster, fold: hashString(`${opts.seed}|${cluster}`) % Math.max(1, opts.folds) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Cross-fitted outcome model:  global mean -> job-type mean -> technician mean -> technician × job-type mean.
// m̂ is a model of the CHOSEN technician's outcomes; the IPW correction term removes whatever bias it carries.
// ---------------------------------------------------------------------------------------------------------------

interface Acc { n: number; s: number }
class FoldTable {
  private total = new Map<string, Acc>();
  private part: Map<string, Acc>[];
  constructor(folds: number) {
    this.part = Array.from({ length: Math.max(1, folds) }, () => new Map());
  }
  add(key: string, fold: number, y: number) {
    for (const m of [this.total, this.part[fold]]) {
      const a = m.get(key) ?? { n: 0, s: 0 };
      a.n += 1;
      a.s += y;
      m.set(key, a);
    }
  }
  /** Sums over all rows NOT in `fold`. */
  get(key: string, fold: number): Acc {
    const t = this.total.get(key) ?? { n: 0, s: 0 };
    const p = this.part[fold].get(key) ?? { n: 0, s: 0 };
    return { n: t.n - p.n, s: t.s - p.s };
  }
}

const SEP = '\u0001';

/** Cross-fitted predictions m̂[i][j] for every set member j of usable row i. */
export function crossFitPredictions(usable: UsableRow[], opts: EstimatorOptions): number[][] {
  const tj = new FoldTable(opts.folds);
  const t = new FoldTable(opts.folds);
  const j = new FoldTable(opts.folds);
  const g = new FoldTable(opts.folds);
  for (const u of usable) {
    tj.add(`${u.row.chosenId}${SEP}${u.row.jobType}`, u.fold, u.y);
    t.add(u.row.chosenId, u.fold, u.y);
    j.add(u.row.jobType, u.fold, u.y);
    g.add('g', u.fold, u.y);
  }
  const k = opts.priorStrength;
  return usable.map((u) => {
    const G = g.get('g', u.fold);
    const gMean = G.n > 0 ? G.s / G.n : 0;
    const J = j.get(u.row.jobType, u.fold);
    const jMean = (J.s + k * gMean) / (J.n + k);
    return u.row.members.map((m) => {
      const T = t.get(m.id, u.fold);
      const tMean = (T.s + k * jMean) / (T.n + k);
      const C = tj.get(`${m.id}${SEP}${u.row.jobType}`, u.fold);
      return (C.s + k * tMean) / (C.n + k);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------------------------------------------

interface Entry { phi: number; cluster: string }

/** Cluster-robust SE of a mean of entries (CR1 small-sample factor G/(G−1)). */
export function clusterRobustSe(entries: Entry[], mean: number): { se: number | null; clusters: number } {
  const sums = new Map<string, number>();
  for (const e of entries) sums.set(e.cluster, (sums.get(e.cluster) ?? 0) + (e.phi - mean));
  const G = sums.size;
  if (G < 2) return { se: null, clusters: G };
  let ss = 0;
  for (const v of sums.values()) ss += v * v;
  const n = entries.length;
  return { se: Math.sqrt(((G / (G - 1)) * ss) / (n * n)), clusters: G };
}

/** Seeded percentile cluster bootstrap of a mean. null when fewer than 2 clusters. */
export function clusterBootstrapCi(entries: Entry[], B: number, rng: () => number, level = 0.95): { low: number; high: number } | null {
  const byCluster = new Map<string, { s: number; n: number }>();
  for (const e of entries) {
    const a = byCluster.get(e.cluster) ?? { s: 0, n: 0 };
    a.s += e.phi;
    a.n += 1;
    byCluster.set(e.cluster, a);
  }
  const cl = [...byCluster.keys()].sort().map((k) => byCluster.get(k)!);
  const G = cl.length;
  if (G < 2 || B < 20) return null;
  const draws: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    let n = 0;
    for (let g = 0; g < G; g++) {
      const c = cl[Math.min(G - 1, Math.floor(rng() * G))];
      s += c.s;
      n += c.n;
    }
    draws.push(s / n);
  }
  draws.sort((a, b) => a - b);
  const lo = Math.floor(((1 - level) / 2) * (B - 1));
  const hi = Math.ceil((1 - (1 - level) / 2) * (B - 1));
  return { low: draws[lo], high: draws[hi] };
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------------------------------------------
// Cell estimation
// ---------------------------------------------------------------------------------------------------------------

export function estimateRawCells(
  rows: EstRow[],
  outcome: OutcomeKey,
  method: EstimatorMethod = 'aipw',
  options: Partial<EstimatorOptions> = {},
): { cells: RawCell[]; diagnostics: EstimationDiagnostics } {
  const opts: EstimatorOptions = { ...DEFAULT_ESTIMATOR_OPTIONS, ...options };
  if (!(opts.pClip > 0 && opts.pClip <= 0.5)) throw new RangeError('pClip must be in (0, 0.5]');
  const usable = prepareRows(rows, outcome, opts);
  const mHat = method === 'aipw' ? crossFitPredictions(usable, opts) : null;

  interface CellAcc { technicianId: string; jobType: string; entries: Entry[]; chosen: number; w: number; w2: number; clipped: number }
  const cells = new Map<string, CellAcc>();
  let clippedRows = 0;
  let minChosenP: number | null = null;
  let sw = 0;
  let sw2 = 0;

  usable.forEach((u, i) => {
    const { members } = u.row;
    const a = members.findIndex((m) => m.id === u.row.chosenId);
    const pRaw = members[a].p;
    const pTil = Math.max(pRaw, opts.pClip);
    const wasClipped = pRaw < opts.pClip;
    if (wasClipped) clippedRows++;
    minChosenP = minChosenP === null ? pRaw : Math.min(minChosenP, pRaw);
    sw += 1 / pTil;
    sw2 += 1 / (pTil * pTil);
    const psi = members.map((_, j) => {
      const m = mHat ? mHat[i][j] : 0;
      return j === a ? m + (u.y - m) / pTil : m;
    });
    const mean = psi.reduce((s, v) => s + v, 0) / psi.length;
    members.forEach((mem, j) => {
      const key = `${mem.id}${SEP}${u.row.jobType}`;
      const c = cells.get(key) ?? { technicianId: mem.id, jobType: u.row.jobType, entries: [], chosen: 0, w: 0, w2: 0, clipped: 0 };
      c.entries.push({ phi: psi[j] - mean, cluster: u.cluster });
      if (j === a) {
        c.chosen += 1;
        c.w += 1 / pTil;
        c.w2 += 1 / (pTil * pTil);
        if (wasClipped) c.clipped += 1;
      }
      cells.set(key, c);
    });
  });

  // Stabilise per-entry variance of thin cells toward the median (a cell with 2-3 identical values must not claim
  // zero uncertainty). u = se²·n is the per-entry variance; weight (G−1) for the cell, 2 for the median.
  const prelim = [...cells.values()].map((c) => {
    const n = c.entries.length;
    const est = c.entries.reduce((s, e) => s + e.phi, 0) / n;
    const { se, clusters } = clusterRobustSe(c.entries, est);
    return { c, n, est, se, clusters, u: se === null ? null : se * se * n };
  });
  const uMed = median(prelim.flatMap((p) => (p.u !== null && p.u > 0 ? [p.u] : [])));
  const rng = makeRng(`${opts.seed}|boot|${outcome}|${method}`);

  const out: RawCell[] = prelim
    .sort((x, y) => (x.c.technicianId + SEP + x.c.jobType).localeCompare(y.c.technicianId + SEP + y.c.jobType))
    .map(({ c, n, est, se, clusters, u }) => {
      let seFinal = se;
      if (se !== null && u !== null && uMed > 0) {
        const G = clusters;
        seFinal = Math.sqrt(((((G - 1) * u + 2 * uMed) / (G + 1)) / n));
      }
      const boot = opts.bootstrapB > 0 ? clusterBootstrapCi(c.entries, opts.bootstrapB, rng) : null;
      return {
        technicianId: c.technicianId,
        jobType: c.jobType,
        outcome,
        method,
        nSet: n,
        nChosen: c.chosen,
        ess: c.w2 > 0 ? (c.w * c.w) / c.w2 : 0,
        clippedShare: c.chosen > 0 ? c.clipped / c.chosen : 0,
        est,
        se: seFinal,
        clusters,
        bootLow: boot ? boot.low : null,
        bootHigh: boot ? boot.high : null,
      };
    });

  return {
    cells: out,
    diagnostics: { outcome, method, nRows: usable.length, clippedRows, pClip: opts.pClip, minChosenP, essOverall: sw2 > 0 ? (sw * sw) / sw2 : 0 },
  };
}
