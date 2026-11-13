// Analysis for "natural randomization" (near-tie draws logged in dispatch_decisions.explanation.randomization).
// PURE. Propensity-aware (Hájek / inverse-probability-weighted) contrast between two technician groups,
// sample-ratio check, workload balance, power, and plain-language result. Reuses opsExperiments numerics.
//
// Estimand: effect of being sent a "treatment-group" technician instead of a "control-group" technician,
// among near-tied jobs ONLY (local effect), intention-to-treat on the DRAWN technician.

import {
  MIN_BINARY_EVENTS,
  MIN_CELL_N,
  METRICS,
  Z_TWO_SIDED,
  benefitOf,
  buildReworkedSet,
  decideVerdict,
  fromDisplay,
  matchesService,
  observe,
  recommend,
  requiredPerArm,
  twoSidedP,
  type Alpha,
  type Analysis,
  type Assignment,
  type Baseline,
  type EvidenceGrade,
  type Estimate,
  type ExpJob,
  type ExperimentConfig,
  type GuardrailResult,
  type GuardrailStatus,
  type MetricKey,
  type MetricResult,
  type ObserveContext,
  type SrmResult,
} from './opsExperiments';

export interface TieMember { technician_id: string; score: number }
export interface NaturalRecord {
  job_id: string;
  tie_set: TieMember[];
  drawn_technician_id: string;
  executed_as_drawn: boolean;
  /** Metric value for the job (0/1 for binary metrics) or null while immature. */
  outcome: number | null;
}

/** Extract a record from a dispatch_decisions row's explanation; null when randomization was not applied. */
export function recordFromExplanation(jobId: string, explanation: unknown, outcome: number | null): NaturalRecord | null {
  const rz = (explanation as { randomization?: Record<string, unknown> } | null)?.randomization;
  if (!rz || rz.applied !== true || !Array.isArray(rz.tie_set) || typeof rz.drawn_technician_id !== 'string') return null;
  const tie = (rz.tie_set as unknown[]).flatMap((m) => {
    const r = m as Record<string, unknown> | null;
    return r && typeof r.technician_id === 'string' && typeof r.score === 'number' ? [{ technician_id: r.technician_id, score: r.score }] : [];
  });
  if (tie.length < 2 || !tie.some((t) => t.technician_id === rz.drawn_technician_id)) return null;
  return { job_id: jobId, tie_set: tie, drawn_technician_id: rz.drawn_technician_id, executed_as_drawn: rz.executed_as_drawn === true, outcome };
}

export interface ContrastResult {
  effect: number; se: number; z: number; p: number; ciLow: number; ciHigh: number;
  treatmentMean: number; controlMean: number;
  nTreatment: number; nControl: number; informativeJobs: number;
}

/**
 * Hájek IPW difference. `groups` maps technician id -> 'treatment' | 'control' (others ignored).
 * A job is informative only if its tie set contains BOTH groups (positivity); P(group) = members_in_group / |tie set|.
 */
export function ipwContrast(records: NaturalRecord[], groups: Record<string, 'treatment' | 'control'>, zCrit = 1.959963984540054): ContrastResult | null {
  let sT = 0, sC = 0, swT = 0, swC = 0, nT = 0, nC = 0, informative = 0;
  const rows: { arm: 'treatment' | 'control'; w: number; y: number }[] = [];
  for (const r of records) {
    if (r.outcome === null || !Number.isFinite(r.outcome)) continue;
    const m = r.tie_set.length;
    const inT = r.tie_set.filter((t) => groups[t.technician_id] === 'treatment').length;
    const inC = r.tie_set.filter((t) => groups[t.technician_id] === 'control').length;
    if (inT === 0 || inC === 0) continue;
    informative += 1;
    const arm = groups[r.drawn_technician_id];
    if (arm === 'treatment') rows.push({ arm, w: m / inT, y: r.outcome });
    else if (arm === 'control') rows.push({ arm, w: m / inC, y: r.outcome });
  }
  for (const x of rows) {
    if (x.arm === 'treatment') { sT += x.w * x.y; swT += x.w; nT += 1; } else { sC += x.w * x.y; swC += x.w; nC += 1; }
  }
  if (nT < 2 || nC < 2) return null;
  const muT = sT / swT, muC = sC / swC;
  let vT = 0, vC = 0;
  for (const x of rows) {
    if (x.arm === 'treatment') vT += (x.w * (x.y - muT)) ** 2; else vC += (x.w * (x.y - muC)) ** 2;
  }
  const se = Math.sqrt(vT / swT ** 2 + vC / swC ** 2);
  const effect = muT - muC;
  const z = se > 0 ? effect / se : 0;
  return { effect, se, z, p: twoSidedP(z), ciLow: effect - zCrit * se, ciHigh: effect + zCrit * se, treatmentMean: muT, controlMean: muC, nTreatment: nT, nControl: nC, informativeJobs: informative };
}

