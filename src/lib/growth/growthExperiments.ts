/**
 * Growth experiments — analysis of two-arm, tenant-level binary outcomes.
 * Raw counts come from staff_growth_experiment_results(); every inference decision lives here.
 * Statistics are shared with ops experiments via src/lib/stats/inference.ts.
 *
 * Anti-peeking: no verdict (win/loss/no_effect) is issued before the pre-registered minimum runtime, even if p < alpha.
 */
import { MIN_BINARY_EVENTS, MIN_CELL_N, srmCheck, twoSidedP, type SrmResult } from '@/lib/stats/inference';

export type GrowthMetric = 'activated_7d' | 'trial_to_paid';
export type GrowthAlpha = 0.01 | 0.05 | 0.1;
export type GrowthVerdict = 'collecting' | 'invalid' | 'win' | 'loss' | 'no_effect' | 'inconclusive';
export type GrowthRecommendation = 'continue' | 'adopt' | 'adopt_monitor' | 'iterate' | 'reject' | 'fix_design';
export type GuardrailStatus = 'ok' | 'watch' | 'breached' | 'unknown';

export interface ArmCounts {
  assigned: number;
  activation_n: number;
  activation_k: number;
  trial_n: number;
  trial_k: number;
  paying_n: number;
  cancel_k: number;
}
export interface ExperimentMeta {
  key: string;
  status: 'draft' | 'running' | 'concluded' | 'archived';
  treatment_share: number;
  primary_metric: GrowthMetric;
  min_runtime_days: number;
  alpha: GrowthAlpha;
  started_at: string | null;
  ended_at: string | null;
}
export interface ExperimentResultsRaw {
  experiment: ExperimentMeta;
  arms: { control?: ArmCounts; treatment?: ArmCounts };
}

const Z: Record<GrowthAlpha, number> = { 0.01: 2.5758293035489, 0.05: 1.959963984540054, 0.1: 1.6448536269514722 };
const Z_POWER_80 = 0.8416212335729143;
const DAY = 86_400_000;
/** CI fully inside ±2 percentage points is reported as "no practical effect", not "inconclusive". */
export const PRACTICAL_EQUIVALENCE = 0.02;
/** A non-significant guardrail worsening beyond this many points is surfaced as "watch". */
export const GUARDRAIL_WATCH_DELTA = 0.02;

export interface TwoProportion {
  nT: number;
  nC: number;
  pT: number;
  pC: number;
  effect: number;
  se: number;
  z: number;
  p: number;
  ciLow: number;
  ciHigh: number;
}

/** Difference in proportions (treatment − control). Unpooled SE for the CI, pooled SE for the test. Null if a cell is empty. */
export function twoProportion(kT: number, nT: number, kC: number, nC: number, zCrit: number): TwoProportion | null {
  if (nT <= 0 || nC <= 0 || kT < 0 || kC < 0 || kT > nT || kC > nC) return null;
  const pT = kT / nT;
  const pC = kC / nC;
  const effect = pT - pC;
  const se = Math.sqrt((pT * (1 - pT)) / nT + (pC * (1 - pC)) / nC);
  const pooled = (kT + kC) / (nT + nC);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / nT + 1 / nC));
  const z = sePooled > 0 ? effect / sePooled : 0;
  return { nT, nC, pT, pC, effect, se, z, p: twoSidedP(z), ciLow: effect - zCrit * se, ciHigh: effect + zCrit * se };
}

/** Per-arm sample size for a two-sided test at 80% power. `mde` is an absolute difference (e.g. 0.05 = 5 pp). */
export function requiredPerArm(baselineRate: number, mde: number, alpha: GrowthAlpha): number | null {
  if (!(baselineRate > 0 && baselineRate < 1) || !(mde > 0) || baselineRate + mde >= 1) return null;
  const p2 = baselineRate + mde;
  const k = (Z[alpha] + Z_POWER_80) ** 2;
  return Math.ceil((k * (baselineRate * (1 - baselineRate) + p2 * (1 - p2))) / (mde * mde));
}

function sparse(k: number, n: number): boolean {
  return k < MIN_BINARY_EVENTS || n - k < MIN_BINARY_EVENTS;
}

export interface GuardrailResult {
  status: GuardrailStatus;
  name: 'cancel_requested';
  estimate: TwoProportion | null;
}

