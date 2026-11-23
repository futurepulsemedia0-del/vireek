/**
 * Experiment standards: sample-size planning, sample-ratio-mismatch (SRM) for any number of arms,
 * pre-declared decision rules (fixed horizon or group sequential with Lan-DeMets alpha spending),
 * multi-guardrail evaluation, and pre-registration validation.
 *
 * Pure and dependency-free apart from ./inference. It EXTENDS what already exists and does not replace it:
 *  - srmCheckArms() generalises srmCheck() from ./inference to any number of arms (agreement is tested)
 *  - results of existing experiments are still analysed by opsExperiments.ts / growthExperiments.ts
 * See docs/analytics/experiments.md.
 */
import { MIN_CELL_N, SRM_ALPHA, srmCheck, type Sample } from './inference';

// ---------------------------------------------------------------------------
// Numerics (accurate to ~1e-12; inference.ts uses a 1.5e-7 erf approximation that is fine for p-values
// but not for the extreme tail probabilities group-sequential boundaries depend on)
// ---------------------------------------------------------------------------

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised upper incomplete gamma Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Upper tail P(Z > z) of the standard normal. */
export function normalSf(z: number): number {
  const tail = 0.5 * gammaQ(0.5, (z * z) / 2);
  return z >= 0 ? tail : 1 - tail;
}

/** Chi-square survival function P(X > x) with `df` degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
  if (!(df > 0)) return NaN;
  return x <= 0 ? 1 : gammaQ(df / 2, x / 2);
}

/** Standard-normal quantile (Acklam's rational approximation polished with two Halley steps; error < 1e-12). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const tail = (q: number) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x: number;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  for (let i = 0; i < 2; i++) {
    const cdf = x < 0 ? normalSf(-x) : 1 - normalSf(x);
    const u = (cdf - p) * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

// ---------------------------------------------------------------------------
// 1. Sample-size calculator
// ---------------------------------------------------------------------------

export interface SampleSizeInput {
  kind: 'binary' | 'mean';
  /** binary: control rate in (0, 1). */
  baselineRate?: number;
  /** mean: standard deviation of the metric, in the same units as `mde`. */
  sd?: number;
  /** Smallest effect worth detecting (magnitude). Absolute unless `relative` is true. */
  mde: number;
  relative?: boolean;
  /** Significance level. Two-sided by default. */
  alpha?: number;
  power?: number;
  sides?: 1 | 2;
  /** Percent of units assigned to treatment, strictly between 0 and 100. Default 50. */
  treatmentShare?: number;
  /** Eligible units entering the experiment per day (both arms combined). */
  unitsPerDay?: number;
  /** Round the run length up to whole weeks so every weekday is represented equally. Default true. */
  wholeWeeks?: boolean;
}

export type SampleSizeError = 'invalid_alpha' | 'invalid_power' | 'invalid_share' | 'invalid_mde' | 'invalid_baseline' | 'invalid_sd' | 'effect_out_of_range';

export type SampleSizeResult =
  | { ok: true; control: number; treatment: number; total: number; days: number | null; absoluteMde: number }
  | { ok: false; error: SampleSizeError };

function zFor(alpha: number, power: number, sides: 1 | 2): number {
  return normalQuantile(1 - (sides === 2 ? alpha / 2 : alpha)) + normalQuantile(power);
}

/** Control-arm size for an absolute effect `delta`. `k` = treatment/control allocation ratio. */
function controlN(input: SampleSizeInput, delta: number, k: number, z: number): number | null {
  if (input.kind === 'binary') {
    const p0 = input.baselineRate as number;
    let p1 = p0 + delta;
    if (p1 >= 1) p1 = p0 - delta; // effect would leave (0,1): size for the opposite direction, as ops experiments do
    if (!(p1 > 0 && p1 < 1)) return null;
    return (z * z * (p0 * (1 - p0) + (p1 * (1 - p1)) / k)) / (delta * delta);
  }
  const sd = input.sd as number;
  return (z * z * sd * sd * (1 + 1 / k)) / (delta * delta);
}