export interface BalanceRow { technician_id: string; expected: number; observed: number; z: number; ratio: number | null }
export interface SrmNatural { rows: BalanceRow[]; chiSquare: number; p: number; failed: boolean; worstRatioDeviation: number }

/**
 * Sample-ratio / workload check. For each technician: expected draws = Σ 1/|tie set| over the ties they were in;
 * variance = Σ p(1-p) (Poisson-binomial). Failure (alpha 0.001, as in opsExperiments SRM) means the draw is not
 * behaving like a fair lottery — do not interpret estimates. Also reports workload balance (observed / expected).
 */
export function srmNatural(records: NaturalRecord[]): SrmNatural {
  const acc = new Map<string, { e: number; v: number; o: number }>();
  for (const r of records) {
    const p = 1 / r.tie_set.length;
    for (const t of r.tie_set) {
      const a = acc.get(t.technician_id) ?? { e: 0, v: 0, o: 0 };
      a.e += p; a.v += p * (1 - p);
      if (t.technician_id === r.drawn_technician_id) a.o += 1;
      acc.set(t.technician_id, a);
    }
  }
  const rows: BalanceRow[] = [...acc.entries()].map(([technician_id, a]) => ({
    technician_id, expected: a.e, observed: a.o, z: a.v > 0 ? (a.o - a.e) / Math.sqrt(a.v) : 0, ratio: a.e > 0 ? a.o / a.e : null,
  })).sort((a, b) => a.technician_id.localeCompare(b.technician_id));
  const chi = rows.reduce((s, r) => s + r.z * r.z, 0);
  const p = rows.length > 1 ? chiSquareP(chi, rows.length - 1) : 1;
  const big = rows.filter((r) => r.expected >= MIN_CELL_N && r.ratio !== null);
  const worst = big.reduce((m, r) => Math.max(m, Math.abs((r.ratio as number) - 1)), 0);
  return { rows, chiSquare: chi, p, failed: records.length >= MIN_CELL_N && p < 0.001, worstRatioDeviation: worst };
}

/** Upper-tail chi-square p-value via the regularized incomplete gamma function. */
export function chiSquareP(x: number, df: number): number {
  if (!(x > 0) || df <= 0) return 1;
  return 1 - gammaP(df / 2, x / 2);
}
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}
function lnGamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, tmp = z + 5.5; tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / z);
}

export type NaturalVerdict = 'collecting' | 'invalid' | 'inconclusive' | 'treatment_better' | 'control_better' | 'no_difference';

export interface NaturalContrastAnalysis {
  verdict: NaturalVerdict;
  /** i18n key + params for the UI; the UI owns the wording. */
  messageKey: string;
  messageParams: Record<string, number | string>;
  contrast: ContrastResult | null;
  srm: SrmNatural;
  complianceRate: number;
  plannedPerArm: number | null;
  /** Jobs with a mature outcome that were randomized. */
  matureJobs: number;
}

