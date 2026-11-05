/**
 * Incrementality estimators for "answered vs not answered" calls — Phase 0 (natural variation only).
 *
 * Pure, deterministic, dependency-free. Nothing here reads the database or randomizes real callers.
 *
 * Two designs, both applications of standard marketing-incrementality / quasi-experimental methods:
 *   1. Coarsened exact stratification (a matching estimator). Answered calls are compared with
 *      unanswered calls (voicemail, outage, forwarding failure) that share the same business and the
 *      same time block / service category / urgency / source. Effect = ATT (effect on answered calls).
 *   2. Difference-in-differences at business level (staggered onboarding, outages, overflow periods),
 *      with a pre-trend diagnostic.
 *
 * Uncertainty: cluster bootstrap by business (calls from one business are not independent).
 * Sensitivity: E-value (VanderWeele & Ding, 2017) for the booking-rate ratio.
 *
 * HONESTY RULES (enforced by `assessEstimate`):
 *   - A matching estimator only removes bias from the covariates it sees. Unobserved reasons a caller
 *     did or did not reach Sarah (urgency, willingness to call back) remain. We say so, and report
 *     how strong such a confounder would have to be to explain the result away.
 *   - The verdict is never "proven". The strongest verdict is `supported_with_caveats`.
 *   - Thin data returns `insufficient_data`; a wide or zero-spanning interval returns `inconclusive`.
 */

// ---------------------------------------------------------------- types

export interface CallObservation {
  id: string;
  businessId: string;
  /**
   * Resampling unit for the bootstrap. Defaults to businessId. For a SINGLE business (one account) you
   * MUST pass a time block here (e.g. ISO week): with one cluster the bootstrap would collapse to a
   * zero-width interval, which is false precision.
   */
  clusterId?: string;
  /** true = the caller reached Sarah; false = voicemail / outage / forwarding failure. */
  answered: boolean;
  /** Coarsened covariates. Callers decide the coarsening (e.g. timeBlock = "weekday_evening"). */
  timeBlock: string;
  category: string;
  urgency: string;
  source: string;
  /** Booked revenue attributable to this call, integer cents (0 when not booked). */
  bookedRevenueCents: number;
  /** Whether the call produced a booking. */
  booked: boolean;
}

export type OutcomeKey = 'bookedRevenueCents' | 'booked';

export interface DidRow {
  businessId: string;
  /** true = business in the "treated" group (e.g. onboarded / forwarding restored in the window). */
  treatedGroup: boolean;
  /** Integer period index (e.g. ISO week number since a fixed origin). */
  period: number;
  outcome: number;
}

export interface BootstrapOptions {
  /** Bootstrap replicates. */
  reps?: number;
  /** Two-sided confidence level, e.g. 0.95. */
  level?: number;
  /** PRNG seed so results are reproducible. */
  seed?: number;
}

export interface EffectEstimate {
  method: 'stratified_att' | 'did';
  /** Effect per call (stratified) or per business-period (DiD), in outcome units. */
  point: number;
  ciLow: number;
  ciHigh: number;
  level: number;
  /** Naive (unadjusted) difference, shown next to the adjusted one so confounding is visible. */
  naive: number | null;
  nTreated: number;
  nControl: number;
  clusters: number;
  reps: number;
  seed: number;
}

export interface StratifiedEstimate extends EffectEstimate {
  method: 'stratified_att';
  strata: number;
  /** Share of answered calls that have at least one comparable unanswered call. */
  overlapShare: number;
  /** Answered calls inside the supported (overlapping) strata. */
  nTreatedSupported: number;
  /** Unanswered calls inside the supported strata. */
  nControlSupported: number;
}

export interface DidEstimate extends EffectEstimate {
  method: 'did';
  treatedBusinesses: number;
  controlBusinesses: number;
  /** Pre-trend difference (slope per period); null when there are too few pre-periods. */
  preTrend: { point: number; ciLow: number; ciHigh: number; violated: boolean } | null;
}

// ---------------------------------------------------------------- deterministic PRNG