function validateSizing(input: SampleSizeInput): SampleSizeError | null {
  const { alpha = 0.05, power = 0.8, treatmentShare = 50 } = input;
  if (!(alpha > 0 && alpha < 1)) return 'invalid_alpha';
  if (!(power > 0 && power < 1)) return 'invalid_power';
  if (!(treatmentShare > 0 && treatmentShare < 100)) return 'invalid_share';
  if (input.kind === 'binary' && !(typeof input.baselineRate === 'number' && input.baselineRate > 0 && input.baselineRate < 1)) return 'invalid_baseline';
  if (input.kind === 'mean' && !(typeof input.sd === 'number' && input.sd > 0 && Number.isFinite(input.sd))) return 'invalid_sd';
  return null;
}

export function sampleSize(input: SampleSizeInput): SampleSizeResult {
  const bad = validateSizing(input);
  if (bad) return { ok: false, error: bad };
  if (!(input.mde > 0) || !Number.isFinite(input.mde)) return { ok: false, error: 'invalid_mde' };
  const { alpha = 0.05, power = 0.8, sides = 2, treatmentShare = 50 } = input;
  const delta = input.relative ? (input.baselineRate ?? NaN) * input.mde : input.mde;
  if (!(delta > 0)) return { ok: false, error: input.relative ? 'invalid_baseline' : 'invalid_mde' };
  const k = treatmentShare / (100 - treatmentShare);
  const n = controlN(input, delta, k, zFor(alpha, power, sides));
  if (n === null) return { ok: false, error: 'effect_out_of_range' };
  const control = Math.ceil(n);
  const treatment = Math.ceil(k * n);
  const total = control + treatment;
  let days: number | null = null;
  if (input.unitsPerDay !== undefined && input.unitsPerDay > 0) {
    days = Math.ceil(total / input.unitsPerDay);
    if (input.wholeWeeks !== false) days = Math.ceil(days / 7) * 7;
  }
  return { ok: true, control, treatment, total, days, absoluteMde: delta };
}

/** Smallest absolute effect detectable with `control` units in the control arm (treatment follows the allocation). Null if none. */
export function minimumDetectableEffect(input: Omit<SampleSizeInput, 'mde' | 'relative'>, control: number): number | null {
  const probe = { ...input, mde: 1 };
  if (validateSizing(probe) || !(control > 0)) return null;
  const { alpha = 0.05, power = 0.8, sides = 2, treatmentShare = 50 } = input;
  const k = treatmentShare / (100 - treatmentShare);
  const z = zFor(alpha, power, sides);
  if (input.kind === 'mean') return z * (input.sd as number) * Math.sqrt((1 + 1 / k) / control);
  const p0 = input.baselineRate as number;
  let lo = 1e-9;
  let hi = 1 - p0 - 1e-9;
  const need = (d: number) => controlN(probe, d, k, z) as number;
  if (!(need(hi) <= control)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) <= control) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// 2. Sample-ratio mismatch for any number of arms
// ---------------------------------------------------------------------------

export interface SrmArmsResult {
  status: 'ok' | 'mismatch' | 'insufficient_data';
  p: number;
  chi2: number;
  df: number;
  observed: number[];
  expected: number[];
}

/** Minimum expected count per arm for the chi-square approximation to be trusted. */
export const SRM_MIN_EXPECTED = 5;

/**
 * Chi-square goodness-of-fit of ENROLLED units per arm against the planned split.
 * `shares` are the planned proportions (any positive scale: [50, 50], [1, 1, 2]).
 * Run it on assignment counts, never on units that happened to produce an outcome.
 */