export function analyzeNatural(opts: {
  records: NaturalRecord[];
  groups: Record<string, 'treatment' | 'control'>;
  baselineRate: number;
  mde: number;
  higherIsBetter?: boolean;
  alpha?: Alpha;
}): NaturalContrastAnalysis {
  const alpha = opts.alpha ?? 0.05;
  const z = alpha === 0.01 ? 2.5758293035489 : alpha === 0.1 ? 1.6448536269514722 : 1.959963984540054;
  const srm = srmNatural(opts.records);
  const mature = opts.records.filter((r) => r.outcome !== null);
  const complianceRate = opts.records.length ? opts.records.filter((r) => r.executed_as_drawn).length / opts.records.length : 0;
  const planned = requiredPerArm('ftf_rate', 'randomized', { n: 0, mean: opts.baselineRate, sd: Math.sqrt(opts.baselineRate * (1 - opts.baselineRate)) }, opts.mde, alpha);
  const base = { srm, complianceRate, plannedPerArm: planned, matureJobs: mature.length };
  if (srm.failed) return { ...base, verdict: 'invalid', messageKey: 'dispatch.natural.srmFailed', messageParams: { p: srm.p }, contrast: null };
  const contrast = ipwContrast(opts.records, opts.groups, z);
  const need = planned ?? MIN_CELL_N;
  if (!contrast || contrast.nTreatment < MIN_CELL_N || contrast.nControl < MIN_CELL_N) {
    return { ...base, verdict: 'collecting', messageKey: 'dispatch.natural.collecting', messageParams: { have: Math.min(contrast?.nTreatment ?? 0, contrast?.nControl ?? 0), need }, contrast };
  }
  // No causal claim when data is thin: below the planned size a non-significant result is "inconclusive", never "no difference".
  const enough = Math.min(contrast.nTreatment, contrast.nControl) >= need;
  if (contrast.p < alpha) {
    const better = (contrast.effect > 0) === (opts.higherIsBetter !== false);
    return { ...base, verdict: better ? 'treatment_better' : 'control_better', messageKey: better ? 'dispatch.natural.treatmentBetter' : 'dispatch.natural.controlBetter', messageParams: { effectPp: contrast.effect * 100, lowPp: contrast.ciLow * 100, highPp: contrast.ciHigh * 100 }, contrast };
  }
  if (enough && Math.max(Math.abs(contrast.ciLow), Math.abs(contrast.ciHigh)) <= opts.mde) {
    return { ...base, verdict: 'no_difference', messageKey: 'dispatch.natural.noDifference', messageParams: { mdePp: opts.mde * 100 }, contrast };
  }
  return { ...base, verdict: 'inconclusive', messageKey: 'dispatch.natural.inconclusive', messageParams: { lowPp: contrast.ciLow * 100, highPp: contrast.ciHigh * 100, have: Math.min(contrast.nTreatment, contrast.nControl), need }, contrast };
}

// ---------------------------------------------------------------------------------------------
// Owner-page helpers (settings validation + 30-day draw overview). PURE.
// ---------------------------------------------------------------------------------------------

/** A dispatch_decisions row that carries explanation.randomization (see fetchRandomizedDecisions). */
export interface DecisionRow {
  job_id: string;
  created_at: string;
  explanation: unknown;
}

export type SkipKey = 'vip_job' | 'excluded_service' | 'fewer_than_two_tied' | 'eta_unknown' | 'eta_delta_exceeded';
const SKIP_REASONS: readonly SkipKey[] = ['vip_job', 'excluded_service', 'fewer_than_two_tied', 'eta_unknown', 'eta_delta_exceeded'];

export interface DrawSummary {
  /** Decisions that went through the randomization check. */
  total: number;
  /** Of those, how many were actually drawn. */
  applied: number;
  /** Why the rest were not drawn. */
  skipped: Record<SkipKey, number>;
  /** Fairness / workload check over the applied draws. */
  balance: SrmNatural;
}

export function summarizeDraws(decisions: DecisionRow[]): DrawSummary {
  const skipped: Record<SkipKey, number> = { vip_job: 0, excluded_service: 0, fewer_than_two_tied: 0, eta_unknown: 0, eta_delta_exceeded: 0 };
  const records: NaturalRecord[] = [];
  let total = 0;
  for (const d of decisions) {
    const rz = (d.explanation as { randomization?: Record<string, unknown> } | null)?.randomization;
    if (!rz || typeof rz !== 'object') continue;
    total += 1;
    const rec = recordFromExplanation(d.job_id, d.explanation, null);
    if (rec) {
      records.push(rec);
    } else if (typeof rz.reason === 'string' && (SKIP_REASONS as readonly string[]).includes(rz.reason)) {
      skipped[rz.reason as SkipKey] += 1;
    }
  }
  return { total, applied: records.length, skipped, balance: srmNatural(records) };
}

/**
 * Validates the owner's draft settings (same bounds as the database CHECKs and the server's normalizeSettings).
 * Returns i18n error keys (`errors.<key>`); an empty array means valid.
 */