export interface ExperimentAnalysis {
  verdict: GrowthVerdict;
  recommendation: GrowthRecommendation;
  /** i18n keys under growth.exp.reason.* explaining the verdict. */
  reasons: string[];
  primary: TwoProportion | null;
  srm: SrmResult | null;
  guardrail: GuardrailResult;
  elapsedDays: number;
  minRuntimeMet: boolean;
}

function primaryCounts(raw: ExperimentResultsRaw): { kT: number; nT: number; kC: number; nC: number } | null {
  const t = raw.arms.treatment;
  const c = raw.arms.control;
  if (!t || !c) return null;
  return raw.experiment.primary_metric === 'activated_7d'
    ? { kT: t.activation_k, nT: t.activation_n, kC: c.activation_k, nC: c.activation_n }
    : { kT: t.trial_k, nT: t.trial_n, kC: c.trial_k, nC: c.trial_n };
}

function evaluateGuardrail(raw: ExperimentResultsRaw, zCrit: number, alpha: GrowthAlpha): GuardrailResult {
  const t = raw.arms.treatment;
  const c = raw.arms.control;
  const unknown: GuardrailResult = { status: 'unknown', name: 'cancel_requested', estimate: null };
  if (!t || !c || t.paying_n < MIN_CELL_N || c.paying_n < MIN_CELL_N) return unknown;
  const est = twoProportion(t.cancel_k, t.paying_n, c.cancel_k, c.paying_n, zCrit);
  if (!est) return unknown;
  // Higher cancellation is worse.
  if (est.effect > 0 && est.p < alpha) return { status: 'breached', name: 'cancel_requested', estimate: est };
  if (est.effect > GUARDRAIL_WATCH_DELTA) return { status: 'watch', name: 'cancel_requested', estimate: est };
  return { status: 'ok', name: 'cancel_requested', estimate: est };
}

export function analyzeGrowthExperiment(raw: ExperimentResultsRaw, now: Date): ExperimentAnalysis {
  const exp = raw.experiment;
  const alpha = exp.alpha;
  const zCrit = Z[alpha];
  const started = exp.started_at ? new Date(exp.started_at).getTime() : null;
  const end = exp.ended_at ? new Date(exp.ended_at).getTime() : now.getTime();
  const elapsedDays = started === null ? 0 : Math.max(0, (end - started) / DAY);
  const minRuntimeMet = elapsedDays >= exp.min_runtime_days;
  const guardrail = evaluateGuardrail(raw, zCrit, alpha);

  const t = raw.arms.treatment;
  const c = raw.arms.control;
  const srm = t && c ? srmCheck(t.assigned, c.assigned, exp.treatment_share) : null;
  const base = { guardrail, elapsedDays, minRuntimeMet, srm };

  if (srm?.failed) {
    return { ...base, verdict: 'invalid', recommendation: 'fix_design', reasons: ['srm_failed'], primary: null };
  }
  const counts = primaryCounts(raw);
  if (!counts) {
    return { ...base, verdict: 'collecting', recommendation: 'continue', reasons: ['arm_missing'], primary: null };
  }
  const primary = twoProportion(counts.kT, counts.nT, counts.kC, counts.nC, zCrit);
  const reasons: string[] = [];
  if (counts.nT < MIN_CELL_N || counts.nC < MIN_CELL_N) reasons.push('sample_below_minimum');
  else if (sparse(counts.kT, counts.nT) || sparse(counts.kC, counts.nC)) reasons.push('too_few_events');
  if (!minRuntimeMet) reasons.push('runtime_not_reached');
  if (reasons.length > 0 || !primary) {
    return { ...base, verdict: 'collecting', recommendation: 'continue', reasons, primary };
  }

  let verdict: GrowthVerdict;
  if (primary.p < alpha) verdict = primary.effect > 0 ? 'win' : 'loss';
  else if (primary.ciLow > -PRACTICAL_EQUIVALENCE && primary.ciHigh < PRACTICAL_EQUIVALENCE) verdict = 'no_effect';
  else verdict = 'inconclusive';

  let recommendation: GrowthRecommendation;
  if (verdict === 'win') {
    recommendation = guardrail.status === 'breached' ? 'iterate' : guardrail.status === 'ok' ? 'adopt' : 'adopt_monitor';
    if (guardrail.status === 'breached') reasons.push('guardrail_breached');
    if (guardrail.status === 'unknown') reasons.push('guardrail_unknown');
  } else if (verdict === 'loss') recommendation = 'reject';
  else recommendation = 'iterate';
  return { ...base, verdict, recommendation, reasons, primary };
}