export function srmCheckArms(observed: number[], shares: number[], alpha: number = SRM_ALPHA): SrmArmsResult {
  if (observed.length < 2 || observed.length !== shares.length) throw new RangeError('srmCheckArms needs at least two arms and one share per arm');
  if (observed.some((n) => !(n >= 0) || !Number.isFinite(n))) throw new RangeError('srmCheckArms: counts must be finite and non-negative');
  if (shares.some((s) => !(s > 0) || !Number.isFinite(s))) throw new RangeError('srmCheckArms: shares must be positive');
  const total = observed.reduce((a, b) => a + b, 0);
  const shareSum = shares.reduce((a, b) => a + b, 0);
  const expected = shares.map((s) => (total * s) / shareSum);
  const df = observed.length - 1;
  if (total === 0 || expected.some((e) => e < SRM_MIN_EXPECTED)) return { status: 'insufficient_data', p: 1, chi2: 0, df, observed, expected };
  const chi2 = observed.reduce((acc, o, i) => acc + (o - expected[i]) ** 2 / expected[i], 0);
  const p = chiSquareSf(chi2, df);
  return { status: p < alpha ? 'mismatch' : 'ok', p, chi2, df, observed, expected };
}

// ---------------------------------------------------------------------------
// 3. Decision rules: fixed horizon or group sequential (Lan-DeMets alpha spending)
// ---------------------------------------------------------------------------

export type SpendingFunction = 'obrien_fleming' | 'pocock';

export type DecisionRule =
  | { kind: 'fixed_horizon'; alpha: number }
  | {
      kind: 'group_sequential';
      alpha: number;
      spending: SpendingFunction;
      /** Planned information fractions of the looks, strictly increasing, last = 1. */
      plannedLooks: number[];
      /** Optional, non-binding: advise stopping when conditional power falls below this (checked from 50% information). */
      futilityConditionalPower?: number;
    };

/** Cumulative two-sided type-I error allowed to be spent by information fraction t. */
export function alphaSpent(t: number, alpha: number, spending: SpendingFunction): number {
  if (t <= 0) return 0;
  if (t >= 1) return alpha;
  return spending === 'obrien_fleming' ? 2 * normalSf(normalQuantile(1 - alpha / 2) / Math.sqrt(t)) : alpha * Math.log(1 + (Math.E - 1) * t);
}

const GRID_NODES = 401;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

interface Mass {
  u: number[];
  m: number[];
}

/** P(cross at this look) for a process whose surviving mass is `prev`; `cs` = boundary on the B(t) scale. */
function crossingMass(prev: Mass, sigma: number, shift: number, cs: number): number {
  let total = 0;
  for (let i = 0; i < prev.u.length; i++) {
    const mu = prev.u[i] + shift;
    total += prev.m[i] * (normalSf((cs - mu) / sigma) + normalSf((cs + mu) / sigma));
  }
  return total;
}

function advanceMass(prev: Mass, sigma: number, shift: number, cs: number): Mass {
  const n = GRID_NODES;
  const h = (2 * cs) / (n - 1);
  const u: number[] = [];
  const m: number[] = [];
  for (let j = 0; j < n; j++) {
    const s = -cs + j * h;
    let dens = 0;
    for (let i = 0; i < prev.u.length; i++) {
      const z = (s - prev.u[i] - shift) / sigma;
      dens += prev.m[i] * Math.exp(-0.5 * z * z);
    }
    u.push(s);
    m.push((dens / (sigma * SQRT_2PI)) * h * (j === 0 || j === n - 1 ? 0.5 : 1));
  }
  return { u, m };
}

function validateLooks(fractions: number[]): void {
  if (fractions.length === 0) throw new RangeError('At least one look is required');
  let prev = 0;
  for (const t of fractions) {
    if (!(t > prev && t <= 1)) throw new RangeError('Look fractions must be strictly increasing and within (0, 1]');
    prev = t;
  }
}

/**
 * Two-sided critical |z| at each look for the looks ACTUALLY TAKEN (Lan-DeMets: looks need not match the plan).
 * Computed by exact recursive numerical integration, so the total type-I error equals the spent alpha.
 */
