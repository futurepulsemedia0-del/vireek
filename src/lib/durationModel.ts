// src/lib/durationModel.ts
//
// Job-duration prediction engine (pure — no I/O, no React, fully unit-tested).
//
// WHAT IT EXTENDS (nothing is replaced):
//   The product already carries several *static* duration estimates:
//     jobs.expected_duration_minutes  (job plan / template)      -> "job_plan"
//     job_templates / service_catalog duration                    -> "template" / "catalog"
//     job_mission_briefs.estimated_duration_minutes               -> "mission_brief"
//     jobs.duration_minutes (booked slot, default 60)             -> "scheduled_slot"
//     service twin baseline: plan -> own history (n>=5) -> brief -> slot -> 90
//   `resolveExistingEstimate` reproduces that precedence so the model always
//   reports "what the system would have said before" next to its own number, and
//   uses an explicit plan as the *prior* it shrinks toward (cold start).
//
// MODEL (explainable, no black box):
//   Log-duration, stage-wise additive with empirical-Bayes shrinkage and
//   exponential recency decay:
//
//     ln(minutes) = type mean  (shrunk toward the plan, else the global mean)
//                 + technician effect
//                 + equipment-type effect
//                 + this-equipment effect
//                 + customer-history effect
//
//   Each stage learns only what the previous stages left unexplained and is
//   shrunk by  sum / (weight + k)  so thin evidence cannot swing a prediction.
//   Residuals are clipped (Huber-style) so one 14-hour disaster does not poison
//   a job type.
//
// CONFIDENCE RANGES:
//   Walk-forward ("prequential") training: every historic job is predicted using
//   ONLY data completed before it, then learned from. Those honest out-of-sample
//   residuals feed per-type / global residual pools, and the interval is read off
//   them with the split-conformal finite-sample correction (asymmetric, so
//   right-skewed durations get a longer upper tail). Too little data -> a
//   parametric log-normal fallback, flagged as such.
//
// DRIFT:
//   Bias z-test, interval-coverage test and a two-sided CUSUM, evaluated overall,
//   per job type and per technician, comparing a recent window to the reference.

export const MODEL_VERSION = 'dm-1';

export const DURATION_MODEL = {
  /** Recency half-life for effects (technician / equipment / customer). */
  halfLifeDays: 150,
  /** The job-type mean adapts faster, so a real change in a type is learned by the type
   *  stage instead of leaking into the shared technician / customer effects. */
  typeHalfLifeDays: 60,
  minMinutes: 5,
  maxMinutes: 24 * 60,
  defaultMinutes: 90,
  /** Pseudo-observation counts: how hard each stage is pulled toward "no effect". */
  shrinkage: { type: 3, technician: 4, equipmentType: 5, equipmentUnit: 3, customer: 3 },
  /** Max |log effect| a single stage may contribute (~ x2.0 / x0.5). */
  effectCap: 0.7,
  /** Clip for the job-type mean (~ x4.5). */
  residualClip: 1.5,
  /** Tighter clip for the effect stages (~ x2.5): one freak job must not brand a technician. */
  stageClip: 0.9,
  /** Raw observations of a type needed before it is called a "model" (vs prior / blend). */
  minTypeObsBlend: 3,
  minTypeObsModel: 8,
  intervalLevel: 0.8,
  /** Residuals needed before empirical (conformal) quantiles are trusted. */
  minResiduals: 10,
  residualWindow: 400,
  coldSigma: 0.35,
  minSigma: 0.12,
  slotStepMinutes: 15,
} as const;

export const DRIFT = {
  recentDays: 14,
  minRecent: 8,
  fallbackRecent: 12,
  minReference: 15,
  referenceCap: 300,
  minScopeRecent: 5,
  minScopeReference: 10,
  biasWarnZ: 2.5,
  biasCritZ: 3.5,
  biasWarnPct: 8,
  biasCritPct: 15,
  coverageGap: 0.15,
  coverageWarnZ: -2,
  coverageCritZ: -3,
  cusumK: 0.5,
  cusumH: 5,
  cusumWindow: 60,
  sdFloor: 0.12,
} as const;

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

export type SlotPolicy = 'tight' | 'balanced' | 'safe';
export type Confidence = 'high' | 'medium' | 'low';
export type PredictionSource = 'model' | 'blend' | 'prior';
export type EstimateSource =
  | 'job_plan'
  | 'template'
  | 'catalog'
  | 'history'
  | 'mission_brief'
  | 'scheduled_slot'
  | 'default';

// ============================================================
// Existing estimates (check-first, then extend)
// ============================================================

export interface ExistingEstimateInputs {
  /** jobs.expected_duration_minutes */
  planMinutes?: number | null;
  /** job_templates.expected_duration_minutes */
  templateMinutes?: number | null;
  /** service_catalog.duration_minutes */
  catalogMinutes?: number | null;
  /** Median of this type's own completed jobs (the twin's "history"). */
  historyMedianMinutes?: number | null;
  historyCount?: number | null;
  /** job_mission_briefs.estimated_duration_minutes */
  missionBriefMinutes?: number | null;
  /** jobs.duration_minutes (booked slot) */
  slotMinutes?: number | null;
}