/** mulberry32: small, fast, good enough for bootstrap resampling (not cryptographic). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_REPS = 1000;
const DEFAULT_LEVEL = 0.95;
const DEFAULT_SEED = 20261205;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function resolveOptions(o: BootstrapOptions | undefined): Required<BootstrapOptions> {
  const reps = Math.max(200, Math.min(10_000, Math.floor(o?.reps ?? DEFAULT_REPS)));
  const level = o?.level !== undefined && o.level > 0.5 && o.level < 1 ? o.level : DEFAULT_LEVEL;
  return { reps, level, seed: o?.seed ?? DEFAULT_SEED };
}

function outcomeOf(o: CallObservation, key: OutcomeKey): number {
  return key === 'booked' ? (o.booked ? 1 : 0) : o.bookedRevenueCents;
}

// ---------------------------------------------------------------- 1. stratified ATT

interface Cell { nT: number; sT: number; nC: number; sC: number }

/** Stratum key includes the business, so every comparison is within one business. */
const stratumKey = (o: CallObservation): string =>
  [o.businessId, o.timeBlock, o.category, o.urgency, o.source].join('\u0000');

/**
 * ATT over a multiset of clusters. Cells are first MERGED by stratum key across the sampled clusters
 * (strata contain the business id, so cells of different businesses are never merged), then compared.
 */
function attFromClusters(
  clusters: ReadonlyArray<ReadonlyMap<string, Cell>>,
): { att: number; weight: number; nC: number } | null {
  const merged = new Map<string, Cell>();
  for (const cells of clusters) {
    for (const [k, c] of cells) {
      const m = merged.get(k);
      if (m) { m.nT += c.nT; m.sT += c.sT; m.nC += c.nC; m.sC += c.sC; }
      else merged.set(k, { ...c });
    }
  }
  let num = 0;
  let wT = 0;
  let nC = 0;
  for (const c of merged.values()) {
    if (c.nT === 0 || c.nC === 0) continue;
    num += c.nT * (c.sT / c.nT - c.sC / c.nC);
    wT += c.nT;
    nC += c.nC;
  }
  return wT === 0 ? null : { att: num / wT, weight: wT, nC };
}

export function stratifiedAtt(
  observations: readonly CallObservation[],
  outcome: OutcomeKey,
  options?: BootstrapOptions,
): StratifiedEstimate | null {
  const opt = resolveOptions(options);

  const byCluster = new Map<string, Map<string, Cell>>();
  let nTreated = 0;
  let nControl = 0;
  let sumT = 0;
  let sumC = 0;
  for (const o of observations) {
    const y = outcomeOf(o, outcome);
    if (!Number.isFinite(y)) continue;
    const cid = o.clusterId ?? o.businessId;
    let cells = byCluster.get(cid);
    if (!cells) { cells = new Map(); byCluster.set(cid, cells); }
    const k = stratumKey(o);
    let c = cells.get(k);
    if (!c) { c = { nT: 0, sT: 0, nC: 0, sC: 0 }; cells.set(k, c); }
    if (o.answered) { c.nT++; c.sT += y; nTreated++; sumT += y; } else { c.nC++; c.sC += y; nControl++; sumC += y; }
  }
  if (nTreated === 0 || nControl === 0) return null;

  const all = [...byCluster.values()];
  const base = attFromClusters(all);
  if (!base) return null;

  const pooled = new Map<string, Cell>();
  for (const cells of all) {
    for (const [k, c] of cells) {
      const m = pooled.get(k);
      if (m) { m.nT += c.nT; m.nC += c.nC; } else pooled.set(k, { ...c });
    }
  }
  let strata = 0;
  let nTSupported = 0;
  let nCSupported = 0;
  for (const c of pooled.values()) {
    if (c.nT > 0 && c.nC > 0) { strata++; nTSupported += c.nT; nCSupported += c.nC; }
  }

  const rng = makeRng(opt.seed);
  const draws: number[] = [];
  for (let r = 0; r < opt.reps; r++) {
    const sample: Array<Map<string, Cell>> = new Array(all.length);
    for (let i = 0; i < all.length; i++) sample[i] = all[Math.floor(rng() * all.length)]!;
    const est = attFromClusters(sample);
    if (est) draws.push(est.att);
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - opt.level) / 2;

  return {
    method: 'stratified_att',
    point: base.att,
    ciLow: percentile(draws, alpha),
    ciHigh: percentile(draws, 1 - alpha),
    level: opt.level,
    naive: sumT / nTreated - sumC / nControl,
    nTreated,
    nControl,
    clusters: byCluster.size,
    reps: draws.length,
    seed: opt.seed,
    strata,
    overlapShare: nTSupported / nTreated,
    nTreatedSupported: nTSupported,
    nControlSupported: nCSupported,
  };
}