export function sequentialBoundaries(fractions: number[], alpha: number, spending: SpendingFunction): number[] {
  validateLooks(fractions);
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('alpha must be in (0, 1)');
  const bounds: number[] = [];
  let prev: Mass = { u: [0], m: [1] };
  let tPrev = 0;
  let spentBefore = 0;
  for (const t of fractions) {
    const target = alphaSpent(t, alpha, spending) - spentBefore;
    const sigma = Math.sqrt(t - tPrev);
    const root = Math.sqrt(t);
    let lo = 0;
    let hi = 12;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (crossingMass(prev, sigma, 0, mid * root) > target) lo = mid;
      else hi = mid;
    }
    const c = (lo + hi) / 2;
    bounds.push(c);
    if (t < fractions[fractions.length - 1]) prev = advanceMass(prev, sigma, 0, c * root);
    tPrev = t;
    spentBefore += target;
  }
  return bounds;
}

/** Probability of crossing at any look when the final-information z-statistic has mean `drift`. */
export function sequentialCrossingProbability(fractions: number[], boundaries: number[], drift: number): number {
  validateLooks(fractions);
  let prev: Mass = { u: [0], m: [1] };
  let tPrev = 0;
  let total = 0;
  fractions.forEach((t, k) => {
    const sigma = Math.sqrt(t - tPrev);
    const shift = drift * (t - tPrev);
    const cs = boundaries[k] * Math.sqrt(t);
    total += crossingMass(prev, sigma, shift, cs);
    if (k < fractions.length - 1) prev = advanceMass(prev, sigma, shift, cs);
    tPrev = t;
  });
  return total;
}

/** Factor by which a group-sequential design needs more units than a fixed-horizon design for the same power. */
export function sequentialInflation(fractions: number[], alpha: number, spending: SpendingFunction, power = 0.8): number {
  const bounds = sequentialBoundaries(fractions, alpha, spending);
  const thetaFixed = zFor(alpha, power, 2);
  let lo = thetaFixed * 0.5;
  let hi = thetaFixed * 2;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) / 2;
    if (sequentialCrossingProbability(fractions, bounds, mid) < power) lo = mid;
    else hi = mid;
  }
  const thetaSeq = (lo + hi) / 2;
  return (thetaSeq / thetaFixed) ** 2;
}

/** Sample size under a declared decision rule (sequential designs are inflated so power is preserved). */
export function sampleSizeForRule(input: SampleSizeInput, rule: DecisionRule): SampleSizeResult {
  const base = sampleSize({ ...input, alpha: rule.alpha, sides: 2 });
  if (!base.ok || rule.kind === 'fixed_horizon') return base;
  const f = sequentialInflation(rule.plannedLooks, rule.alpha, rule.spending, input.power ?? 0.8);
  const control = Math.ceil(base.control * f);
  const treatment = Math.ceil(base.treatment * f);
  const total = control + treatment;
  let days: number | null = null;
  if (input.unitsPerDay !== undefined && input.unitsPerDay > 0) {
    days = Math.ceil(total / input.unitsPerDay);
    if (input.wholeWeeks !== false) days = Math.ceil(days / 7) * 7;
  }
  return { ok: true, control, treatment, total, days, absoluteMde: base.absoluteMde };
}

export interface InterimInput {
  /** Information fractions of every look taken so far, INCLUDING the current one (last). */
  looksTaken: number[];
  /** Two-sided z-statistic at the current look (sign = direction of the effect). */
  z: number;
}

export type RuleAction = 'continue' | 'stop_efficacy' | 'stop_not_significant' | 'futility_advised';

export interface RuleDecision {
  action: RuleAction;
  direction: 'positive' | 'negative' | null;
  criticalZ: number;
  conditionalPower: number | null;
  reason: 'before_horizon' | 'boundary_crossed' | 'horizon_reached_not_significant' | 'low_conditional_power' | 'inside_boundaries';
}