export function validateSettings(s: { epsilon: number; top_k: number; max_eta_delta_minutes: number }): Array<'epsilon' | 'topK' | 'eta'> {
  const problems: Array<'epsilon' | 'topK' | 'eta'> = [];
  if (!Number.isFinite(s.epsilon) || s.epsilon < 0 || s.epsilon > 10) problems.push('epsilon');
  if (!Number.isInteger(s.top_k) || s.top_k < 2 || s.top_k > 5) problems.push('topK');
  if (!Number.isInteger(s.max_eta_delta_minutes) || s.max_eta_delta_minutes < 0 || s.max_eta_delta_minutes > 120) problems.push('eta');
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Experiment-level analysis for design = 'natural' (used by ExperimentDetail / NaturalProgressCard). PURE.
// ---------------------------------------------------------------------------------------------

/**
 * Same shape as the analysis of every other design (so ResultPanel, buildSnapshot and the conclude flow work
 * unchanged) plus what the near-tie progress card needs.
 */
export interface NaturalAnalysis extends Analysis {
  /** Fairness / workload check of the lottery itself. */
  balance: SrmNatural;
  /** Near-tie draws made during the experiment (one per job). */
  randomizedJobs: number;
  /** Draws whose tie set contained BOTH a treatment and a control technician (only these identify the effect). */
  informativeJobs: number;
  /** Share of draws that dispatch actually executed (0–1). */
  complianceRate: number;
}

type Arm = 'treatment' | 'control';

const isInformative = (r: NaturalRecord, groups: Record<string, Arm>): boolean =>
  r.tie_set.some((t) => groups[t.technician_id] === 'treatment') && r.tie_set.some((t) => groups[t.technician_id] === 'control');

function toEstimate(c: ContrastResult): Estimate {
  return {
    effect: c.effect, se: c.se, z: c.z, p: c.p, ciLow: c.ciLow, ciHigh: c.ciHigh,
    treatmentMean: c.treatmentMean, controlMean: c.controlMean,
    counterfactual: c.controlMean,
    relativePct: Math.abs(c.controlMean) > 1e-9 ? (c.effect / Math.abs(c.controlMean)) * 100 : null,
    nTreatment: c.nTreatment, nControl: c.nControl,
  };
}

/**
 * Analyses a running near-tie experiment from dispatch draws.
 *  - Scope: auto decisions logged since the experiment started (and before it concluded), restricted to the
 *    experiment's service types; one draw per job (the latest decision for that job).
 *  - Groups: the experiment's technician assignments (unit_type 'technician').
 *  - Estimate: Hájek inverse-probability-weighted difference (see ipwContrast), a LOCAL effect among near-tied jobs.
 *  - Verdict / recommendation reuse the shared rules (decideVerdict, recommend) so every design is judged alike.
 */
export function analyzeNaturalExperiment(
  cfg: ExperimentConfig,
  decisions: DecisionRow[],
  jobs: ExpJob[],
  assignments: Assignment[],
  baseline: Baseline | null,
  now: Date = new Date(),
): NaturalAnalysis {
  const warnings: string[] = [];
  const zFinal = Z_TWO_SIDED[cfg.alpha];
  const metric = cfg.primary_metric;
  const mde = fromDisplay(metric, cfg.min_detectable_effect);

  const groups: Record<string, Arm> = {};
  for (const a of assignments) if (a.unit_type === 'technician') groups[a.unit_id] = a.arm;

  const startMs = cfg.started_at ? Date.parse(cfg.started_at) : NaN;
  const endMs = cfg.concluded_at ? Date.parse(cfg.concluded_at) : now.getTime();
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const ctx: ObserveContext = { reworked: buildReworkedSet(jobs), now, maturityDays: cfg.maturity_days };

  // One draw per job: if a job was auto-assigned more than once, the latest decision is the one that stuck.
  const latest = new Map<string, DecisionRow>();
  for (const d of decisions) {
    const t = Date.parse(d.created_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(t) || t < startMs || t > endMs) continue;
    if (cfg.service_types.length > 0) {
      const job = jobById.get(d.job_id);
      if (!job || !matchesService(job, cfg.service_types)) continue;
    }
    const prev = latest.get(d.job_id);
    if (!prev || t >= Date.parse(prev.created_at)) latest.set(d.job_id, d);
  }

  const recordsFor = (m: MetricKey): NaturalRecord[] => {
    const out: NaturalRecord[] = [];
    for (const d of latest.values()) {
      const job = jobById.get(d.job_id);
      const rec = recordFromExplanation(d.job_id, d.explanation, job ? observe(m, job, ctx) : null);
      if (rec) out.push(rec);
    }
    return out;
  };

  const records = recordsFor(metric);
  const balance = srmNatural(records);
  const informativeJobs = records.filter((r) => isInformative(r, groups)).length;
  const complianceRate = records.length ? records.filter((r) => r.executed_as_drawn).length / records.length : 0;

  // Sample-size planning and sequential boundary, exactly as for the other designs.
  const probe = ipwContrast(records, groups, zFinal);
  const observedPerArm = probe ? Math.min(probe.nTreatment, probe.nControl) : 0;
  const plannedPerArm = requiredPerArm(metric, cfg.design, baseline, mde, cfg.alpha);
  const informationFraction = plannedPerArm ? Math.min(1, observedPerArm / plannedPerArm) : 1;
  const zCritical = zFinal / Math.sqrt(Math.max(informationFraction, 0.05));
  const contrast = ipwContrast(records, groups, zCritical);
  const estimate = contrast ? toEstimate(contrast) : null;
  const primary: MetricResult = { metric, estimate, benefit: benefitOf(metric, estimate) };

  const drawnTreatment = records.filter((r) => groups[r.drawn_technician_id] === 'treatment').length;
  const drawnControl = records.filter((r) => groups[r.drawn_technician_id] === 'control').length;
  const srm: SrmResult = { nTreatment: drawnTreatment, nControl: drawnControl, p: balance.p, failed: balance.failed };
  if (balance.failed) warnings.push('The near-tie lottery is not behaving like a fair draw (some technicians got far more or fewer jobs than expected). Results cannot be trusted until this is explained.');
  if (records.length > 0 && informativeJobs === 0) warnings.push('No drawn job had both a treatment and a control technician tied. Put technicians from both groups in the same service areas so they can be tied.');
  if (records.length >= MIN_CELL_N && complianceRate < 0.8) warnings.push('Dispatchers overrode many of the draws, so the measured effect is diluted (it is the effect of the draw, not of the technician actually sent).');

  let sparse = false;
  if (METRICS[metric].kind === 'binary' && observedPerArm >= MIN_CELL_N) {
    const ones = { treatment: 0, control: 0 };
    const zeros = { treatment: 0, control: 0 };
    for (const r of records) {
      if (r.outcome === null || !isInformative(r, groups)) continue;
      const arm = groups[r.drawn_technician_id];
      if (!arm) continue;
      if (r.outcome >= 0.5) ones[arm] += 1; else zeros[arm] += 1;
    }
    sparse = (['treatment', 'control'] as const).some((a) => ones[a] < MIN_BINARY_EVENTS || zeros[a] < MIN_BINARY_EVENTS);
    if (sparse) warnings.push('Too few events in at least one group for a reliable estimate. Collect more outcomes.');
  }

  let guardrail: GuardrailResult | null = null;
  if (cfg.guardrail_metric && cfg.guardrail_tolerance !== null) {
    const gMetric = cfg.guardrail_metric;
    const gc = ipwContrast(recordsFor(gMetric), groups, zFinal);
    const gEst = gc && Math.min(gc.nTreatment, gc.nControl) >= MIN_CELL_N ? toEstimate(gc) : null;
    const tolerance = fromDisplay(gMetric, cfg.guardrail_tolerance);
    let status: GuardrailStatus = 'unknown';
    if (gEst) {
      const harm = METRICS[gMetric].higherIsBetter ? -gEst.effect : gEst.effect;
      if (harm - zFinal * gEst.se > tolerance) status = 'breached';
      else if (harm + zFinal * gEst.se <= tolerance) status = 'ok';
      else status = 'watch';
    }
    guardrail = { metric: gMetric, estimate: gEst, benefit: benefitOf(gMetric, gEst), status, tolerance };
    if (status === 'breached') warnings.push(`Guardrail breached: ${METRICS[gMetric].label} got worse than the agreed tolerance.`);
  }

  const verdict = decideVerdict({ srmFailed: balance.failed, estimate, benefit: primary.benefit, observedPerArm, sparse, zCritical, informationFraction, mde });
  const recommendation = recommend(verdict, guardrail);
  // Never grade "A": that is reserved for fully randomized designs; a near-tie lottery gives a local effect.
  const evidence: EvidenceGrade = informationFraction >= 1 && !sparse ? 'B' : 'C';

  return {
    verdict, recommendation, evidence, primary, guardrail, srm,
    plannedPerArm, observedPerArm, informationFraction, zCritical, warnings,
    computedAt: now.toISOString(),
    balance, randomizedJobs: records.length, informativeJobs, complianceRate,
  };
}

/**
 * Rough days until the experiment reaches its planned sample size, extrapolating the pace so far.
 * null when it cannot be estimated yet (no plan, nothing observed, or no time elapsed).
 */
export function projectedDaysToPower(a: Pick<Analysis, 'plannedPerArm' | 'observedPerArm'>, elapsedDays: number): number | null {
  if (a.plannedPerArm === null || !(a.plannedPerArm > 0)) return null;
  if (a.observedPerArm >= a.plannedPerArm) return 0;
  if (!(a.observedPerArm > 0) || !(elapsedDays > 0)) return null;
  const perDay = a.observedPerArm / elapsedDays;
  return Math.ceil((a.plannedPerArm - a.observedPerArm) / perDay);
}