export interface ExistingEstimate {
  minutes: number;
  source: EstimateSource;
}

const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Mirrors the service-twin baseline precedence, with template/catalog slotted in. */
export function resolveExistingEstimate(i: ExistingEstimateInputs): ExistingEstimate {
  const clampMin = (m: number) => Math.max(15, Math.round(m));
  if (pos(i.planMinutes)) return { minutes: clampMin(i.planMinutes), source: 'job_plan' };
  if (pos(i.templateMinutes)) return { minutes: clampMin(i.templateMinutes), source: 'template' };
  if (pos(i.historyMedianMinutes) && (i.historyCount ?? 0) >= 5) return { minutes: clampMin(i.historyMedianMinutes), source: 'history' };
  if (pos(i.missionBriefMinutes)) return { minutes: clampMin(i.missionBriefMinutes), source: 'mission_brief' };
  if (pos(i.catalogMinutes)) return { minutes: clampMin(i.catalogMinutes), source: 'catalog' };
  if (pos(i.slotMinutes)) return { minutes: clampMin(i.slotMinutes), source: 'scheduled_slot' };
  return { minutes: DURATION_MODEL.defaultMinutes, source: 'default' };
}

/** Only deliberate human/plan estimates are allowed to act as the shrinkage prior. */
const PRIOR_SOURCES: ReadonlySet<EstimateSource> = new Set(['job_plan', 'template', 'catalog', 'mission_brief']);
export const isExplicitEstimate = (e: ExistingEstimate | null | undefined): e is ExistingEstimate => !!e && PRIOR_SOURCES.has(e.source);

// ============================================================
// Small numeric helpers
// ============================================================