/** Conditional power of reaching the final boundary if the current trend continues. Needs 0 < t < 1. */
export function conditionalPower(zNow: number, t: number, alpha: number): number {
  if (!(t > 0 && t < 1)) return NaN;
  const zFinal = normalQuantile(1 - alpha / 2);
  const dir = (Math.abs(zNow) / Math.sqrt(t) - zFinal) / Math.sqrt(1 - t);
  return 1 - normalSf(dir);
}

/**
 * Applies a pre-declared rule at the current look. Fixed horizon: no verdict at all before the horizon.
 * Group sequential: stop only when |z| crosses the spending-function boundary for the looks taken.
 */
export function decideAtLook(rule: DecisionRule, input: InterimInput): RuleDecision {
  validateLooks(input.looksTaken);
  const t = input.looksTaken[input.looksTaken.length - 1];
  const direction = input.z > 0 ? 'positive' : input.z < 0 ? 'negative' : null;
  if (rule.kind === 'fixed_horizon') {
    const criticalZ = normalQuantile(1 - rule.alpha / 2);
    if (t < 1) return { action: 'continue', direction, criticalZ, conditionalPower: null, reason: 'before_horizon' };
    return Math.abs(input.z) >= criticalZ
      ? { action: 'stop_efficacy', direction, criticalZ, conditionalPower: null, reason: 'boundary_crossed' }
      : { action: 'stop_not_significant', direction, criticalZ, conditionalPower: null, reason: 'horizon_reached_not_significant' };
  }
  const bounds = sequentialBoundaries(input.looksTaken, rule.alpha, rule.spending);
  const criticalZ = bounds[bounds.length - 1];
  if (Math.abs(input.z) >= criticalZ) return { action: 'stop_efficacy', direction, criticalZ, conditionalPower: null, reason: 'boundary_crossed' };
  if (t >= 1) return { action: 'stop_not_significant', direction, criticalZ, conditionalPower: null, reason: 'horizon_reached_not_significant' };
  const cp = conditionalPower(input.z, t, rule.alpha);
  if (rule.futilityConditionalPower !== undefined && t >= 0.5 && cp < rule.futilityConditionalPower) {
    return { action: 'futility_advised', direction, criticalZ, conditionalPower: cp, reason: 'low_conditional_power' };
  }
  return { action: 'continue', direction, criticalZ, conditionalPower: cp, reason: 'inside_boundaries' };
}

/** Information fraction from observed vs planned units in the smaller arm, capped at 1. */
export function informationFraction(observedPerArm: number, plannedPerArm: number): number {
  if (!(plannedPerArm > 0) || !(observedPerArm > 0)) return 0;
  return Math.min(1, observedPerArm / plannedPerArm);
}

// ---------------------------------------------------------------------------
// 4. Guardrail metrics (non-inferiority, any number of guardrails)
// ---------------------------------------------------------------------------

export interface GuardrailSpec {
  name: string;
  /** Which direction of change hurts: 'increase' (cancellations) or 'decrease' (completion rate). */
  harm: 'increase' | 'decrease';
  /** Largest tolerated worsening, absolute, in the metric's units. */
  tolerance: number;
  /** One-sided error rate used for the breach call. Default 0.05. */
  alpha?: number;
}

export type GuardrailStatus = 'ok' | 'watch' | 'breached' | 'unknown';

export interface GuardrailEvaluation {
  name: string;
  status: GuardrailStatus;
  reason: 'insufficient_sample' | 'invalid_input' | 'breach' | 'non_inferior' | 'inconclusive';
  /** Estimated worsening (positive = worse), and its one-sided bounds. */
  harm: number | null;
  harmLow: number | null;
  harmHigh: number | null;
}

/** Sample summary for a yes/no metric: k events out of n. */
export function binarySample(k: number, n: number): Sample {
  if (!(n > 0) || k < 0 || k > n) return { n: 0, mean: 0, variance: 0 };
  const p = k / n;
  return { n, mean: p, variance: n > 1 ? (p * (1 - p) * n) / (n - 1) : 0 };
}