// ---------------------------------------------------------------- 2. difference-in-differences

interface BizDid { treated: boolean; delta: number | null; slope: number | null }

function olsSlope(points: ReadonlyArray<readonly [number, number]>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) { mx += x; my += y; }
  mx /= n; my /= n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  return sxx === 0 ? null : sxy / sxx;
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function summarizeBusinesses(rows: readonly DidRow[], postStart: number): BizDid[] {
  const byBiz = new Map<string, { treated: boolean; periods: Map<number, { s: number; n: number }> }>();
  for (const r of rows) {
    if (!Number.isFinite(r.outcome) || !Number.isInteger(r.period)) continue;
    let b = byBiz.get(r.businessId);
    if (!b) { b = { treated: r.treatedGroup, periods: new Map() }; byBiz.set(r.businessId, b); }
    const p = b.periods.get(r.period) ?? { s: 0, n: 0 };
    p.s += r.outcome; p.n += 1;
    b.periods.set(r.period, p);
  }
  const out: BizDid[] = [];
  for (const b of byBiz.values()) {
    const pre: number[] = [];
    const post: number[] = [];
    const preSeries: Array<[number, number]> = [];
    for (const [period, p] of b.periods) {
      const m = p.s / p.n;
      if (period >= postStart) post.push(m); else { pre.push(m); preSeries.push([period, m]); }
    }
    out.push({
      treated: b.treated,
      delta: pre.length > 0 && post.length > 0 ? mean(post) - mean(pre) : null,
      slope: olsSlope(preSeries),
    });
  }
  return out;
}

function groupMeanDiff(units: readonly BizDid[], pick: (u: BizDid) => number | null): number | null {
  const t: number[] = [];
  const c: number[] = [];
  for (const u of units) {
    const v = pick(u);
    if (v === null) continue;
    (u.treated ? t : c).push(v);
  }
  return t.length > 0 && c.length > 0 ? mean(t) - mean(c) : null;
}

/** Resample treated and control businesses separately so both groups stay represented. */
function bootstrapDid(
  units: readonly BizDid[],
  pick: (u: BizDid) => number | null,
  opt: Required<BootstrapOptions>,
): number[] {
  const t = units.filter((u) => u.treated);
  const c = units.filter((u) => !u.treated);
  const rng = makeRng(opt.seed);
  const draws: number[] = [];
  for (let r = 0; r < opt.reps; r++) {
    const sample: BizDid[] = [];
    for (let i = 0; i < t.length; i++) sample.push(t[Math.floor(rng() * t.length)]!);
    for (let i = 0; i < c.length; i++) sample.push(c[Math.floor(rng() * c.length)]!);
    const d = groupMeanDiff(sample, pick);
    if (d !== null) draws.push(d);
  }
  return draws.sort((a, b) => a - b);
}

/**
 * Two-group, pre/post difference-in-differences with business as the unit.
 * `postStart` is the first period that counts as "after" (onboarding date, outage end, etc.).
 */
