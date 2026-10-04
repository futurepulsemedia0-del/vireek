/**
 * Vireek Operational Experimentation Platform - analysis library (pure, no I/O).
 *
 * Turns a business decision into a pre-registered experiment:
 *   Hypothesis -> Intervention -> Control / Comparison -> Outcome -> Causal estimate -> Learning
 *
 * Two designs:
 *  - randomized: jobs are randomly assigned (server-side hash, see migration) to
 *    treatment / control. Estimate = difference in means (intention-to-treat).
 *  - comparison: groups of technicians (treatment vs comparison), measured before and
 *    during the run. Estimate = difference-in-differences (assumes parallel trends).
 *
 * Rigor built in: outcome maturity (no right-censoring bias), sample-ratio-mismatch check,
 * a pre-declared guardrail metric, O'Brien-Fleming-style interim boundary (so early peeking
 * does not inflate false positives), and an evidence grade stored with every learning.
 *
 * Server counterpart: supabase/migrations/20270210000000_operational_experimentation.sql
 */

// ============================================================
// TYPES
// ============================================================

export type MetricKey = 'ftf_rate' | 'callback_rate' | 'completion_rate' | 'sla_met_rate' | 'avg_revenue';
export type MetricUnit = 'pct' | 'usd';
export type DesignKind = 'randomized' | 'comparison';
export type ExperimentStatus = 'draft' | 'running' | 'concluded' | 'archived';
export type Arm = 'control' | 'treatment';
export type UnitType = 'job' | 'technician';
export type Decision = 'adopt' | 'iterate' | 'reject';
export type Alpha = 0.01 | 0.05 | 0.1;
export type ExperimentCategory = 'dispatch' | 'quality' | 'pricing' | 'parts' | 'training' | 'customer_experience' | 'operations';
export type Verdict = 'collecting' | 'win' | 'loss' | 'no_effect' | 'inconclusive' | 'invalid';
export type Recommendation = 'continue' | 'adopt' | 'adopt_monitor' | 'iterate' | 'reject' | 'fix_design';
export type GuardrailStatus = 'ok' | 'watch' | 'breached' | 'unknown';
export type EvidenceGrade = 'A' | 'B' | 'C';

export interface MetricDef {
  key: MetricKey;
  label: string;
  kind: 'binary' | 'continuous';
  higherIsBetter: boolean;
  unit: MetricUnit;
  description: string;
}

export const METRICS: Record<MetricKey, MetricDef> = {
  ftf_rate: {
    key: 'ftf_rate',
    label: 'First-time-fix rate',
    kind: 'binary',
    higherIsBetter: true,
    unit: 'pct',
    description: 'Completed jobs with no follow-up rework job, counted once the callback window has passed.',
  },
  callback_rate: {
    key: 'callback_rate',
    label: 'Callback rate',
    kind: 'binary',
    higherIsBetter: false,
    unit: 'pct',
    description: 'Completed jobs that needed a rework visit, counted once the callback window has passed.',
  },
  completion_rate: {
    key: 'completion_rate',
    label: 'Completion rate',
    kind: 'binary',
    higherIsBetter: true,
    unit: 'pct',
    description: 'Jobs completed versus jobs cancelled or no-show.',
  },
  sla_met_rate: {
    key: 'sla_met_rate',
    label: 'SLA window met',
    kind: 'binary',
    higherIsBetter: true,
    unit: 'pct',
    description: 'Jobs with an SLA whose visit is scheduled within the SLA hours of booking.',
  },
  avg_revenue: {
    key: 'avg_revenue',
    label: 'Revenue per job',
    kind: 'continuous',
    higherIsBetter: true,
    unit: 'usd',
    description: 'Average invoice amount of completed jobs.',
  },
};

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export const CATEGORY_LABELS: Record<ExperimentCategory, string> = {
  dispatch: 'Dispatch',
  quality: 'Quality',
  pricing: 'Pricing',
  parts: 'Parts & inventory',
  training: 'Training',
  customer_experience: 'Customer experience',
  operations: 'Operations',
};

/** Minimal job shape the library needs (the full `Job` type is assignable to it). */
export interface ExpJob {
  id: string;
  service_type: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  created_at: string;
  completed_at: string | null;
  invoice_amount: number | null;
  sla_response_hours: number | null;
  assigned_technician_id: string | null;
  is_rework: boolean;
  rework_of_job_id: string | null;
}