const unknownGuardrail = (name: string, reason: GuardrailEvaluation['reason']): GuardrailEvaluation => ({ name, status: 'unknown', reason, harm: null, harmLow: null, harmHigh: null });

/**
 * Breached: the harm is, with confidence, worse than the tolerance. Ok: harm is shown to be within tolerance.
 * Watch: neither is established. Unknown: not enough data.
 */
export function evaluateGuardrail(spec: GuardrailSpec, treatment: Sample, control: Sample): GuardrailEvaluation {
  const alpha = spec.alpha ?? 0.05;
  const values = [treatment.n, treatment.mean, treatment.variance, control.n, control.mean, control.variance, spec.tolerance];
  if (values.some((v) => !Number.isFinite(v)) || !(alpha > 0 && alpha < 0.5) || spec.tolerance < 0) return unknownGuardrail(spec.name, 'invalid_input');
  if (treatment.n < MIN_CELL_N || control.n < MIN_CELL_N) return unknownGuardrail(spec.name, 'insufficient_sample');
  const diff = treatment.mean - control.mean;
  const harm = spec.harm === 'increase' ? diff : -diff;
  const se = Math.sqrt(treatment.variance / treatment.n + control.variance / control.n);
  const z = normalQuantile(1 - alpha);
  const harmLow = harm - z * se;
  const harmHigh = harm + z * se;
  const base = { name: spec.name, harm, harmLow, harmHigh };
  if (harmLow > spec.tolerance) return { ...base, status: 'breached', reason: 'breach' };
  if (harmHigh <= spec.tolerance) return { ...base, status: 'ok', reason: 'non_inferior' };
  return { ...base, status: 'watch', reason: 'inconclusive' };
}

export interface GuardrailRollup {
  status: GuardrailStatus;
  breached: string[];
  watch: string[];
  unknown: string[];
  /** Chance that at least one guardrail is flagged as breached by luck alone when none is harmed. Not corrected for on purpose. */
  falseBreachProbability: number;
  action: 'stop_and_investigate' | 'continue_monitoring' | 'clear';
}

/** Any breach wins. No multiplicity correction: missing real harm costs more than a false alarm, so the alarm rate is reported instead. */
export function rollupGuardrails(evals: GuardrailEvaluation[], alpha = 0.05): GuardrailRollup {
  const names = (s: GuardrailStatus) => evals.filter((e) => e.status === s).map((e) => e.name);
  const breached = names('breached');
  const watch = names('watch');
  const unknown = names('unknown');
  const status: GuardrailStatus = breached.length ? 'breached' : watch.length ? 'watch' : unknown.length ? 'unknown' : 'ok';
  return {
    status,
    breached,
    watch,
    unknown,
    falseBreachProbability: 1 - (1 - alpha) ** evals.length,
    action: status === 'breached' ? 'stop_and_investigate' : status === 'ok' ? 'clear' : 'continue_monitoring',
  };
}

/** The worsening the breach call would catch with probability `power`, given group sizes and metric spread. */
export function detectableHarm(spec: GuardrailSpec, sd: number, nTreatment: number, nControl: number, power = 0.8): number | null {
  if (!(sd > 0) || !(nTreatment > 0) || !(nControl > 0)) return null;
  const se = sd * Math.sqrt(1 / nTreatment + 1 / nControl);
  return spec.tolerance + (normalQuantile(1 - (spec.alpha ?? 0.05)) + normalQuantile(power)) * se;
}

// ---------------------------------------------------------------------------
// 5. Pre-registration
// ---------------------------------------------------------------------------