export function differenceInDifferences(
  rows: readonly DidRow[],
  postStart: number,
  options?: BootstrapOptions,
): DidEstimate | null {
  const opt = resolveOptions(options);
  const units = summarizeBusinesses(rows, postStart);
  const usable = units.filter((u) => u.delta !== null);
  const treated = usable.filter((u) => u.treated);
  const control = usable.filter((u) => !u.treated);
  if (treated.length === 0 || control.length === 0) return null;

  const point = groupMeanDiff(usable, (u) => u.delta);
  if (point === null) return null;
  const draws = bootstrapDid(usable, (u) => u.delta, opt);
  const alpha = (1 - opt.level) / 2;

  // Naive: post-period treated vs control levels, ignoring the pre period.
  const postLevel = (grp: boolean): number | null => {
    const v: number[] = [];
    const rowsG = rows.filter((r) => r.treatedGroup === grp && r.period >= postStart && Number.isFinite(r.outcome));
    for (const r of rowsG) v.push(r.outcome);
    return v.length > 0 ? mean(v) : null;
  };
  const nt = postLevel(true);
  const nc = postLevel(false);

  // Pre-trend diagnostic (needs >= 2 pre-periods in at least some businesses of each group).
  const slopeT = units.filter((u) => u.treated && u.slope !== null);
  const slopeC = units.filter((u) => !u.treated && u.slope !== null);
  let preTrend: DidEstimate['preTrend'] = null;
  if (slopeT.length >= 2 && slopeC.length >= 2) {
    const sp = groupMeanDiff(units, (u) => u.slope);
    if (sp !== null) {
      const sd = bootstrapDid(units.filter((u) => u.slope !== null), (u) => u.slope, opt);
      const lo = percentile(sd, alpha);
      const hi = percentile(sd, 1 - alpha);
      preTrend = { point: sp, ciLow: lo, ciHigh: hi, violated: lo > 0 || hi < 0 };
    }
  }

  return {
    method: 'did',
    point,
    ciLow: percentile(draws, alpha),
    ciHigh: percentile(draws, 1 - alpha),
    level: opt.level,
    naive: nt !== null && nc !== null ? nt - nc : null,
    nTreated: rows.filter((r) => r.treatedGroup).length,
    nControl: rows.filter((r) => !r.treatedGroup).length,
    clusters: usable.length,
    reps: draws.length,
    seed: opt.seed,
    treatedBusinesses: treated.length,
    controlBusinesses: control.length,
    preTrend,
  };
}

// ---------------------------------------------------------------- sensitivity

/**
 * E-value for a risk ratio (VanderWeele & Ding 2017): the minimum strength of association, on the
 * risk-ratio scale, that an unmeasured confounder would need with BOTH answering and booking to fully
 * explain away the observed ratio. RR < 1 is inverted first. Returns 1 when RR = 1.
 */
export function eValue(riskRatio: number): number {
  if (!Number.isFinite(riskRatio) || riskRatio <= 0) return Number.NaN;
  const rr = riskRatio < 1 ? 1 / riskRatio : riskRatio;
  return rr + Math.sqrt(rr * (rr - 1));
}

export interface BookingSensitivity {
  /** Booking rate among answered calls in supported strata. */
  rateAnswered: number;
  /** Matched counterfactual rate = rateAnswered - ATT. */
  rateCounterfactual: number;
  riskRatio: number | null;
  eValuePoint: number | null;
  /** E-value for the CI bound closest to the null; 1 when the CI spans the null. */
  eValueCiBound: number | null;
}

/** Sensitivity of the booking-rate effect. `est` must be the `booked` stratified estimate. */
export function bookingSensitivity(est: StratifiedEstimate, rateAnswered: number): BookingSensitivity {
  const cf = rateAnswered - est.point;
  const rr = cf > 0 ? rateAnswered / cf : null;
  const bound = est.ciLow > 0 ? est.ciLow : est.ciHigh < 0 ? est.ciHigh : null;
  let evCi: number | null = 1;
  if (bound === null) evCi = 1;
  else {
    const cfB = rateAnswered - bound;
    evCi = cfB > 0 ? eValue(rateAnswered / cfB) : null;
  }
  return {
    rateAnswered,
    rateCounterfactual: cf,
    riskRatio: rr,
    eValuePoint: rr === null ? null : eValue(rr),
    eValueCiBound: evCi,
  };
}

// ---------------------------------------------------------------- "can the data support a conclusion?"

export type Verdict = 'insufficient_data' | 'inconclusive' | 'supported_with_caveats';