export function durationKey(v: string | null | undefined): string {
  const k = (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return k || 'unspecified';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ln = Math.log;
const unique = <T,>(xs: T[]): T[] => Array.from(new Set(xs));

/** Inverse standard-normal CDF (Acklam). Accurate to ~1e-9 on (0,1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * ln(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * ln(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// ============================================================
// Decay statistics
// ============================================================

interface Stat {
  sw: number; // decayed weight (effective count)
  sv: number; // decayed weighted sum
  t: number; // time the sums were last decayed to
  n: number; // raw count
}

const newStat = (): Stat => ({ sw: 0, sv: 0, t: 0, n: 0 });
const LAMBDA = Math.LN2 / (DURATION_MODEL.halfLifeDays * MS_PER_DAY);
const LAMBDA_TYPE = Math.LN2 / (DURATION_MODEL.typeHalfLifeDays * MS_PER_DAY);

function decayFactor(from: number, to: number, lambda: number): number {
  return to > from && from > 0 ? Math.exp(-lambda * (to - from)) : 1;
}

function readStat(s: Stat | undefined, at: number, lambda: number = LAMBDA): { sw: number; sv: number; n: number } {
  if (!s || s.n === 0) return { sw: 0, sv: 0, n: 0 };
  const f = decayFactor(s.t, at, lambda);
  return { sw: s.sw * f, sv: s.sv * f, n: s.n };
}

function addStat(map: Map<string, Stat>, key: string, at: number, v: number, lambda: number = LAMBDA): void {
  let s = map.get(key);
  if (!s) {
    s = newStat();
    map.set(key, s);
  }
  const f = decayFactor(s.t, at, lambda);
  s.sw = s.sw * f + 1;
  s.sv = s.sv * f + v;
  s.t = Math.max(s.t, at);
  s.n += 1;
}

// ============================================================
// Training input / model state
// ============================================================

export interface TrainingJob {
  jobId: string;
  /** Completion time (ms epoch) — ordering key for walk-forward training. */
  completedAtMs: number;
  jobTypeKey: string;
  technicianId: string | null;
  equipmentIds: string[];
  equipmentTypes: string[];
  customerId: string | null;
  /** Measured on-site minutes (started_at -> completed_at). */
  actualMinutes: number;
  /** What the existing system estimated at the time (plan, else booked slot) — for the "vs existing" scorecard. */
  baselineMinutes?: number | null;
  /** Explicit plan estimate, if any (prior for shrinkage). */
  priorMinutes?: number | null;
}

export interface PredictionContext {
  jobTypeKey: string | null;
  technicianId: string | null;
  equipmentIds: string[];
  equipmentTypes: string[];
  customerId: string | null;
  existing?: ExistingEstimate | null;
}

interface ResidualPool {
  chrono: number[];
  sorted: number[];
}

interface ModelState {
  global: Map<string, Stat>; // single key 'all'
  type: Map<string, Stat>;
  tech: Map<string, Stat>;
  eqType: Map<string, Stat>;
  eqUnit: Map<string, Stat>;
  cust: Map<string, Stat>;
  globalPool: ResidualPool;
  typePools: Map<string, ResidualPool>;
}

export interface BacktestRecord {
  jobId: string;
  completedAtMs: number;
  jobTypeKey: string;
  technicianId: string | null;
  predicted: number;
  low: number;
  high: number;
  actual: number;
  /** ln(actual / predicted) */
  logError: number;
  withinRange: boolean;
  baselineMinutes: number | null;
  source: PredictionSource;
}

export interface TrainedModel {
  version: string;
  trainedAtMs: number;
  trainedOn: number;
  dropped: number;
  records: BacktestRecord[];
  /** Per-type raw stats of actual minutes (median etc.) for the existing-estimate "history" tier and the UI. */
  typeActuals: Map<string, number[]>;
  state: ModelState;
}

const newPool = (): ResidualPool => ({ chrono: [], sorted: [] });

function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function poolAdd(p: ResidualPool, v: number): void {
  p.chrono.push(v);
  p.sorted.splice(lowerBound(p.sorted, v), 0, v);
  if (p.chrono.length > DURATION_MODEL.residualWindow) {
    const old = p.chrono.shift() as number;
    p.sorted.splice(lowerBound(p.sorted, old), 1);
  }
}

function newState(): ModelState {
  return {
    global: new Map(),
    type: new Map(),
    tech: new Map(),
    eqType: new Map(),
    eqUnit: new Map(),
    cust: new Map(),
    globalPool: newPool(),
    typePools: new Map(),
  };
}

// ============================================================
// Core: log-space prediction + stage-wise learning
// ============================================================

interface StageDef {
  id: 'technician' | 'equipment_type' | 'equipment_unit' | 'customer';
  label: string;
  k: number;
  map: 'tech' | 'eqType' | 'eqUnit' | 'cust';
  keys: (c: PredictionContext) => string[];
}

const STAGES: StageDef[] = [
  { id: 'technician', label: 'Technician', k: DURATION_MODEL.shrinkage.technician, map: 'tech', keys: (c) => (c.technicianId ? [c.technicianId] : []) },
  { id: 'equipment_type', label: 'Equipment type', k: DURATION_MODEL.shrinkage.equipmentType, map: 'eqType', keys: (c) => unique(c.equipmentTypes.map(durationKey)) },
  { id: 'equipment_unit', label: 'This equipment', k: DURATION_MODEL.shrinkage.equipmentUnit, map: 'eqUnit', keys: (c) => unique(c.equipmentIds.filter(Boolean)) },
  { id: 'customer', label: 'Customer history', k: DURATION_MODEL.shrinkage.customer, map: 'cust', keys: (c) => (c.customerId ? [c.customerId] : []) },
];

interface StageResult {
  id: StageDef['id'];
  label: string;
  delta: number; // log effect actually applied
  n: number; // raw observations behind it (max across keys)
  nEff: number;
}

interface LogPrediction {
  center: number; // log of the starting point (plan or global mean)
  mu: number; // after type stage
  total: number; // after all stages
  stages: StageResult[];
  typeN: number;
  typeNEff: number;
  usedPrior: boolean;
}

function predictLog(state: ModelState, ctx: PredictionContext, at: number, priorMinutes: number | null): LogPrediction {
  const g = readStat(state.global.get('all'), at);
  const globalMean = g.sw > 0 ? g.sv / g.sw : ln(DURATION_MODEL.defaultMinutes);
  const center = priorMinutes ? ln(clamp(priorMinutes, DURATION_MODEL.minMinutes, DURATION_MODEL.maxMinutes)) : globalMean;

  const typeKey = durationKey(ctx.jobTypeKey);
  const t = readStat(state.type.get(typeKey), at, LAMBDA_TYPE);
  const kT = DURATION_MODEL.shrinkage.type;
  const mu = (t.sv + kT * center) / (t.sw + kT);

  let total = mu;
  const stages: StageResult[] = [];
  for (const def of STAGES) {
    const keys = def.keys(ctx);
    if (keys.length === 0) continue;
    const effects: number[] = [];
    let n = 0;
    let nEff = 0;
    for (const key of keys) {
      const s = readStat(state[def.map].get(key), at);
      effects.push(s.sv / (s.sw + def.k));
      n = Math.max(n, s.n);
      nEff = Math.max(nEff, s.sw);
    }
    const delta = clamp(mean(effects), -DURATION_MODEL.effectCap, DURATION_MODEL.effectCap);
    total += delta;
    stages.push({ id: def.id, label: def.label, delta, n, nEff });
  }
  return { center, mu, total, stages, typeN: t.n, typeNEff: t.sw, usedPrior: priorMinutes !== null };
}

function learn(state: ModelState, ctx: PredictionContext, at: number, y: number, pred: LogPrediction): void {
  const clip = DURATION_MODEL.residualClip;
  const sClip = DURATION_MODEL.stageClip;
  const typeKey = durationKey(ctx.jobTypeKey);

  addStat(state.global, 'all', at, y);
  // Robustify the type mean once there is a baseline to compare against.
  const yType = pred.typeNEff >= 3 ? clamp(y, pred.mu - clip, pred.mu + clip) : y;
  addStat(state.type, typeKey, at, yType, LAMBDA_TYPE);

  let r = clamp(y - pred.mu, -sClip, sClip);
  for (const def of STAGES) {
    const keys = def.keys(ctx);
    if (keys.length === 0) continue;
    for (const key of keys) addStat(state[def.map], key, at, r);
    const applied = pred.stages.find((s) => s.id === def.id);
    r = clamp(r - (applied?.delta ?? 0), -sClip, sClip);
  }
}

// ============================================================
// Intervals
// ============================================================

function robustSigma(pool: ResidualPool): number {
  if (pool.sorted.length < 5) return DURATION_MODEL.coldSigma;
  const med = median(pool.sorted);
  const mad = median(pool.sorted.map((x) => Math.abs(x - med)));
  return Math.max(DURATION_MODEL.minSigma, 1.4826 * mad);
}

function empiricalQuantile(pool: ResidualPool, p: number): number | null {
  const n = pool.sorted.length;
  if (n < DURATION_MODEL.minResiduals) return null;
  if (p === 0.5) return median(pool.sorted);
  // split-conformal finite-sample rank
  const k = p > 0.5 ? Math.ceil((n + 1) * p) : Math.floor((n + 1) * p);
  if (k < 1 || k > n) return null;
  return pool.sorted[k - 1];
}

const LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
type QuantileSet = { p10: number; p25: number; p50: number; p75: number; p90: number };

interface IntervalResult {
  q: QuantileSet; // minutes
  method: 'empirical' | 'parametric';
}

function intervalFor(state: ModelState, typeKey: string, logCenter: number, typeN: number): IntervalResult {
  const typePool = state.typePools.get(typeKey);
  const pool =
    typePool && typePool.sorted.length >= DURATION_MODEL.minResiduals
      ? typePool
      : state.globalPool.sorted.length >= DURATION_MODEL.minResiduals
        ? state.globalPool
        : null;

  const sigmaBase = robustSigma(state.globalPool);
  // thin evidence about *this* type -> widen the parametric fallback
  const sigma = Math.max(DURATION_MODEL.minSigma, sigmaBase * (1 + 0.6 / Math.sqrt(1 + typeN)));

  let method: IntervalResult['method'] = pool ? 'empirical' : 'parametric';
  const vals = LEVELS.map((p) => {
    const e = pool ? empiricalQuantile(pool, p) : null;
    if (e === null) {
      if (pool) method = 'parametric';
      return normalQuantile(p) * sigma;
    }
    return e;
  });
  // keep the quantiles ordered even if mixed methods were used
  for (let i = 1; i < vals.length; i++) vals[i] = Math.max(vals[i], vals[i - 1]);

  const toMin = (e: number) =>
    clamp(Math.round(Math.exp(logCenter + e)), DURATION_MODEL.minMinutes, DURATION_MODEL.maxMinutes);
  const m = vals.map(toMin);
  for (let i = 1; i < m.length; i++) m[i] = Math.max(m[i], m[i - 1]);
  return { q: { p10: m[0], p25: m[1], p50: m[2], p75: m[3], p90: m[4] }, method };
}

function sourceFor(typeN: number): PredictionSource {
  if (typeN >= DURATION_MODEL.minTypeObsModel) return 'model';
  if (typeN >= DURATION_MODEL.minTypeObsBlend) return 'blend';
  return 'prior';
}

// ============================================================
// Training (walk-forward)
// ============================================================

export function trainDurationModel(input: TrainingJob[], nowMs: number = Date.now()): TrainedModel {
  const valid: TrainingJob[] = [];
  let dropped = 0;
  for (const j of input) {
    const ok =
      Number.isFinite(j.actualMinutes) &&
      j.actualMinutes >= DURATION_MODEL.minMinutes &&
      j.actualMinutes <= DURATION_MODEL.maxMinutes &&
      Number.isFinite(j.completedAtMs);
    if (ok) valid.push(j);
    else dropped += 1;
  }
  valid.sort((a, b) => a.completedAtMs - b.completedAtMs || a.jobId.localeCompare(b.jobId));

  const state = newState();
  const records: BacktestRecord[] = [];
  const typeActuals = new Map<string, number[]>();

  for (const j of valid) {
    const typeKey = durationKey(j.jobTypeKey);
    const ctx: PredictionContext = {
      jobTypeKey: typeKey,
      technicianId: j.technicianId,
      equipmentIds: j.equipmentIds,
      equipmentTypes: j.equipmentTypes,
      customerId: j.customerId,
    };
    const prior = pos(j.priorMinutes) ? j.priorMinutes : null;
    const pred = predictLog(state, ctx, j.completedAtMs, prior);
    const iv = intervalFor(state, typeKey, pred.total, pred.typeN);
    const y = ln(j.actualMinutes);
    const e = y - pred.total;

    records.push({
      jobId: j.jobId,
      completedAtMs: j.completedAtMs,
      jobTypeKey: typeKey,
      technicianId: j.technicianId,
      predicted: iv.q.p50,
      low: iv.q.p10,
      high: iv.q.p90,
      actual: Math.round(j.actualMinutes),
      logError: ln(j.actualMinutes / iv.q.p50),
      withinRange: j.actualMinutes >= iv.q.p10 && j.actualMinutes <= iv.q.p90,
      baselineMinutes: pos(j.baselineMinutes) ? j.baselineMinutes : null,
      source: sourceFor(pred.typeN),
    });

    // learn AFTER predicting (strictly out-of-sample)
    poolAdd(state.globalPool, e);
    let tp = state.typePools.get(typeKey);
    if (!tp) {
      tp = newPool();
      state.typePools.set(typeKey, tp);
    }
    poolAdd(tp, e);
    learn(state, ctx, j.completedAtMs, y, pred);

    const acts = typeActuals.get(typeKey);
    if (acts) acts.push(j.actualMinutes);
    else typeActuals.set(typeKey, [j.actualMinutes]);
  }

  return { version: MODEL_VERSION, trainedAtMs: nowMs, trainedOn: valid.length, dropped, records, typeActuals, state };
}

// ============================================================
// Prediction
// ============================================================

export interface FactorContribution {
  id: StageDef['id'] | 'type' | 'start';
  label: string;
  /** Signed minutes this factor added at that point in the chain. */
  minutes: number;
  detail: string;
  n: number;
}

export interface DurationPrediction {
  jobTypeKey: string;
  minutes: number; // P50
  low: number; // P10
  high: number; // P90
  quantiles: QuantileSet;
  intervalLevel: number;
  intervalMethod: 'empirical' | 'parametric';
  confidence: Confidence;
  source: PredictionSource;
  /** Raw completed jobs of this type behind the number. */
  sampleSize: number;
  effectiveSampleSize: number;
  existing: ExistingEstimate;
  deltaVsExisting: number;
  deltaVsExistingPct: number;
  agreement: 'aligned' | 'longer' | 'shorter';
  factors: FactorContribution[];
  modelVersion: string;
}

const pctText = (delta: number) => `${delta >= 0 ? '+' : ''}${Math.round((Math.exp(delta) - 1) * 100)}%`;

export function predictDuration(model: TrainedModel, ctx: PredictionContext, nowMs: number = Date.now()): DurationPrediction {
  const typeKey = durationKey(ctx.jobTypeKey);
  const existing = ctx.existing ?? { minutes: DURATION_MODEL.defaultMinutes, source: 'default' as const };
  const prior = isExplicitEstimate(existing) ? existing.minutes : null;

  const pred = predictLog(model.state, { ...ctx, jobTypeKey: typeKey }, nowMs, prior);
  const iv = intervalFor(model.state, typeKey, pred.total, pred.typeN);
  const source = sourceFor(pred.typeN);

  // Confidence: effective evidence AND how tight the range actually is.
  const ratio = iv.q.p90 / Math.max(1, iv.q.p10);
  let confidence: Confidence = 'low';
  if (source !== 'prior') {
    if (pred.typeNEff >= 15 && ratio <= 1.8 && iv.method === 'empirical') confidence = 'high';
    else if (pred.typeNEff >= 6 && ratio <= 2.6) confidence = 'medium';
  }

  // Explainability chain in minutes.
  const factors: FactorContribution[] = [];
  let prev = Math.exp(pred.center);
  factors.push({
    id: 'start',
    label: prior ? `Your ${existing.source.replace('_', ' ')} estimate` : 'Account average',
    minutes: Math.round(prev),
    detail: prior ? 'Starting point before learning' : 'All completed jobs',
    n: model.trainedOn,
  });
  let cum = pred.mu;
  let now = Math.exp(cum);
  if (Math.abs(now - prev) >= 0.5) {
    factors.push({ id: 'type', label: 'Job type history', minutes: Math.round(now - prev), detail: `${pred.typeN} completed ${typeKey} jobs`, n: pred.typeN });
  }
  prev = now;
  for (const s of pred.stages) {
    cum += s.delta;
    now = Math.exp(cum);
    if (Math.abs(now - prev) >= 0.5) {
      factors.push({ id: s.id, label: s.label, minutes: Math.round(now - prev), detail: `${pctText(s.delta)} · ${s.n} past job${s.n === 1 ? '' : 's'}`, n: s.n });
    }
    prev = now;
  }

  const delta = iv.q.p50 - existing.minutes;
  const deltaPct = existing.minutes > 0 ? delta / existing.minutes : 0;

  return {
    jobTypeKey: typeKey,
    minutes: iv.q.p50,
    low: iv.q.p10,
    high: iv.q.p90,
    quantiles: iv.q,
    intervalLevel: DURATION_MODEL.intervalLevel,
    intervalMethod: iv.method,
    confidence,
    source,
    sampleSize: pred.typeN,
    effectiveSampleSize: Math.round(pred.typeNEff * 10) / 10,
    existing,
    deltaVsExisting: delta,
    deltaVsExistingPct: deltaPct,
    agreement: Math.abs(deltaPct) <= 0.15 ? 'aligned' : delta > 0 ? 'longer' : 'shorter',
    factors,
    modelVersion: model.version,
  };
}

/**
 * Minutes to reserve for booking / dispatch.
 *   tight = P50 · balanced = P75 · safe = P90, rounded UP to the slot step.
 * Returns null when the model has no learned opinion (cold start) so callers keep
 * the existing estimate instead of being overridden by a guess.
 */
export function slotMinutesFor(pred: DurationPrediction, policy: SlotPolicy = 'balanced', step: number = DURATION_MODEL.slotStepMinutes): number | null {
  if (pred.source === 'prior') return null;
  if (pred.source === 'blend' && pred.confidence === 'low' && policy === 'tight') return null;
  const q = policy === 'tight' ? pred.quantiles.p50 : policy === 'safe' ? pred.quantiles.p90 : pred.quantiles.p75;
  const rounded = Math.ceil(q / step) * step;
  return clamp(rounded, step, DURATION_MODEL.maxMinutes);
}

// ============================================================
// Scorecards
// ============================================================

export interface BacktestSummary {
  n: number;
  mae: number;
  mape: number; // mean absolute % error, 0..1+
  medianApe: number;
  biasPct: number; // geometric mean signed error, % (positive = jobs run longer than predicted)
  coverage: number; // share of actuals inside [P10, P90]
  avgWidthRatio: number; // mean(high / low)
  baseline: { n: number; mae: number; mape: number; modelMae: number; improvementPct: number } | null;
}

export function summarizeBacktest(records: BacktestRecord[]): BacktestSummary {
  const n = records.length;
  if (n === 0) return { n: 0, mae: 0, mape: 0, medianApe: 0, biasPct: 0, coverage: 0, avgWidthRatio: 0, baseline: null };
  const ape = records.map((r) => Math.abs(r.actual - r.predicted) / r.actual);
  const mae = mean(records.map((r) => Math.abs(r.actual - r.predicted)));
  const withBase = records.filter((r) => r.baselineMinutes !== null);
  let baseline: BacktestSummary['baseline'] = null;
  if (withBase.length >= 5) {
    const bMae = mean(withBase.map((r) => Math.abs(r.actual - (r.baselineMinutes as number))));
    const bMape = mean(withBase.map((r) => Math.abs(r.actual - (r.baselineMinutes as number)) / r.actual));
    const mMae = mean(withBase.map((r) => Math.abs(r.actual - r.predicted)));
    baseline = { n: withBase.length, mae: bMae, mape: bMape, modelMae: mMae, improvementPct: bMae > 0 ? (1 - mMae / bMae) * 100 : 0 };
  }
  return {
    n,
    mae,
    mape: mean(ape),
    medianApe: median(ape),
    biasPct: (Math.exp(mean(records.map((r) => r.logError))) - 1) * 100,
    coverage: records.filter((r) => r.withinRange).length / n,
    avgWidthRatio: mean(records.map((r) => r.high / Math.max(1, r.low))),
    baseline,
  };
}

export interface GroupSummary extends BacktestSummary {
  key: string;
}

export function summarizeBy(records: BacktestRecord[], keyOf: (r: BacktestRecord) => string | null, minN = 1): GroupSummary[] {
  const groups = new Map<string, BacktestRecord[]>();
  for (const r of records) {
    const k = keyOf(r);
    if (k === null) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return Array.from(groups.entries())
    .filter(([, rs]) => rs.length >= minN)
    .map(([key, rs]) => ({ key, ...summarizeBacktest(rs) }))
    .sort((a, b) => b.n - a.n);
}

export interface TypeRow {
  key: string;
  n: number;
  medianMinutes: number;
  p10Minutes: number;
  p90Minutes: number;
}

export function typeTable(model: TrainedModel): TypeRow[] {
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return Array.from(model.typeActuals.entries())
    .map(([key, xs]) => ({ key, n: xs.length, medianMinutes: Math.round(median(xs)), p10Minutes: Math.round(q(xs, 0.1)), p90Minutes: Math.round(q(xs, 0.9)) }))
    .sort((a, b) => b.n - a.n);
}

/** Median of a type's measured jobs — the twin's "history" tier, for resolveExistingEstimate. */
export function historyFor(model: TrainedModel, jobTypeKey: string | null): { median: number | null; count: number } {
  const xs = model.typeActuals.get(durationKey(jobTypeKey));
  return xs && xs.length > 0 ? { median: median(xs), count: xs.length } : { median: null, count: 0 };
}

export interface EffectRow {
  id: string;
  /** Signed % this entity adds to a typical job right now (after shrinkage + decay). */
  effectPct: number;
  n: number;
}

function effectRows(map: Map<string, Stat>, k: number, nowMs: number, minN: number): EffectRow[] {
  const out: EffectRow[] = [];
  for (const [id, s] of map.entries()) {
    if (s.n < minN) continue;
    const r = readStat(s, nowMs);
    const eff = clamp(r.sv / (r.sw + k), -DURATION_MODEL.effectCap, DURATION_MODEL.effectCap);
    out.push({ id, effectPct: (Math.exp(eff) - 1) * 100, n: s.n });
  }
  return out.sort((a, b) => Math.abs(b.effectPct) - Math.abs(a.effectPct));
}

export const technicianEffects = (m: TrainedModel, nowMs: number = Date.now(), minN = 3): EffectRow[] =>
  effectRows(m.state.tech, DURATION_MODEL.shrinkage.technician, nowMs, minN);
export const equipmentTypeEffects = (m: TrainedModel, nowMs: number = Date.now(), minN = 3): EffectRow[] =>
  effectRows(m.state.eqType, DURATION_MODEL.shrinkage.equipmentType, nowMs, minN);

// ============================================================
// Drift detection
// ============================================================

export type DriftSeverity = 'info' | 'warning' | 'critical';
export type DriftKind = 'bias' | 'calibration' | 'shift';
export type DriftScope = 'overall' | 'job_type' | 'technician';

export interface DriftAlert {
  /** Stable key — the DB dedupes open alerts on it. */
  key: string;
  scope: DriftScope;
  scopeKey: string;
  kind: DriftKind;
  severity: DriftSeverity;
  direction: 'longer' | 'shorter' | 'narrow' | 'wide';
  message: string;
  recentN: number;
  referenceN: number;
  /** Mean signed error over the recent window, % (positive = longer than predicted). */
  biasPct: number;
  z: number;
  coverage: number | null;
  sinceMs: number | null;
}

export interface DriftReport {
  status: 'stable' | 'watch' | 'drifting' | 'insufficient_data';
  alerts: DriftAlert[];
  recentN: number;
  referenceN: number;
  windowStartMs: number | null;
}

const SEV_RANK: Record<DriftSeverity, number> = { info: 0, warning: 1, critical: 2 };

interface Evaluate {
  scope: DriftScope;
  scopeKey: string;
  label: string;
  recent: BacktestRecord[];
  reference: BacktestRecord[];
}

function cusum(errors: number[], sd: number): { active: boolean; startIdx: number } {
  let sp = 0;
  let sn = 0;
  let startP = 0;
  let startN = 0;
  for (let i = 0; i < errors.length; i++) {
    const z = errors[i] / sd;
    const np = Math.max(0, sp + z - DRIFT.cusumK);
    const nn = Math.max(0, sn - z - DRIFT.cusumK);
    if (sp === 0 && np > 0) startP = i;
    if (sn === 0 && nn > 0) startN = i;
    sp = np;
    sn = nn;
  }
  if (sp >= DRIFT.cusumH) return { active: true, startIdx: startP };
  if (sn >= DRIFT.cusumH) return { active: true, startIdx: startN };
  return { active: false, startIdx: 0 };
}

function evaluateScope(e: Evaluate, level: number): DriftAlert[] {
  const out: DriftAlert[] = [];
  const recentErr = e.recent.map((r) => r.logError);
  const refErr = e.reference.map((r) => r.logError);
  // Robust spread (MAD) so an earlier regime change inside the reference can't blunt detection.
  const refMed = median(refErr);
  const madSd = 1.4826 * median(refErr.map((x) => Math.abs(x - refMed)));
  const sd = Math.max(DRIFT.sdFloor, Math.min(stdev(refErr) || Infinity, madSd || Infinity));
  const n = e.recent.length;
  const meanErr = mean(recentErr);
  const biasPct = (Math.exp(meanErr) - 1) * 100;
  const z = meanErr / (sd / Math.sqrt(n));
  const where = e.scope === 'overall' ? 'Jobs' : e.scope === 'job_type' ? `${e.label} jobs` : `${e.label}'s jobs`;

  // 1) bias
  const absZ = Math.abs(z);
  const absPct = Math.abs(biasPct);
  let biasSev: DriftSeverity | null = null;
  if (absZ >= DRIFT.biasCritZ && absPct >= DRIFT.biasCritPct) biasSev = 'critical';
  else if (absZ >= DRIFT.biasWarnZ && absPct >= DRIFT.biasWarnPct) biasSev = 'warning';
  if (biasSev) {
    const longer = biasPct > 0;
    out.push({
      key: `${e.scope}:${e.scopeKey}:bias`,
      scope: e.scope,
      scopeKey: e.scopeKey,
      kind: 'bias',
      severity: biasSev,
      direction: longer ? 'longer' : 'shorter',
      message: `${where} are running ${Math.round(absPct)}% ${longer ? 'longer' : 'shorter'} than predicted over the last ${n}.`,
      recentN: n,
      referenceN: e.reference.length,
      biasPct,
      z,
      coverage: null,
      sinceMs: e.recent[0]?.completedAtMs ?? null,
    });
  }

  // 2) calibration (interval coverage)
  const cov = e.recent.filter((r) => r.withinRange).length / n;
  const covZ = (cov - level) / Math.sqrt((level * (1 - level)) / n);
  if (cov < level - DRIFT.coverageGap && covZ <= DRIFT.coverageWarnZ) {
    out.push({
      key: `${e.scope}:${e.scopeKey}:calibration`,
      scope: e.scope,
      scopeKey: e.scopeKey,
      kind: 'calibration',
      severity: covZ <= DRIFT.coverageCritZ ? 'critical' : 'warning',
      direction: 'narrow',
      message: `${where}: only ${Math.round(cov * 100)}% of recent actuals fell inside the ${Math.round(level * 100)}% range — ranges are too narrow right now.`,
      recentN: n,
      referenceN: e.reference.length,
      biasPct,
      z: covZ,
      coverage: cov,
      sinceMs: e.recent[0]?.completedAtMs ?? null,
    });
  }

  // 3) sustained shift (CUSUM) — earlier warning than the windowed bias test
  if (!biasSev) {
    const tail = [...e.reference, ...e.recent].slice(-DRIFT.cusumWindow);
    const c = cusum(tail.map((r) => r.logError), sd);
    if (c.active) {
      const since = tail.slice(c.startIdx);
      const sinceBias = (Math.exp(mean(since.map((r) => r.logError))) - 1) * 100;
      if (Math.abs(sinceBias) >= DRIFT.biasWarnPct) {
        const longer = sinceBias > 0;
        out.push({
          key: `${e.scope}:${e.scopeKey}:shift`,
          scope: e.scope,
          scopeKey: e.scopeKey,
          kind: 'shift',
          severity: 'warning',
          direction: longer ? 'longer' : 'shorter',
          message: `${where} have been trending ${Math.round(Math.abs(sinceBias))}% ${longer ? 'longer' : 'shorter'} than predicted since ${new Date(since[0].completedAtMs).toLocaleDateString()}.`,
          recentN: n,
          referenceN: e.reference.length,
          biasPct: sinceBias,
          z,
          coverage: cov,
          sinceMs: since[0].completedAtMs,
        });
      }
    }
  }
  return out;
}

export interface DriftOptions {
  nowMs?: number;
  /** id -> display name, used in alert text. */
  labels?: Record<string, string>;
}

export function detectDrift(records: BacktestRecord[], opts: DriftOptions = {}): DriftReport {
  const nowMs = opts.nowMs ?? Date.now();
  const sorted = [...records].sort((a, b) => a.completedAtMs - b.completedAtMs);
  const cutoff = nowMs - DRIFT.recentDays * MS_PER_DAY;
  let recent = sorted.filter((r) => r.completedAtMs >= cutoff);
  if (recent.length < DRIFT.minRecent) recent = sorted.slice(-DRIFT.fallbackRecent);
  const firstRecent = recent[0]?.completedAtMs ?? Infinity;
  const reference = sorted.filter((r) => r.completedAtMs < firstRecent).slice(-DRIFT.referenceCap);

  if (recent.length < DRIFT.minRecent || reference.length < DRIFT.minReference) {
    return { status: 'insufficient_data', alerts: [], recentN: recent.length, referenceN: reference.length, windowStartMs: recent[0]?.completedAtMs ?? null };
  }

  const level = DURATION_MODEL.intervalLevel;
  const alerts: DriftAlert[] = [];
  alerts.push(...evaluateScope({ scope: 'overall', scopeKey: 'all', label: 'All', recent, reference }, level));

  const recentSet = new Set(recent.map((r) => r.jobId));
  const bucket = (keyOf: (r: BacktestRecord) => string | null) => {
    const m = new Map<string, { recent: BacktestRecord[]; reference: BacktestRecord[] }>();
    for (const r of sorted) {
      const k = keyOf(r);
      if (k === null) continue;
      const isRecent = recentSet.has(r.jobId);
      if (!isRecent && r.completedAtMs >= firstRecent) continue;
      let b = m.get(k);
      if (!b) {
        b = { recent: [], reference: [] };
        m.set(k, b);
      }
      (isRecent ? b.recent : b.reference).push(r);
    }
    return m;
  };

  const labels = opts.labels ?? {};
  for (const [scope, keyOf] of [
    ['job_type', (r: BacktestRecord) => r.jobTypeKey] as const,
    ['technician', (r: BacktestRecord) => r.technicianId] as const,
  ]) {
    for (const [k, b] of bucket(keyOf).entries()) {
      if (b.recent.length < DRIFT.minScopeRecent || b.reference.length < DRIFT.minScopeReference) continue;
      alerts.push(
        ...evaluateScope({ scope, scopeKey: k, label: labels[k] ?? k, recent: b.recent, reference: b.reference.slice(-DRIFT.referenceCap) }, level),
      );
    }
  }

  // one alert per key, highest severity wins
  const best = new Map<string, DriftAlert>();
  for (const a of alerts) {
    const cur = best.get(a.key);
    if (!cur || SEV_RANK[a.severity] > SEV_RANK[cur.severity]) best.set(a.key, a);
  }
  const final = Array.from(best.values()).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || Math.abs(b.biasPct) - Math.abs(a.biasPct));
  const status = final.some((a) => a.severity === 'critical') ? 'drifting' : final.length > 0 ? 'watch' : 'stable';
  return { status, alerts: final, recentN: recent.length, referenceN: reference.length, windowStartMs: recent[0]?.completedAtMs ?? null };
}

// ============================================================
// Convenience
// ============================================================

export const minutesBetween = (startMs: number, endMs: number): number => (endMs - startMs) / MS_PER_MIN;

export function formatMinutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r}m`;
  const h = Math.floor(r / 60);
  const rem = r % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export function formatRange(low: number, high: number): string {
  return `${formatMinutes(low)}–${formatMinutes(high)}`;
}