export interface PreRegistration {
  experimentKey: string;
  owner: string;
  /** ISO timestamp the plan was frozen. Must not be after the experiment starts. */
  registeredAt: string;
  /** ISO timestamp of the actual or planned start. */
  startsAt: string | null;
  hypothesis: string;
  intervention: string;
  /** Who is eligible and what is randomised (visitor, account, job...). */
  population: string;
  unitOfRandomization: string;
  /** Percent assigned to treatment. */
  treatmentShare: number;
  primaryMetric: { name: string; definition: string; kind: 'binary' | 'mean'; baseline: number; sd?: number };
  mde: { value: number; relative: boolean };
  alpha: number;
  power: number;
  plannedControl: number;
  plannedTreatment: number;
  decisionRule: DecisionRule;
  guardrails: GuardrailSpec[];
  secondaryMetrics: string[];
  srm: { declared: boolean; alpha: number };
  maxDays: number;
  exclusions: string;
  analysisPlan: string;
  /** What will be done for each outcome, decided before seeing data. */
  decisions: { win: string; noEffect: string; loss: string };
}

export interface PreRegIssue {
  code: string;
  message: string;
}

export interface PreRegValidation {
  errors: PreRegIssue[];
  warnings: PreRegIssue[];
}

const text = (s: unknown, min: number) => typeof s === 'string' && s.trim().length >= min;
const time = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s));