export type Reason =
  | 'too_few_businesses'
  | 'too_few_answered_calls'
  | 'too_few_unanswered_calls'
  | 'poor_overlap'
  | 'interval_includes_zero'
  | 'interval_too_wide'
  | 'pretrend_violated'
  | 'weak_robustness_to_confounding';

/** Judgment-based defaults; documented in docs/incrementality/phase0.md and easy to tighten. */
export const THRESHOLDS = {
  minBusinesses: 5,
  minAnsweredCalls: 100,
  minUnansweredCalls: 30,
  minOverlapShare: 0.6,
  /** CI half-width must be below this multiple of |point| to avoid `interval_too_wide`. */
  maxRelativeHalfWidth: 1.0,
  /** Below this E-value for the CI bound, a modest unmeasured confounder could erase the result. */
  minEValueCiBound: 1.5,
} as const;

export interface Assessment {
  verdict: Verdict;
  reasons: Reason[];
  /** Always true: matching and DiD cannot rule out unobserved confounding. */
  residualConfoundingPossible: true;
}

export function assessEstimate(
  est: StratifiedEstimate | DidEstimate | null,
  sensitivity?: BookingSensitivity | null,
): Assessment {
  const reasons: Reason[] = [];
  const base = { residualConfoundingPossible: true } as const;
  if (est === null) return { verdict: 'insufficient_data', reasons: ['too_few_answered_calls', 'too_few_unanswered_calls'], ...base };

  if (est.method === 'stratified_att') {
    if (est.clusters < THRESHOLDS.minBusinesses) reasons.push('too_few_businesses'); // clusters: businesses, or time blocks for one account
    if (est.nTreatedSupported < THRESHOLDS.minAnsweredCalls) reasons.push('too_few_answered_calls');
    if (est.nControlSupported < THRESHOLDS.minUnansweredCalls) reasons.push('too_few_unanswered_calls');
    if (est.overlapShare < THRESHOLDS.minOverlapShare) reasons.push('poor_overlap');
  } else {
    if (est.treatedBusinesses < THRESHOLDS.minBusinesses || est.controlBusinesses < THRESHOLDS.minBusinesses) {
      reasons.push('too_few_businesses');
    }
    if (est.preTrend?.violated) reasons.push('pretrend_violated');
  }
  if (reasons.some((r) => r === 'too_few_businesses' || r === 'too_few_answered_calls' || r === 'too_few_unanswered_calls' || r === 'poor_overlap')) {
    return { verdict: 'insufficient_data', reasons, ...base };
  }

  const spansZero = est.ciLow <= 0 && est.ciHigh >= 0;
  if (spansZero) reasons.push('interval_includes_zero');
  else if ((est.ciHigh - est.ciLow) / 2 > THRESHOLDS.maxRelativeHalfWidth * Math.abs(est.point)) reasons.push('interval_too_wide');
  if (sensitivity && sensitivity.eValueCiBound !== null && !spansZero && sensitivity.eValueCiBound < THRESHOLDS.minEValueCiBound) {
    reasons.push('weak_robustness_to_confounding');
  }
  if (reasons.includes('pretrend_violated') || spansZero || reasons.includes('interval_too_wide')) {
    return { verdict: 'inconclusive', reasons, ...base };
  }
  return { verdict: 'supported_with_caveats', reasons, ...base };
}

// ---------------------------------------------------------------- projection to dollars

export interface IncrementalTotal {
  /** Incremental booked revenue over the supported answered calls, integer cents. */
  pointCents: number;
  ciLowCents: number;
  ciHighCents: number;
  /** Calls the figure is based on. Calls outside overlapping strata are NOT extrapolated. */
  basedOnAnsweredCalls: number;
}

/** Scale a per-call revenue ATT to the supported answered calls only (no extrapolation). */
export function incrementalRevenueTotal(est: StratifiedEstimate): IncrementalTotal {
  const n = est.nTreatedSupported;
  return {
    pointCents: Math.round(est.point * n),
    ciLowCents: Math.round(est.ciLow * n),
    ciHighCents: Math.round(est.ciHigh * n),
    basedOnAnsweredCalls: n,
  };
}