export interface ExperimentConfig {
  id: string;
  design: DesignKind;
  primary_metric: MetricKey;
  guardrail_metric: MetricKey | null;
  /** In display units: percentage points for % metrics, dollars for $ metrics. */
  guardrail_tolerance: number | null;
  /** In display units. */
  min_detectable_effect: number;
  alpha: Alpha;
  duration_days: number;
  treatment_share: number;
  service_types: string[];
  maturity_days: number;
  status: ExperimentStatus;
  started_at: string | null;
  concluded_at: string | null;
}

export interface Assignment {
  unit_type: UnitType;
  unit_id: string;
  arm: Arm;
}

export interface ObserveContext {
  reworked: Set<string>;
  now: Date;
  maturityDays: number;
}

export interface Sample {
  n: number;
  mean: number;
  variance: number;
}

export interface Cells {
  treatment: number[];
  control: number[];
  treatmentPre: number[];
  controlPre: number[];
}

export interface Estimate {
  effect: number;
  se: number;
  z: number;
  p: number;
  ciLow: number;
  ciHigh: number;
  treatmentMean: number;
  controlMean: number;
  counterfactual: number;
  relativePct: number | null;
  nTreatment: number;
  nControl: number;
}

export interface MetricResult {
  metric: MetricKey;
  estimate: Estimate | null;
  /** Effect signed so that positive always means "better" for this metric. */
  benefit: number | null;
}

export interface GuardrailResult extends MetricResult {
  status: GuardrailStatus;
  tolerance: number;
}

export interface SrmResult {
  nTreatment: number;
  nControl: number;
  p: number;
  failed: boolean;
}

export interface Analysis {
  verdict: Verdict;
  recommendation: Recommendation;
  evidence: EvidenceGrade;
  primary: MetricResult;
  guardrail: GuardrailResult | null;
  srm: SrmResult | null;
  plannedPerArm: number | null;
  observedPerArm: number;
  informationFraction: number;
  zCritical: number;
  warnings: string[];
  computedAt: string;
}

export interface ResultSnapshot {
  verdict: Verdict;
  recommendation: Recommendation;
  evidence: EvidenceGrade;
  metric: MetricKey;
  effect: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  p: number | null;
  relativePct: number | null;
  nTreatment: number;
  nControl: number;
  guardrailMetric: MetricKey | null;
  guardrailStatus: GuardrailStatus | null;
  plannedPerArm: number | null;
  computedAt: string;
}

// ============================================================
// CONSTANTS & NUMERICS
// ============================================================

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Minimum observations in every cell before any verdict is issued. */
export const MIN_CELL_N = 30;
/** Binary outcomes need at least this many events and non-events per cell for the normal approximation. */
export const MIN_BINARY_EVENTS = 5;
const SRM_ALPHA = 0.001;

const Z_TWO_SIDED: Record<Alpha, number> = { 0.01: 2.5758293035489, 0.05: 1.959963984540054, 0.1: 1.6448536269514722 };
const Z_POWER_80 = 0.8416212335729143;

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-sided p-value for a standard-normal statistic. */
export function twoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  return Math.min(1, Math.max(0, 1 - erf(x)));
}

// Abramowitz & Stegun 7.1.26 (max absolute error 1.5e-7).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
  return sign * y;
}