export function validatePreRegistration(p: PreRegistration): PreRegValidation {
  const errors: PreRegIssue[] = [];
  const warnings: PreRegIssue[] = [];
  const err = (code: string, message: string) => errors.push({ code, message });
  const warn = (code: string, message: string) => warnings.push({ code, message });

  if (!text(p.experimentKey, 3)) err('missing_key', 'Give the experiment a key.');
  if (!text(p.owner, 2)) err('missing_owner', 'Name the person accountable for this experiment.');
  if (!text(p.hypothesis, 20)) err('missing_hypothesis', 'State the hypothesis: what changes, for whom, and why you expect it.');
  if (!text(p.intervention, 10)) err('missing_intervention', 'Describe exactly what the treatment group gets.');
  if (!text(p.population, 10)) err('missing_population', 'Say who is eligible.');
  if (!text(p.unitOfRandomization, 3)) err('missing_unit', 'Say what is randomised (visitor, account, job).');
  if (!text(p.exclusions, 4)) err('missing_exclusions', 'List exclusions, or write "none".');
  if (!text(p.analysisPlan, 20)) err('missing_analysis_plan', 'Describe the analysis: test, population (all assigned or only those exposed), handling of missing data.');
  if (!text(p.decisions?.win, 5) || !text(p.decisions?.noEffect, 5) || !text(p.decisions?.loss, 5)) err('missing_decisions', 'Decide in advance what you will do on a win, on no effect and on a loss.');

  if (!time(p.registeredAt)) err('invalid_registered_at', 'registeredAt must be an ISO timestamp.');
  if (p.startsAt !== null && !time(p.startsAt)) err('invalid_starts_at', 'startsAt must be an ISO timestamp or null.');
  if (time(p.registeredAt) && p.startsAt !== null && time(p.startsAt) && Date.parse(p.registeredAt) > Date.parse(p.startsAt)) {
    err('registered_after_start', 'The plan was registered after the experiment started, so it cannot count as pre-registered.');
  }

  if (!(p.treatmentShare > 0 && p.treatmentShare < 100)) err('invalid_share', 'Treatment share must be between 0 and 100 (exclusive).');
  if (!(p.alpha > 0 && p.alpha <= 0.1)) err('invalid_alpha', 'Alpha must be above 0 and at most 0.10.');
  if (!(p.power > 0 && p.power < 1)) err('invalid_power', 'Power must be between 0 and 1.');
  else if (p.power < 0.8) warn('low_power', 'Power below 80% means a real effect is missed more than one time in five.');
  if (!(p.mde?.value > 0)) err('invalid_mde', 'The smallest effect worth detecting must be above zero.');
  if (!text(p.primaryMetric?.name, 2) || !text(p.primaryMetric?.definition, 10)) err('missing_primary_metric', 'Define exactly one primary metric, including how it is computed.');
  if (p.secondaryMetrics.includes(p.primaryMetric?.name)) err('primary_in_secondary', 'The primary metric cannot also be a secondary metric.');
  if (p.secondaryMetrics.length > 5) warn('many_secondary', 'More than five secondary metrics: treat them as exploratory, they are not corrected for multiple looks.');

  if (!(p.maxDays >= 7)) err('run_too_short', 'Plan at least 7 days so every weekday is represented.');
  else if (p.maxDays % 7 !== 0) warn('partial_week', 'Run length is not a whole number of weeks; weekday mix will differ between start and end.');

  if (!p.srm?.declared) err('srm_not_declared', 'Declare that a sample-ratio-mismatch check will be run and that a failure invalidates the result.');
  else if (!(p.srm.alpha > 0 && p.srm.alpha <= 0.01)) err('invalid_srm_alpha', 'Use a strict SRM threshold, at most 0.01 (default 0.001).');

  if (p.decisionRule.alpha !== p.alpha) err('rule_alpha_mismatch', 'The decision rule must use the same alpha as the plan.');
  if (p.decisionRule.kind === 'group_sequential') {
    const looks = p.decisionRule.plannedLooks;
    const increasing = looks.length >= 2 && looks.every((t, i) => t > (i === 0 ? 0 : looks[i - 1]) && t <= 1) && looks[looks.length - 1] === 1;
    if (!increasing) err('invalid_looks', 'Planned looks must be at least two, strictly increasing, ending at 1.');
    else if (looks.length > 10) warn('many_looks', 'More than ten looks: the sample-size penalty grows and each look still needs someone to act on it.');
  }

  if (!Array.isArray(p.guardrails) || p.guardrails.length === 0) err('no_guardrail', 'Name at least one guardrail metric with a tolerance.');
  else {
    const seen = new Set<string>();
    for (const g of p.guardrails) {
      if (!text(g.name, 2)) err('guardrail_name', 'Every guardrail needs a name.');
      if (g.name === p.primaryMetric?.name) err('guardrail_is_primary', `Guardrail "${g.name}" cannot be the primary metric.`);
      if (seen.has(g.name)) err('guardrail_duplicate', `Guardrail "${g.name}" is listed twice.`);
      seen.add(g.name);
      if (!(Number.isFinite(g.tolerance) && g.tolerance >= 0)) err('guardrail_tolerance', `Guardrail "${g.name}" needs a tolerance of zero or more.`);
    }
  }

  // The declared sample must cover what the declared design needs.
  const sizing: SampleSizeInput | null =
    p.primaryMetric?.kind === 'binary'
      ? { kind: 'binary', baselineRate: p.primaryMetric.baseline, mde: p.mde?.value, relative: p.mde?.relative, alpha: p.alpha, power: p.power, treatmentShare: p.treatmentShare }
      : p.primaryMetric?.kind === 'mean'
        ? { kind: 'mean', sd: p.primaryMetric.sd, mde: p.mde?.value, relative: p.mde?.relative, alpha: p.alpha, power: p.power, treatmentShare: p.treatmentShare }
        : null;
  if (!sizing) err('invalid_metric_kind', 'Primary metric kind must be "binary" or "mean".');
  else if (!errors.some((e) => ['invalid_alpha', 'invalid_power', 'invalid_share', 'invalid_mde', 'invalid_looks'].includes(e.code))) {
    const need = sampleSizeForRule(sizing, p.decisionRule);
    if (!need.ok) err('sizing_failed', `The sample size cannot be computed from the declared baseline, spread and effect (${need.error}).`);
    else if (!(p.plannedControl >= need.control) || !(p.plannedTreatment >= need.treatment)) {
      err('underpowered_plan', `The plan needs at least ${need.control} control and ${need.treatment} treatment units for ${Math.round(p.power * 100)}% power; it declares ${p.plannedControl} and ${p.plannedTreatment}.`);
    }
  }

  return { errors, warnings };
}