export function summarize(values: number[]): Sample {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { n, mean, variance: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { n, mean, variance };
}

/** Display units (pp / $) -> internal scale (proportion / $). */
export function fromDisplay(metric: MetricKey, v: number): number {
  return METRICS[metric].unit === 'pct' ? v / 100 : v;
}

/** Internal scale -> display units. */
export function toDisplay(metric: MetricKey, v: number): number {
  return METRICS[metric].unit === 'pct' ? v * 100 : v;
}

// ============================================================
// OUTCOMES
// ============================================================

export function buildReworkedSet(jobs: ExpJob[]): Set<string> {
  const set = new Set<string>();
  for (const j of jobs) if (j.rework_of_job_id) set.add(j.rework_of_job_id);
  return set;
}

/** Returns the metric value for one job, or null when the job is not (yet) a valid observation. */
export function observe(metric: MetricKey, job: ExpJob, ctx: ObserveContext): number | null {
  switch (metric) {
    case 'ftf_rate':
    case 'callback_rate': {
      if (job.is_rework || job.job_status !== 'completed' || !job.completed_at) return null;
      const completed = Date.parse(job.completed_at);
      if (!Number.isFinite(completed) || ctx.now.getTime() - completed < ctx.maturityDays * DAY) return null;
      const fixedFirstTime = ctx.reworked.has(job.id) ? 0 : 1;
      return metric === 'ftf_rate' ? fixedFirstTime : 1 - fixedFirstTime;
    }
    case 'completion_rate': {
      if (job.is_rework) return null;
      if (job.job_status === 'completed') return 1;
      if (job.job_status === 'cancelled' || job.job_status === 'no_show') return 0;
      return null;
    }
    case 'sla_met_rate': {
      if (job.sla_response_hours == null || !job.scheduled_datetime || job.job_status === 'cancelled') return null;
      const hours = (Date.parse(job.scheduled_datetime) - Date.parse(job.created_at)) / HOUR;
      if (!Number.isFinite(hours)) return null;
      return hours <= job.sla_response_hours ? 1 : 0;
    }
    case 'avg_revenue': {
      if (job.job_status !== 'completed' || typeof job.invoice_amount !== 'number' || !(job.invoice_amount > 0)) return null;
      return job.invoice_amount;
    }
  }
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function matchesService(job: ExpJob, serviceTypes: string[]): boolean {
  if (serviceTypes.length === 0) return true;
  const key = norm(job.service_type);
  return serviceTypes.some((s) => norm(s) === key);
}

const anchorTime = (job: ExpJob): number => Date.parse(job.scheduled_datetime ?? job.created_at);

/** Pre / post measurement windows for the comparison design. */
export function comparisonWindows(cfg: ExperimentConfig, now: Date): { preStart: number; start: number; end: number } | null {
  if (!cfg.started_at) return null;
  const start = Date.parse(cfg.started_at);
  const end = cfg.concluded_at ? Date.parse(cfg.concluded_at) : now.getTime();
  return { preStart: start - cfg.duration_days * DAY, start, end };
}

export function collectCells(
  cfg: ExperimentConfig,
  metric: MetricKey,
  jobs: ExpJob[],
  assignments: Assignment[],
  now: Date,
): Cells {
  const cells: Cells = { treatment: [], control: [], treatmentPre: [], controlPre: [] };
  const ctx: ObserveContext = { reworked: buildReworkedSet(jobs), now, maturityDays: cfg.maturity_days };

  if (cfg.design === 'randomized') {
    const arms = new Map<string, Arm>();
    for (const a of assignments) if (a.unit_type === 'job') arms.set(a.unit_id, a.arm);
    for (const job of jobs) {
      const arm = arms.get(job.id);
      if (!arm) continue;
      const v = observe(metric, job, ctx);
      if (v !== null) cells[arm].push(v);
    }
    return cells;
  }

  const windows = comparisonWindows(cfg, now);
  if (!windows) return cells;
  const arms = new Map<string, Arm>();
  for (const a of assignments) if (a.unit_type === 'technician') arms.set(a.unit_id, a.arm);
  for (const job of jobs) {
    if (!job.assigned_technician_id || !matchesService(job, cfg.service_types)) continue;
    const arm = arms.get(job.assigned_technician_id);
    if (!arm) continue;
    const t = anchorTime(job);
    if (!Number.isFinite(t)) continue;
    const v = observe(metric, job, ctx);
    if (v === null) continue;
    if (t >= windows.start && t < windows.end) cells[arm].push(v);
    else if (t >= windows.preStart && t < windows.start) cells[arm === 'treatment' ? 'treatmentPre' : 'controlPre'].push(v);
  }
  return cells;
}

// ============================================================
// STATISTICS
// ============================================================

/** Smallest number of valid observations across the cells the design relies on. */
export function minCellN(design: DesignKind, cells: Cells): number {
  const ns = [cells.treatment.length, cells.control.length];
  if (design === 'comparison') ns.push(cells.treatmentPre.length, cells.controlPre.length);
  return Math.min(...ns);
}

function binaryCellsSparse(design: DesignKind, cells: Cells): boolean {
  const lists = [cells.treatment, cells.control];
  if (design === 'comparison') lists.push(cells.treatmentPre, cells.controlPre);
  return lists.some((l) => {
    const ones = l.reduce((s, v) => s + v, 0);
    return ones < MIN_BINARY_EVENTS || l.length - ones < MIN_BINARY_EVENTS;
  });
}

export function estimateEffect(design: DesignKind, cells: Cells, zCrit: number): Estimate | null {
  const t = summarize(cells.treatment);
  const c = summarize(cells.control);
  if (t.n < 2 || c.n < 2) return null;

  let effect = t.mean - c.mean;
  let variance = t.variance / t.n + c.variance / c.n;
  let counterfactual = c.mean;

  if (design === 'comparison') {
    const tp = summarize(cells.treatmentPre);
    const cp = summarize(cells.controlPre);
    if (tp.n < 2 || cp.n < 2) return null;
    effect = t.mean - tp.mean - (c.mean - cp.mean);
    variance += tp.variance / tp.n + cp.variance / cp.n;
    counterfactual = tp.mean + (c.mean - cp.mean);
  }

  const se = Math.sqrt(variance);
  const z = se > 0 ? effect / se : effect === 0 ? 0 : Math.sign(effect) * 99;
  return {
    effect,
    se,
    z,
    p: twoSidedP(z),
    ciLow: effect - zCrit * se,
    ciHigh: effect + zCrit * se,
    treatmentMean: t.mean,
    controlMean: c.mean,
    counterfactual,
    relativePct: Math.abs(counterfactual) > 1e-9 ? (effect / Math.abs(counterfactual)) * 100 : null,
    nTreatment: t.n,
    nControl: c.n,
  };
}

/** Sample-ratio-mismatch test on ENROLLED units (not on observed outcomes). */
export function srmCheck(nTreatment: number, nControl: number, treatmentShare: number): SrmResult {
  const total = nTreatment + nControl;
  const share = treatmentShare / 100;
  const expT = total * share;
  const expC = total * (1 - share);
  if (total === 0 || expT === 0 || expC === 0) return { nTreatment, nControl, p: 1, failed: false };
  const chi2 = (nTreatment - expT) ** 2 / expT + (nControl - expC) ** 2 / expC;
  const p = twoSidedP(Math.sqrt(chi2));
  return { nTreatment, nControl, p, failed: total >= 20 && p < SRM_ALPHA };
}

export interface Baseline {
  n: number;
  mean: number;
  sd: number;
}

/** Historical baseline for a metric (internal scale), used for sample-size planning. */
export function historicalBaseline(
  metric: MetricKey,
  jobs: ExpJob[],
  serviceTypes: string[],
  maturityDays: number,
  now: Date,
  lookbackDays = 180,
): Baseline | null {
  const ctx: ObserveContext = { reworked: buildReworkedSet(jobs), now, maturityDays };
  const since = now.getTime() - lookbackDays * DAY;
  const values: number[] = [];
  for (const job of jobs) {
    if (!matchesService(job, serviceTypes)) continue;
    const t = anchorTime(job);
    if (!Number.isFinite(t) || t < since || t > now.getTime()) continue;
    const v = observe(metric, job, ctx);
    if (v !== null) values.push(v);
  }
  if (values.length < MIN_CELL_N) return null;
  const s = summarize(values);
  return { n: s.n, mean: s.mean, sd: Math.sqrt(s.variance) };
}

/**
 * Observations needed in EACH cell for 80% power at the given significance level.
 * `mde` is in the internal scale. Comparison designs double the variance (four cells).
 */
export function requiredPerArm(metric: MetricKey, design: DesignKind, baseline: Baseline | null, mde: number, alpha: Alpha): number | null {
  if (!(mde > 0)) return null;
  const k = (Z_TWO_SIDED[alpha] + Z_POWER_80) ** 2;
  const def = METRICS[metric];
  let n: number;
  if (def.kind === 'binary') {
    const p1 = Math.min(0.99, Math.max(0.01, baseline?.mean ?? 0.5));
    const p2 = p1 + mde <= 0.99 ? p1 + mde : p1 - mde;
    if (p2 <= 0 || p2 >= 1) return null;
    n = (k * (p1 * (1 - p1) + p2 * (1 - p2))) / (mde * mde);
  } else {
    if (!baseline || !(baseline.sd > 0)) return null;
    n = (2 * k * baseline.sd ** 2) / (mde * mde);
  }
  if (design === 'comparison') n *= 2;
  return Math.max(MIN_CELL_N, Math.ceil(n));
}

// ============================================================
// ANALYSIS
// ============================================================

function benefitOf(metric: MetricKey, est: Estimate | null): number | null {
  if (!est) return null;
  return METRICS[metric].higherIsBetter ? est.effect : -est.effect;
}

export function analyzeExperiment(
  cfg: ExperimentConfig,
  jobs: ExpJob[],
  assignments: Assignment[],
  baseline: Baseline | null,
  now: Date = new Date(),
): Analysis {
  const warnings: string[] = [];
  const zFinal = Z_TWO_SIDED[cfg.alpha];
  const metric = cfg.primary_metric;
  const mde = fromDisplay(metric, cfg.min_detectable_effect);

  const cells = collectCells(cfg, metric, jobs, assignments, now);
  const observedPerArm = minCellN(cfg.design, cells);
  const plannedPerArm = requiredPerArm(metric, cfg.design, baseline, mde, cfg.alpha);
  const informationFraction = plannedPerArm ? Math.min(1, observedPerArm / plannedPerArm) : 1;
  // O'Brien-Fleming-style boundary: early looks need much stronger evidence.
  const zCritical = zFinal / Math.sqrt(Math.max(informationFraction, 0.05));
  const estimate = estimateEffect(cfg.design, cells, zCritical);
  const primary: MetricResult = { metric, estimate, benefit: benefitOf(metric, estimate) };

  let srm: SrmResult | null = null;
  if (cfg.design === 'randomized') {
    const enrolled = assignments.filter((a) => a.unit_type === 'job');
    srm = srmCheck(
      enrolled.filter((a) => a.arm === 'treatment').length,
      enrolled.filter((a) => a.arm === 'control').length,
      cfg.treatment_share,
    );
    if (srm.failed) warnings.push('Sample-ratio mismatch: the split between arms is not what was planned. Results cannot be trusted until this is explained.');
  } else {
    const tp = summarize(cells.treatmentPre);
    const cp = summarize(cells.controlPre);
    if (tp.n >= MIN_CELL_N && cp.n >= MIN_CELL_N) {
      const se = Math.sqrt(tp.variance / tp.n + cp.variance / cp.n);
      if (se > 0 && twoSidedP((tp.mean - cp.mean) / se) < 0.01) {
        warnings.push('The two groups already differed before the intervention. The estimate assumes both groups would have trended in parallel.');
      }
    }
  }

  const sparse = METRICS[metric].kind === 'binary' && observedPerArm >= MIN_CELL_N && binaryCellsSparse(cfg.design, cells);
  if (sparse) warnings.push('Too few events in at least one group for a reliable estimate. Collect more outcomes.');

  let guardrail: GuardrailResult | null = null;
  if (cfg.guardrail_metric && cfg.guardrail_tolerance !== null) {
    const gMetric = cfg.guardrail_metric;
    const gCells = collectCells(cfg, gMetric, jobs, assignments, now);
    const gEst = minCellN(cfg.design, gCells) >= MIN_CELL_N ? estimateEffect(cfg.design, gCells, zFinal) : null;
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

  let verdict: Verdict;
  if (srm?.failed) verdict = 'invalid';
  else if (!estimate || observedPerArm < MIN_CELL_N || sparse) verdict = 'collecting';
  else if (Math.abs(estimate.z) >= zCritical) verdict = (primary.benefit ?? 0) > 0 ? 'win' : 'loss';
  else if (informationFraction >= 1) verdict = estimate.ciLow >= -mde && estimate.ciHigh <= mde ? 'no_effect' : 'inconclusive';
  else verdict = 'collecting';

  const recommendation = recommend(verdict, guardrail);
  const evidence: EvidenceGrade =
    cfg.design === 'randomized' && informationFraction >= 1 && !sparse ? 'A' : cfg.design === 'randomized' || informationFraction >= 1 ? 'B' : 'C';

  return {
    verdict,
    recommendation,
    evidence,
    primary,
    guardrail,
    srm,
    plannedPerArm,
    observedPerArm,
    informationFraction,
    zCritical,
    warnings,
    computedAt: now.toISOString(),
  };
}

export function recommend(verdict: Verdict, guardrail: GuardrailResult | null): Recommendation {
  switch (verdict) {
    case 'invalid':
      return 'fix_design';
    case 'collecting':
      return 'continue';
    case 'loss':
    case 'no_effect':
      return 'reject';
    case 'inconclusive':
      return 'iterate';
    case 'win':
      if (!guardrail || guardrail.status === 'ok') return 'adopt';
      return guardrail.status === 'breached' ? 'iterate' : 'adopt_monitor';
  }
}

export function buildSnapshot(cfg: ExperimentConfig, a: Analysis): ResultSnapshot {
  const e = a.primary.estimate;
  return {
    verdict: a.verdict,
    recommendation: a.recommendation,
    evidence: a.evidence,
    metric: cfg.primary_metric,
    effect: e ? e.effect : null,
    ciLow: e ? e.ciLow : null,
    ciHigh: e ? e.ciHigh : null,
    p: e ? e.p : null,
    relativePct: e ? e.relativePct : null,
    nTreatment: e ? e.nTreatment : 0,
    nControl: e ? e.nControl : 0,
    guardrailMetric: a.guardrail?.metric ?? null,
    guardrailStatus: a.guardrail?.status ?? null,
    plannedPerArm: a.plannedPerArm,
    computedAt: a.computedAt,
  };
}

// ============================================================
// ENROLLMENT, VALIDATION, TEMPLATES, FORMATTING
// ============================================================

/** Jobs that can still be enrolled in a randomized experiment (not started, not a rework, in scope). */
export function enrollmentCandidates(cfg: ExperimentConfig, jobs: ExpJob[], enrolledJobIds: Set<string>): ExpJob[] {
  if (cfg.design !== 'randomized' || cfg.status !== 'running') return [];
  return jobs.filter((j) => j.job_status === 'scheduled' && !j.is_rework && matchesService(j, cfg.service_types) && !enrolledJobIds.has(j.id));
}

/** Eligible jobs per day over the recent past (used to check an experiment is feasible). */
export function jobsPerDay(jobs: ExpJob[], serviceTypes: string[], now: Date, technicianIds?: string[], lookbackDays = 90): number {
  const since = now.getTime() - lookbackDays * DAY;
  let count = 0;
  for (const job of jobs) {
    if (job.is_rework || !matchesService(job, serviceTypes)) continue;
    if (technicianIds && !(job.assigned_technician_id && technicianIds.includes(job.assigned_technician_id))) continue;
    const t = anchorTime(job);
    if (Number.isFinite(t) && t >= since && t <= now.getTime()) count += 1;
  }
  return count / lookbackDays;
}

export interface DraftInput {
  title: string;
  hypothesis: string;
  intervention: string;
  comparison_desc: string;
  design: DesignKind;
  primary_metric: MetricKey;
  guardrail_metric: MetricKey | null;
  guardrail_tolerance: number | null;
  min_detectable_effect: number;
  duration_days: number;
  treatment_share: number;
  maturity_days: number;
  treatmentTechnicians: string[];
  comparisonTechnicians: string[];
}

export function validateDraft(d: DraftInput): string[] {
  const errors: string[] = [];
  if (d.title.trim().length < 3) errors.push('Give the experiment a title.');
  if (d.hypothesis.trim().length < 10) errors.push('State the hypothesis in at least one full sentence.');
  if (d.intervention.trim().length < 10) errors.push('Describe the intervention.');
  if (!(d.min_detectable_effect > 0)) errors.push('The smallest effect worth detecting must be greater than zero.');
  if (d.guardrail_metric && d.guardrail_metric === d.primary_metric) errors.push('The guardrail must be a different metric from the primary metric.');
  if (d.guardrail_metric && (d.guardrail_tolerance === null || !(d.guardrail_tolerance >= 0))) errors.push('Set how much the guardrail metric may worsen.');
  if (d.design === 'comparison') {
    if (d.treatmentTechnicians.length === 0 || d.comparisonTechnicians.length === 0) errors.push('Pick at least one technician for each group.');
    if (d.treatmentTechnicians.some((id) => d.comparisonTechnicians.includes(id))) errors.push('A technician cannot be in both groups.');
  }
  return errors;
}

export interface ExperimentTemplate {
  id: string;
  label: string;
  category: ExperimentCategory;
  hypothesis: string;
  intervention: string;
  comparison_desc: string;
  design: DesignKind;
  primary_metric: MetricKey;
  guardrail_metric: MetricKey | null;
  guardrail_tolerance: number | null;
  min_detectable_effect: number;
  duration_days: number;
}

export const EXPERIMENT_TEMPLATES: ExperimentTemplate[] = [
  {
    id: 'parts-verification',
    label: 'Pre-job parts verification',
    category: 'parts',
    hypothesis: 'Verifying the required parts are on the truck before dispatch reduces callbacks.',
    intervention: 'Before each visit, the dispatcher confirms the likely parts are on the assigned truck or sourced.',
    comparison_desc: 'Dispatch as usual, without the pre-job parts check.',
    design: 'randomized',
    primary_metric: 'callback_rate',
    guardrail_metric: 'sla_met_rate',
    guardrail_tolerance: 2,
    min_detectable_effect: 3,
    duration_days: 42,
  },
  {
    id: 'profit-aware-dispatch',
    label: 'Profit-aware dispatch policy',
    category: 'dispatch',
    hypothesis: 'Choosing the most profitable eligible technician, when SLA slack allows, raises revenue per job without hurting SLA.',
    intervention: 'Dispatch to the highest-margin technician among those who still meet the SLA window.',
    comparison_desc: 'Dispatch with the current policy.',
    design: 'randomized',
    primary_metric: 'avg_revenue',
    guardrail_metric: 'sla_met_rate',
    guardrail_tolerance: 2,
    min_detectable_effect: 25,
    duration_days: 42,
  },
  {
    id: 'reconfirmation',
    label: 'Same-day reconfirmation call',
    category: 'customer_experience',
    hypothesis: 'Reconfirming the appointment on the morning of the visit reduces cancellations and no-shows.',
    intervention: 'Customer receives a confirmation call or text on the morning of the visit.',
    comparison_desc: 'No same-day reconfirmation.',
    design: 'randomized',
    primary_metric: 'completion_rate',
    guardrail_metric: null,
    guardrail_tolerance: null,
    min_detectable_effect: 4,
    duration_days: 28,
  },
  {
    id: 'apprenticeship-drills',
    label: 'Targeted skill drills for technicians',
    category: 'training',
    hypothesis: 'Technicians who complete targeted simulator drills fix more jobs on the first visit.',
    intervention: 'Selected technicians complete the assigned simulator drills for their skill gaps.',
    comparison_desc: 'Comparable technicians continue without the extra drills.',
    design: 'comparison',
    primary_metric: 'ftf_rate',
    guardrail_metric: 'completion_rate',
    guardrail_tolerance: 3,
    min_detectable_effect: 4,
    duration_days: 56,
  },
];

export const VERDICT_LABELS: Record<Verdict, string> = {
  collecting: 'Collecting evidence',
  win: 'Intervention worked',
  loss: 'Intervention made it worse',
  no_effect: 'No meaningful effect',
  inconclusive: 'Inconclusive',
  invalid: 'Data not trustworthy',
};

export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  continue: 'Keep running',
  adopt: 'Adopt it',
  adopt_monitor: 'Adopt and keep monitoring the guardrail',
  iterate: 'Redesign and test again',
  reject: 'Stop and keep the current approach',
  fix_design: 'Fix the setup before trusting this',
};

export const EVIDENCE_LABELS: Record<EvidenceGrade, string> = {
  A: 'A - randomized, fully powered',
  B: 'B - good design, limited power or non-random groups',
  C: 'C - directional only',
};

export function formatMetricValue(metric: MetricKey, v: number): string {
  return METRICS[metric].unit === 'pct' ? `${(v * 100).toFixed(1)}%` : `$${Math.round(v).toLocaleString('en-US')}`;
}

export function formatEffect(metric: MetricKey, v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return METRICS[metric].unit === 'pct' ? `${sign}${(abs * 100).toFixed(1)} pp` : `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

export function formatP(p: number): string {
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}

export function runProgress(cfg: ExperimentConfig, now: Date): { elapsedDays: number; remainingDays: number } {
  if (!cfg.started_at) return { elapsedDays: 0, remainingDays: cfg.duration_days };
  const end = cfg.concluded_at ? Date.parse(cfg.concluded_at) : now.getTime();
  const elapsed = Math.max(0, Math.floor((end - Date.parse(cfg.started_at)) / DAY));
  return { elapsedDays: elapsed, remainingDays: Math.max(0, cfg.duration_days - elapsed) };
}
