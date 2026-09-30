/**
 * Vireek Continuous Improvement Loop.
 *
 *   Prediction -> Decision -> Action -> Outcome -> Compare expected vs actual
 *   -> Find error -> Learn -> Update model/workflow -> Repeat
 *
 * Prediction  = job_assurance_snapshots (Outcome Assurance, written before dispatch)
 * Outcome     = job_outcomes + jobs timestamps (what really happened)
 * Compare     = one variance per job and metric (duration, first-time-fix)
 * Find error  = evidence-based cause attribution (parts, technician, diagnosis,
 *               customer access, schedule/route, hidden issue, unexplained)
 * Learn       = shrunken, bounded correction factors per job type / technician,
 *               accepted ONLY if a time-ordered backtest proves they would have
 *               reduced error on jobs the fit never saw
 * Update      = a human (account owner) approves; the approved factor is then
 *               applied by Outcome Assurance (see correctionFactorFor)
 * Repeat      = the loop measures whether each active correction really helps
 *               and flags it for revert when it does not
 *
 * Design rules (same philosophy as outcomeLearning / outcomeAssurance):
 *  - Everything above the "DATA LAYER" banner is pure and deterministic.
 *  - No guessing: a cause needs recorded evidence; otherwise it is "unexplained".
 *  - Small samples are shrunk toward "no correction" (factor 1.0).
 *  - Rework jobs are excluded (they are the fix, not new demand).
 *  - Learning always starts from the prediction as it was BEFORE any correction,
 *    so an approved correction is never learned on top of itself.
 *  - Nothing changes the prediction engine without owner approval.
 *
 * Server counterpart: supabase/migrations/20270106000000_continuous_improvement_loop.sql
 */

import { supabase } from '@/lib/supabase';
import { correctionFactorFor, jobTypeMatches, type DurationCorrectionLite } from '@/lib/outcomeAssurance';

// ============================================================
// TYPES
// ============================================================

export type CauseKey =
  | 'parts'
  | 'technician_skill'
  | 'diagnosis'
  | 'customer_access'
  | 'schedule_route'
  | 'hidden_issue'
  | 'unexplained';

export type CauseEvidence = 'measured' | 'inferred';
export type Direction = 'over' | 'under' | 'on_target';
export type CorrectionStatus = 'proposed' | 'active' | 'superseded' | 'reverted' | 'dismissed';
export type CorrectionScope = 'job_type' | 'technician';

export interface LoopRecord {
  jobId: string;
  customerName: string;
  serviceType: string | null;
  /** Normalised group key (outcome job type, else service type). */
  jobTypeKey: string;
  /** Technician who actually did the job. */
  technicianId: string | null;
  /** Technician the prediction was made for. */
  predictedTechnicianId: string | null;
  completedAt: string;
  // --- prediction: final pre-dispatch snapshot ---
  predictedAt: string | null;
  predictedMinutes: number | null;
  /** 0-100 */
  predictedProbability: number | null;
  partsScore: number | null;
  techFitScore: number | null;
  diagnosisScore: number | null;
  scheduleScore: number | null;
  predictedIssue: string | null;
  // --- reality ---
  actualMinutes: number | null;
  resolution: string;
  rootCauseKey: string | null;
  isRework: boolean;
  causedCallback: boolean;
  arrivalLateMinutes: number | null;
  accessWaitMinutes: number | null;
}

export interface CauseShare {
  key: CauseKey;
  /** 0..1, sums to 1 across a variance. */
  share: number;
  minutes: number;
  evidence: CauseEvidence;
  detail: string;
}

export interface DurationVariance {
  jobId: string;
  customerName: string;
  jobTypeKey: string;
  technicianId: string | null;
  completedAt: string;
  predictedAt: string;
  /** What Vireek actually told the business (after any approved correction). */
  issued: number;
  /** What the engine would have said without any correction. */
  baseline: number;
  actual: number;
  /** actual - issued (minutes). Positive = job ran longer than predicted. */
  error: number;
  ratio: number;
  direction: Direction;
  causes: CauseShare[];
  primaryCause: CauseKey | null;
}

export interface FtfVariance {
  jobId: string;
  customerName: string;
  jobTypeKey: string;
  technicianId: string | null;
  completedAt: string;
  predictedAt: string;
  /** 0-100 */
  predicted: number;
  success: boolean;
  /** over = worse than predicted, under = better than predicted. */
  direction: Direction;
  causes: CauseShare[];
  primaryCause: CauseKey | null;
}

export interface DurationScore {
  n: number;
  /** Share of jobs within tolerance (0..1). */
  hitRate: number | null;
  /** Mean absolute error in minutes. */
  mae: number | null;
  /** Median actual/issued. >1 means Vireek under-predicts duration. */
  medianRatio: number | null;
  overShare: number | null;
  underShare: number | null;
}

export interface CalibrationBucket {
  label: string;
  n: number;
  predicted: number;
  actual: number;
}

export interface FtfScore {
  n: number;
  /** 0 (perfect) .. 1. Lower is better. */
  brier: number | null;
  predictedAvg: number | null;
  actualRate: number | null;
  /** predicted - actual, in percentage points. Positive = over-confident. */
  gapPoints: number | null;
  buckets: CalibrationBucket[];
}

export interface TrendPoint {
  weekStart: string;
  n: number;
  hitRate: number | null;
  mae: number | null;
}

export interface Backtest {
  nFit: number;
  nTest: number;
  factorFit: number;
  maeBefore: number;
  maeAfter: number;
  improvementPct: number;
}

export interface CorrectionProposal {
  scope: CorrectionScope;
  jobTypeKey: string | null;
  technicianId: string | null;
  label: string;
  factor: number;
  n: number;
  medianRatio: number;
  backtest: Backtest;
}

export interface WatchingItem {
  scope: CorrectionScope;
  label: string;
  n: number;
  needed: number;
  medianRatio: number | null;
  reason: 'collecting' | 'not_validated';
}

export interface CorrectionPerformance {
  id: string;
  label: string;
  scope: CorrectionScope;
  factor: number;
  n: number;
  maeIssued: number | null;
  maeBaseline: number | null;
  /** Positive = the correction reduced error. */
  improvementPct: number | null;
  underperforming: boolean;
}

export interface CauseSummary {
  jobTypeKey: string;
  overruns: number;
  overrunMinutes: number;
  byCause: Array<{ key: CauseKey; minutes: number; share: number; count: number }>;
}

export interface WorkflowAction {
  id: string;
  jobTypeKey: string;
  cause: CauseKey;
  severity: 'high' | 'medium';
  title: string;
  detail: string;
  minutes: number;
  href: string;
}

export interface CorrectionRow {
  id: string;
  scope: CorrectionScope;
  job_type_key: string | null;
  technician_id: string | null;
  factor: number;
  sample_size: number;
  backtest: Partial<Backtest>;
  status: CorrectionStatus;
  proposed_at: string;
  decided_at: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  decision_reason: string | null;
}

export interface LoopAnalysis {
  totals: { outcomes: number; predicted: number; unpredicted: number; rework: number };
  duration: DurationScore;
  ftf: FtfScore;
  trend: TrendPoint[];
  durationVariances: DurationVariance[];
  ftfVariances: FtfVariance[];
  causes: { overall: CauseSummary; byType: CauseSummary[] };
  proposals: CorrectionProposal[];
  watching: WatchingItem[];
  performance: CorrectionPerformance[];
  actions: WorkflowAction[];
}

// ============================================================
// CONSTANTS (documented so the loop is auditable)
// ============================================================

export const LOOP = {
  /** A job is "on target" when within 20% (and at least 15 min) of the prediction. */
  durationTolerance: 0.2,
  durationMinAbsMin: 15,
  /** Callbacks lag the job: first-time-fix is only judged on matured outcomes. */
  maturityDays: 14,
  /** Minimum jobs in a group before a correction can be proposed. */
  minGroupSamples: 8,
  /** Prior strength: the correction is shrunk toward 1.0 as if k neutral jobs existed. */
  priorStrength: 6,
  /** Ignore corrections smaller than 8%. */
  minFactorEffect: 0.08,
  factorMin: 0.5,
  factorMax: 2.0,
  /** Ratios are winsorised so one freak job cannot move a factor. */
  ratioClampMin: 0.25,
  ratioClampMax: 4,
  /** Backtest: fit on the oldest 70%, test on the newest 30%. */
  backtestFitShare: 0.7,
  minFitSamples: 5,
  minTestSamples: 3,
  /** A proposal must cut held-out MAE by at least 10%. */
  minImprovement: 0.1,
  /** Active correction is flagged when it is 10% WORSE than no correction over >= 6 jobs. */
  underperformMinJobs: 6,
  underperformWorsening: 0.1,
  /** Cause attribution: below this total evidence weight the overrun stays unexplained. */
  causeMinEvidence: 0.4,
  minTechnicianSample: 5,
  actionMinOverruns: 4,
  actionCauseShare: 0.3,
  lookbackDays: 180,
  trendWeeks: 8,
} as const;

export const CAUSE_LABELS: Record<CauseKey, string> = {
  parts: 'Parts',
  technician_skill: 'Technician skill',
  diagnosis: 'Diagnosis',
  customer_access: 'Customer / site access',
  schedule_route: 'Schedule / route',
  hidden_issue: 'Hidden issue',
  unexplained: 'Unexplained',
};

export const CAUSE_COLORS: Record<CauseKey, string> = {
  parts: 'bg-warning-500',
  technician_skill: 'bg-accent',
  diagnosis: 'bg-danger',
  customer_access: 'bg-success-500',
  schedule_route: 'bg-text-secondary',
  hidden_issue: 'bg-danger/60',
  unexplained: 'bg-bg-tertiary',
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// ============================================================
// SMALL HELPERS
// ============================================================

export const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Canonical group key for a job type ("AC Repair" -> "ac-repair"). */
export function normalizeKey(raw: string | null | undefined): string {
  const k = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/ /g, '-');
  return k || 'unclassified';
}

export function humanizeKey(key: string | null | undefined): string {
  if (!key || key === 'unclassified') return 'Unclassified';
  const s = key.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function weekStartIso(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

// ============================================================
// CORRECTION HISTORY (recover the prediction BEFORE any correction)
// ============================================================

/** Corrections that were live at a given instant, from the full history. */
export function correctionsActiveAt(rows: CorrectionRow[], atMs: number): DurationCorrectionLite[] {
  return rows
    .filter((r) => {
      if (!r.activated_at) return false;
      if (Date.parse(r.activated_at) > atMs) return false;
      return !r.deactivated_at || Date.parse(r.deactivated_at) > atMs;
    })
    .map((r) => ({ scope: r.scope, job_type_key: r.job_type_key, technician_id: r.technician_id, factor: r.factor }));
}

/** The duration the engine would have predicted with no correction applied. */
export function baselineMinutes(rec: LoopRecord, history: CorrectionRow[]): number | null {
  if (!rec.predictedMinutes || rec.predictedMinutes <= 0 || !rec.predictedAt) return null;
  const at = Date.parse(rec.predictedAt);
  if (!Number.isFinite(at)) return null;
  const f = correctionFactorFor(correctionsActiveAt(history, at), rec.serviceType, rec.predictedTechnicianId ?? rec.technicianId);
  return rec.predictedMinutes / f;
}

// ============================================================
// COMPARE: expected vs actual
// ============================================================

export function durationDirection(issued: number, actual: number): Direction {
  const tol = Math.max(LOOP.durationMinAbsMin, issued * LOOP.durationTolerance);
  const diff = actual - issued;
  if (diff > tol) return 'over';
  if (diff < -tol) return 'under';
  return 'on_target';
}

export interface EligibleDuration {
  rec: LoopRecord;
  issued: number;
  baseline: number;
  actual: number;
}

function eligibleDurations(records: LoopRecord[], history: CorrectionRow[]): EligibleDuration[] {
  const out: EligibleDuration[] = [];
  for (const rec of records) {
    if (rec.isRework) continue;
    if (!rec.actualMinutes || rec.actualMinutes <= 0) continue;
    const baseline = baselineMinutes(rec, history);
    if (baseline === null || !rec.predictedMinutes) continue;
    out.push({ rec, issued: rec.predictedMinutes, baseline, actual: rec.actualMinutes });
  }
  return out;
}

const isSuccess = (r: LoopRecord) => r.resolution === 'fixed_first_visit' && !r.causedCallback;
const isMatured = (r: LoopRecord, now: number) => now - Date.parse(r.completedAt) >= LOOP.maturityDays * DAY_MS;

// ============================================================
// FIND ERROR: cause attribution (evidence only, never a guess)
// ============================================================

interface Candidate {
  key: CauseKey;
  w: number;
  evidence: CauseEvidence;
  detail: string;
}

/**
 * Turns recorded evidence into cause weights. `techResidual` is the technician's
 * historical log-ratio versus the company norm (null when there is too little history).
 */
export function attributeCauses(rec: LoopRecord, ratio: number, overMinutes: number, techResidual: number | null): CauseShare[] {
  const cand: Candidate[] = [];

  // Parts
  if (rec.resolution === 'parts_pending') {
    cand.push({ key: 'parts', w: 0.9, evidence: 'measured', detail: 'The job was closed as "parts pending".' });
  } else if (rec.partsScore !== null && rec.partsScore < 60) {
    cand.push({
      key: 'parts',
      w: Math.min(0.75, 0.35 + (60 - rec.partsScore) / 100),
      evidence: 'measured',
      detail: `Parts readiness was ${Math.round(rec.partsScore)}% at dispatch.`,
    });
  }

  // Technician skill: fit at dispatch, or a consistent historical pattern
  let tech: Candidate | null = null;
  if (rec.techFitScore !== null && rec.techFitScore < 60) {
    tech = {
      key: 'technician_skill',
      w: Math.min(0.7, 0.3 + (60 - rec.techFitScore) / 120),
      evidence: 'measured',
      detail: `Technician fit was ${Math.round(rec.techFitScore)}% at dispatch.`,
    };
  }
  if (techResidual !== null && techResidual > Math.log(1.15)) {
    const w = Math.min(0.8, 0.4 + techResidual);
    if (!tech || w > tech.w) {
      tech = {
        key: 'technician_skill',
        w,
        evidence: 'measured',
        detail: `This technician's jobs run about ${Math.round((Math.exp(techResidual) - 1) * 100)}% longer than the company norm.`,
      };
    }
  }
  if (tech) cand.push(tech);

  // Diagnosis: AI diagnosis vs the recorded root cause, or a weak diagnosis score
  if (rec.predictedIssue && rec.rootCauseKey && !jobTypeMatches(rec.predictedIssue, rec.rootCauseKey)) {
    cand.push({
      key: 'diagnosis',
      w: 0.7,
      evidence: 'measured',
      detail: `The pre-arrival diagnosis did not match the recorded root cause (${humanizeKey(rec.rootCauseKey)}).`,
    });
  } else if (rec.diagnosisScore !== null && rec.diagnosisScore < 55) {
    cand.push({
      key: 'diagnosis',
      w: Math.min(0.55, 0.3 + (55 - rec.diagnosisScore) / 150),
      evidence: 'measured',
      detail: `Diagnosis confidence was only ${Math.round(rec.diagnosisScore)}% at dispatch.`,
    });
  }

  // Customer / site access: waited on site before work could start
  if (rec.accessWaitMinutes !== null && rec.accessWaitMinutes >= 20) {
    cand.push({
      key: 'customer_access',
      w: Math.min(0.9, 0.3 + rec.accessWaitMinutes / 120),
      evidence: 'measured',
      detail: `${Math.round(rec.accessWaitMinutes)} min passed between arrival and starting work.`,
    });
  }

  // Schedule / route
  if (rec.arrivalLateMinutes !== null && rec.arrivalLateMinutes >= 30) {
    cand.push({
      key: 'schedule_route',
      w: Math.min(0.7, 0.25 + rec.arrivalLateMinutes / 180),
      evidence: 'measured',
      detail: `The technician arrived ${Math.round(rec.arrivalLateMinutes)} min after the scheduled time.`,
    });
  } else if (rec.scheduleScore !== null && rec.scheduleScore < 50) {
    cand.push({
      key: 'schedule_route',
      w: 0.3,
      evidence: 'measured',
      detail: `The technician's day was already tight at dispatch (schedule score ${Math.round(rec.scheduleScore)}%).`,
    });
  }

  // Hidden issue: nothing recorded explains a large overrun on a job that was fixed
  const strongest = cand.reduce((m, c) => Math.max(m, c.w), 0);
  if (strongest < 0.4 && ratio >= 1.5 && rec.resolution.startsWith('fixed')) {
    cand.push({
      key: 'hidden_issue',
      w: 0.5,
      evidence: 'inferred',
      detail: 'No recorded factor explains the overrun; an unforeseen condition was likely found on site.',
    });
  }

  const total = cand.reduce((s, c) => s + c.w, 0);
  if (total < LOOP.causeMinEvidence) {
    return [
      {
        key: 'unexplained',
        share: 1,
        minutes: round1(overMinutes),
        evidence: 'inferred',
        detail: 'Not enough recorded evidence to attribute this variance. Vireek will not guess.',
      },
    ];
  }
  return cand
    .map((c) => ({ key: c.key, share: round3(c.w / total), minutes: round1((c.w / total) * overMinutes), evidence: c.evidence, detail: c.detail }))
    .filter((c) => c.share >= 0.05)
    .sort((a, b) => b.share - a.share);
}

/** Per-technician residual (median log-ratio minus company median), needs >= 5 jobs. */
export function technicianResiduals(items: EligibleDuration[]): Map<string, number> {
  const logs = (xs: EligibleDuration[]) =>
    xs.map((x) => Math.log(clamp(x.actual / x.baseline, LOOP.ratioClampMin, LOOP.ratioClampMax)));
  const company = median(logs(items));
  const out = new Map<string, number>();
  if (company === null) return out;
  const byTech = new Map<string, EligibleDuration[]>();
  for (const it of items) {
    if (!it.rec.technicianId) continue;
    const list = byTech.get(it.rec.technicianId) ?? [];
    list.push(it);
    byTech.set(it.rec.technicianId, list);
  }
  for (const [id, list] of byTech) {
    if (list.length < LOOP.minTechnicianSample) continue;
    const m = median(logs(list));
    if (m !== null) out.set(id, m - company);
  }
  return out;
}

// ============================================================
// LEARN: shrunken, bounded, backtested corrections
// ============================================================

interface Sample {
  at: number;
  base: number;
  actual: number;
}

/** Geometric-mean ratio, shrunk toward 1.0 by `priorStrength` neutral pseudo-jobs. */
export function fitFactor(samples: Sample[]): number {
  if (samples.length === 0) return 1;
  let s = 0;
  for (const x of samples) s += Math.log(clamp(x.actual / x.base, LOOP.ratioClampMin, LOOP.ratioClampMax));
  return clamp(Math.exp(s / (samples.length + LOOP.priorStrength)), LOOP.factorMin, LOOP.factorMax);
}

/** Time-ordered holdout: fit on the oldest 70%, measure on the newest 30%. */
export function backtestFactor(samples: Sample[]): Backtest | null {
  const s = [...samples].sort((a, b) => a.at - b.at);
  const nFit = Math.floor(s.length * LOOP.backtestFitShare);
  const test = s.slice(nFit);
  if (nFit < LOOP.minFitSamples || test.length < LOOP.minTestSamples) return null;
  const f = fitFactor(s.slice(0, nFit));
  const before = mean(test.map((x) => Math.abs(x.actual - x.base))) ?? 0;
  const after = mean(test.map((x) => Math.abs(x.actual - x.base * f))) ?? 0;
  return {
    nFit,
    nTest: test.length,
    factorFit: round3(f),
    maeBefore: round1(before),
    maeAfter: round1(after),
    improvementPct: before > 0 ? round1((1 - after / before) * 100) : 0,
  };
}

interface Group {
  scope: CorrectionScope;
  jobTypeKey: string | null;
  technicianId: string | null;
  label: string;
  samples: Sample[];
}

function evaluateGroup(g: Group): { proposal: CorrectionProposal | null; watching: WatchingItem | null } {
  const n = g.samples.length;
  const ratios = g.samples.map((x) => x.actual / x.base);
  const medianRatio = median(ratios);
  if (n < LOOP.minGroupSamples) {
    return {
      proposal: null,
      watching: n >= 3 ? { scope: g.scope, label: g.label, n, needed: LOOP.minGroupSamples, medianRatio, reason: 'collecting' } : null,
    };
  }
  const factor = fitFactor(g.samples);
  if (Math.abs(factor - 1) < LOOP.minFactorEffect) return { proposal: null, watching: null };

  const bt = backtestFactor(g.samples);
  const sameDirection = bt !== null && Math.sign(bt.factorFit - 1) === Math.sign(factor - 1);
  if (!bt || !sameDirection || bt.improvementPct / 100 < LOOP.minImprovement) {
    return {
      proposal: null,
      watching: { scope: g.scope, label: g.label, n, needed: LOOP.minGroupSamples, medianRatio, reason: bt ? 'not_validated' : 'collecting' },
    };
  }
  return {
    proposal: {
      scope: g.scope,
      jobTypeKey: g.jobTypeKey,
      technicianId: g.technicianId,
      label: g.label,
      factor: round3(factor),
      n,
      medianRatio: round3(medianRatio ?? 1),
      backtest: bt,
    },
    watching: null,
  };
}

export function learnCorrections(
  items: EligibleDuration[],
  techNames: Map<string, string>,
): { proposals: CorrectionProposal[]; watching: WatchingItem[] } {
  const proposals: CorrectionProposal[] = [];
  const watching: WatchingItem[] = [];

  // 1) Job-type factors from the un-corrected baseline
  const byType = new Map<string, Sample[]>();
  for (const it of items) {
    if (it.rec.jobTypeKey === 'unclassified') continue;
    const list = byType.get(it.rec.jobTypeKey) ?? [];
    list.push({ at: Date.parse(it.rec.completedAt), base: it.baseline, actual: it.actual });
    byType.set(it.rec.jobTypeKey, list);
  }
  const typeFactor = new Map<string, number>();
  for (const [key, samples] of byType) {
    const r = evaluateGroup({ scope: 'job_type', jobTypeKey: key, technicianId: null, label: humanizeKey(key), samples });
    if (r.proposal) {
      proposals.push(r.proposal);
      typeFactor.set(key, r.proposal.factor);
    }
    if (r.watching) watching.push(r.watching);
  }

  // 2) Technician factors on what the job-type factor does not already explain
  const byTech = new Map<string, Sample[]>();
  for (const it of items) {
    if (!it.rec.technicianId) continue;
    const base = it.baseline * (typeFactor.get(it.rec.jobTypeKey) ?? 1);
    const list = byTech.get(it.rec.technicianId) ?? [];
    list.push({ at: Date.parse(it.rec.completedAt), base, actual: it.actual });
    byTech.set(it.rec.technicianId, list);
  }
  for (const [id, samples] of byTech) {
    const r = evaluateGroup({ scope: 'technician', jobTypeKey: null, technicianId: id, label: techNames.get(id) ?? 'Technician', samples });
    if (r.proposal) proposals.push(r.proposal);
    if (r.watching) watching.push(r.watching);
  }

  proposals.sort((a, b) => Math.abs(Math.log(b.factor)) * b.n - Math.abs(Math.log(a.factor)) * a.n);
  watching.sort((a, b) => b.n - a.n);
  return { proposals, watching };
}

// ============================================================
// REPEAT: does each active correction really help?
// ============================================================

export function evaluateActiveCorrections(
  items: EligibleDuration[],
  history: CorrectionRow[],
  techNames: Map<string, string>,
): CorrectionPerformance[] {
  const out: CorrectionPerformance[] = [];
  for (const c of history) {
    if (c.status !== 'active' || !c.activated_at) continue;
    const since = Date.parse(c.activated_at);
    const rows = items.filter((it) => {
      if (!it.rec.predictedAt || Date.parse(it.rec.predictedAt) < since) return false;
      return c.scope === 'job_type'
        ? jobTypeMatches(it.rec.serviceType, c.job_type_key)
        : (it.rec.predictedTechnicianId ?? it.rec.technicianId) === c.technician_id;
    });
    const maeIssued = mean(rows.map((r) => Math.abs(r.actual - r.issued)));
    const maeBaseline = mean(rows.map((r) => Math.abs(r.actual - r.baseline)));
    const improvementPct = maeIssued !== null && maeBaseline !== null && maeBaseline > 0 ? round1((1 - maeIssued / maeBaseline) * 100) : null;
    out.push({
      id: c.id,
      label: c.scope === 'job_type' ? humanizeKey(c.job_type_key) : techNames.get(c.technician_id ?? '') ?? 'Technician',
      scope: c.scope,
      factor: c.factor,
      n: rows.length,
      maeIssued: maeIssued === null ? null : round1(maeIssued),
      maeBaseline: maeBaseline === null ? null : round1(maeBaseline),
      improvementPct,
      underperforming:
        rows.length >= LOOP.underperformMinJobs &&
        maeIssued !== null &&
        maeBaseline !== null &&
        maeIssued > maeBaseline * (1 + LOOP.underperformWorsening),
    });
  }
  return out;
}

// ============================================================
// UPDATE WORKFLOW: turn recurring causes into concrete, human-approved actions
// ============================================================

const ACTION_COPY: Record<Exclude<CauseKey, 'unexplained'>, { title: (t: string) => string; detail: string; href: string }> = {
  parts: {
    title: (t) => `Require confirmed parts before dispatching "${t}"`,
    detail: 'Parts shortages keep turning these jobs into overruns. Hold dispatch until parts are verified or sourced.',
    href: '/dashboard/parts-market',
  },
  technician_skill: {
    title: (t) => `Pair or coach technicians on "${t}"`,
    detail: 'Overruns concentrate on technicians with weak fit for this work. Pair them with a strong technician or route the job elsewhere.',
    href: '/dashboard/skill-graph',
  },
  diagnosis: {
    title: (t) => `Strengthen the diagnosis checklist for "${t}"`,
    detail: 'The pre-arrival diagnosis keeps missing the real root cause. Add the missed root cause to the playbook checklist.',
    href: '/dashboard/trade-playbooks',
  },
  customer_access: {
    title: (t) => `Confirm site access before dispatching "${t}"`,
    detail: 'Time is lost between arrival and starting work. Confirm access, permits and availability with the customer beforehand.',
    href: '/dashboard/dispatch',
  },
  schedule_route: {
    title: (t) => `Add schedule buffer around "${t}" jobs`,
    detail: 'Late arrivals and tight days keep stretching these jobs. Add buffer time or rebalance the route.',
    href: '/dashboard/dispatch',
  },
  hidden_issue: {
    title: (t) => `Quote an on-site discovery allowance for "${t}"`,
    detail: 'Large overruns with no recorded cause point to conditions found on site. Add a discovery allowance to the quote and to the duration.',
    href: '/dashboard/outcome-assurance',
  },
};

export function buildActions(byType: CauseSummary[]): WorkflowAction[] {
  const actions: WorkflowAction[] = [];
  for (const t of byType) {
    if (t.overruns < LOOP.actionMinOverruns) continue;
    for (const c of t.byCause) {
      if (c.key === 'unexplained' || c.share < LOOP.actionCauseShare || c.count < 2) continue;
      const copy = ACTION_COPY[c.key];
      actions.push({
        id: `${t.jobTypeKey}:${c.key}`,
        jobTypeKey: t.jobTypeKey,
        cause: c.key,
        severity: c.share >= 0.5 ? 'high' : 'medium',
        title: copy.title(humanizeKey(t.jobTypeKey)),
        detail: `${copy.detail} (${Math.round(c.share * 100)}% of ${Math.round(t.overrunMinutes)} overrun minutes across ${t.overruns} jobs)`,
        minutes: Math.round(c.minutes),
        href: copy.href,
      });
    }
  }
  return actions.sort((a, b) => b.minutes - a.minutes).slice(0, 8);
}

function summarizeCauses(jobTypeKey: string, variances: DurationVariance[]): CauseSummary {
  const over = variances.filter((v) => v.direction === 'over');
  const acc = new Map<CauseKey, { minutes: number; count: number }>();
  let total = 0;
  for (const v of over) {
    for (const c of v.causes) {
      const cur = acc.get(c.key) ?? { minutes: 0, count: 0 };
      cur.minutes += c.minutes;
      cur.count += 1;
      acc.set(c.key, cur);
      total += c.minutes;
    }
  }
  return {
    jobTypeKey,
    overruns: over.length,
    overrunMinutes: round1(total),
    byCause: [...acc.entries()]
      .map(([key, v]) => ({ key, minutes: round1(v.minutes), count: v.count, share: total > 0 ? round3(v.minutes / total) : 0 }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}

// ============================================================
// SCORECARDS
// ============================================================

function scoreDuration(v: Array<{ issued: number; actual: number; direction: Direction }>): DurationScore {
  const n = v.length;
  if (n === 0) return { n: 0, hitRate: null, mae: null, medianRatio: null, overShare: null, underShare: null };
  return {
    n,
    hitRate: round3(v.filter((x) => x.direction === 'on_target').length / n),
    mae: round1(mean(v.map((x) => Math.abs(x.actual - x.issued))) ?? 0),
    medianRatio: round3(median(v.map((x) => x.actual / x.issued)) ?? 1),
    overShare: round3(v.filter((x) => x.direction === 'over').length / n),
    underShare: round3(v.filter((x) => x.direction === 'under').length / n),
  };
}

function scoreFtf(v: FtfVariance[]): FtfScore {
  const n = v.length;
  if (n === 0) return { n: 0, brier: null, predictedAvg: null, actualRate: null, gapPoints: null, buckets: [] };
  const brier = mean(v.map((x) => (x.predicted / 100 - (x.success ? 1 : 0)) ** 2)) ?? 0;
  const predictedAvg = mean(v.map((x) => x.predicted)) ?? 0;
  const actualRate = (v.filter((x) => x.success).length / n) * 100;
  const edges: Array<[number, number, string]> = [
    [0, 60, '<60%'],
    [60, 75, '60-74%'],
    [75, 90, '75-89%'],
    [90, 101, '90%+'],
  ];
  const buckets: CalibrationBucket[] = [];
  for (const [lo, hi, label] of edges) {
    const rows = v.filter((x) => x.predicted >= lo && x.predicted < hi);
    if (rows.length === 0) continue;
    buckets.push({
      label,
      n: rows.length,
      predicted: round1(mean(rows.map((x) => x.predicted)) ?? 0),
      actual: round1((rows.filter((x) => x.success).length / rows.length) * 100),
    });
  }
  return {
    n,
    brier: round3(brier),
    predictedAvg: round1(predictedAvg),
    actualRate: round1(actualRate),
    gapPoints: round1(predictedAvg - actualRate),
    buckets,
  };
}

function buildTrend(variances: DurationVariance[], now: number): TrendPoint[] {
  const thisWeek = Date.parse(weekStartIso(now));
  const points: TrendPoint[] = [];
  for (let i = LOOP.trendWeeks - 1; i >= 0; i--) {
    const start = thisWeek - i * WEEK_MS;
    const rows = variances.filter((v) => {
      const t = Date.parse(v.completedAt);
      return t >= start && t < start + WEEK_MS;
    });
    const s = scoreDuration(rows);
    points.push({ weekStart: new Date(start).toISOString().slice(0, 10), n: s.n, hitRate: s.hitRate, mae: s.mae });
  }
  return points;
}

// ============================================================
// THE LOOP
// ============================================================

export function analyzeLoop(
  records: LoopRecord[],
  history: CorrectionRow[],
  techNames: Map<string, string> = new Map(),
  now: number = Date.now(),
): LoopAnalysis {
  const items = eligibleDurations(records, history);
  const residuals = technicianResiduals(items);

  // COMPARE + FIND ERROR: duration
  const durationVariances: DurationVariance[] = items
    .map(({ rec, issued, baseline, actual }): DurationVariance => {
      const ratio = actual / issued;
      const direction = durationDirection(issued, actual);
      const over = Math.max(0, actual - issued);
      const causes = direction === 'over' ? attributeCauses(rec, ratio, over, rec.technicianId ? residuals.get(rec.technicianId) ?? null : null) : [];
      return {
        jobId: rec.jobId,
        customerName: rec.customerName,
        jobTypeKey: rec.jobTypeKey,
        technicianId: rec.technicianId,
        completedAt: rec.completedAt,
        predictedAt: rec.predictedAt as string,
        issued: round1(issued),
        baseline: round1(baseline),
        actual: round1(actual),
        error: round1(actual - issued),
        ratio: round3(ratio),
        direction,
        causes,
        primaryCause: causes[0]?.key ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));

  // COMPARE + FIND ERROR: first-time fix (matured outcomes only)
  const ftfVariances: FtfVariance[] = records
    .filter((r) => !r.isRework && r.predictedProbability !== null && r.predictedAt && isMatured(r, now))
    .map((r): FtfVariance => {
      const success = isSuccess(r);
      const predicted = r.predictedProbability as number;
      const direction: Direction = !success && predicted >= 50 ? 'over' : success && predicted < 50 ? 'under' : 'on_target';
      const causes = !success ? attributeCauses(r, 1, 0, r.technicianId ? residuals.get(r.technicianId) ?? null : null) : [];
      return {
        jobId: r.jobId,
        customerName: r.customerName,
        jobTypeKey: r.jobTypeKey,
        technicianId: r.technicianId,
        completedAt: r.completedAt,
        predictedAt: r.predictedAt as string,
        predicted,
        success,
        direction,
        causes,
        primaryCause: causes[0]?.key ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));

  // LEARN
  const { proposals, watching } = learnCorrections(items, techNames);
  const performance = evaluateActiveCorrections(items, history, techNames);

  // UPDATE WORKFLOW
  const types = [...new Set(durationVariances.map((v) => v.jobTypeKey))];
  const byType = types
    .map((t) => summarizeCauses(t, durationVariances.filter((v) => v.jobTypeKey === t)))
    .filter((s) => s.overruns > 0)
    .sort((a, b) => b.overrunMinutes - a.overrunMinutes);

  const predicted = records.filter((r) => !r.isRework && r.predictedAt).length;
  return {
    totals: {
      outcomes: records.length,
      predicted,
      unpredicted: records.filter((r) => !r.isRework && !r.predictedAt).length,
      rework: records.filter((r) => r.isRework).length,
    },
    duration: scoreDuration(durationVariances),
    ftf: scoreFtf(ftfVariances),
    trend: buildTrend(durationVariances, now),
    durationVariances,
    ftfVariances,
    causes: { overall: summarizeCauses('all', durationVariances), byType },
    proposals,
    watching,
    performance,
    actions: buildActions(byType),
  };
}

// ============================================================
// PERSISTENCE PAYLOADS (pure)
// ============================================================

const MAX_VARIANCES = 400;

export function variancePayload(a: LoopAnalysis): Array<Record<string, unknown>> {
  const dur = a.durationVariances.map((v) => ({
    job_id: v.jobId,
    metric: 'duration',
    job_type_key: v.jobTypeKey,
    technician_id: v.technicianId,
    expected: v.issued,
    actual: v.actual,
    ratio: v.ratio,
    direction: v.direction,
    primary_cause: v.primaryCause,
    causes: v.causes,
    predicted_at: v.predictedAt,
  }));
  const ftf = a.ftfVariances.map((v) => ({
    job_id: v.jobId,
    metric: 'first_time_fix',
    job_type_key: v.jobTypeKey,
    technician_id: v.technicianId,
    expected: v.predicted,
    actual: v.success ? 100 : 0,
    ratio: null,
    direction: v.direction,
    primary_cause: v.primaryCause,
    causes: v.causes,
    predicted_at: v.predictedAt,
  }));
  return [...dur, ...ftf].slice(0, MAX_VARIANCES);
}

export function proposalPayload(a: LoopAnalysis): Array<Record<string, unknown>> {
  return a.proposals.map((p) => ({
    scope: p.scope,
    job_type_key: p.jobTypeKey,
    technician_id: p.technicianId,
    factor: p.factor,
    sample_size: p.n,
    backtest: p.backtest,
    evidence: { medianRatio: p.medianRatio, label: p.label },
  }));
}

// ============================================================
// DATA LAYER
// ============================================================

interface OutcomeDb {
  job_id: string;
  job_type_key: string | null;
  root_cause_key: string | null;
  resolution: string;
  duration_minutes: number | null;
  is_rework: boolean;
  caused_callback: boolean;
  technician_id: string | null;
  recorded_at: string;
}

interface JobDb {
  id: string;
  customer_name: string | null;
  service_type: string | null;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  started_at?: string | null;
  arrived_at?: string | null;
  completed_at?: string | null;
}

interface SnapshotDb {
  job_id: string;
  technician_id: string | null;
  probability: number | string;
  expected_minutes: number | null;
  factors: unknown;
  created_at: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** A missing table / column must never break the page: return an empty list. */
async function soft<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await p;
    if (error) return [];
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

async function fetchJobs(ids: string[]): Promise<JobDb[]> {
  const full = 'id, customer_name, service_type, scheduled_datetime, assigned_technician_id, started_at, arrived_at, completed_at';
  const basic = 'id, customer_name, service_type, scheduled_datetime, assigned_technician_id';
  try {
    const r = await supabase.from('jobs').select(full).in('id', ids);
    if (!r.error) return (r.data ?? []) as JobDb[];
  } catch {
    /* timing columns not migrated yet: fall back to the basic columns */
  }
  return soft<JobDb>(supabase.from('jobs').select(basic).in('id', ids));
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function factorScore(factors: unknown, key: string): number | null {
  if (!Array.isArray(factors)) return null;
  const f = factors.find((x) => x && typeof x === 'object' && (x as { key?: unknown }).key === key) as { score?: unknown } | undefined;
  return typeof f?.score === 'number' && Number.isFinite(f.score) ? f.score : null;
}

export interface LoopData {
  records: LoopRecord[];
  techNames: Map<string, string>;
}

export async function gatherLoopData(now: number = Date.now()): Promise<LoopData> {
  const since = new Date(now - LOOP.lookbackDays * DAY_MS).toISOString();
  const [outcomes, team] = await Promise.all([
    soft<OutcomeDb>(
      supabase
        .from('job_outcomes')
        .select('job_id, job_type_key, root_cause_key, resolution, duration_minutes, is_rework, caused_callback, technician_id, recorded_at')
        .gte('recorded_at', since)
        .order('recorded_at', { ascending: false })
        .limit(1000),
    ),
    soft<{ id: string; member_name: string | null; member_email: string | null }>(
      supabase.from('team_members').select('id, member_name, member_email'),
    ),
  ]);

  const techNames = new Map(team.map((m) => [m.id, m.member_name || m.member_email || 'Technician']));
  const ids = outcomes.map((o) => o.job_id);
  const groups = chunk(ids, 40);

  const [jobsG, snapsG, briefsG] = await Promise.all([
    Promise.all(groups.map((g) => fetchJobs(g))),
    Promise.all(
      groups.map((g) =>
        soft<SnapshotDb>(
          supabase
            .from('job_assurance_snapshots')
            .select('job_id, technician_id, probability, expected_minutes, factors, created_at')
            .in('job_id', g)
            .order('created_at', { ascending: false })
            .limit(2000),
        ),
      ),
    ),
    Promise.all(
      groups.map((g) => soft<{ job_id: string; predicted_issue: string | null }>(supabase.from('job_mission_briefs').select('job_id, predicted_issue').in('job_id', g))),
    ),
  ]);

  const jobs = new Map(jobsG.flat().map((j) => [j.id, j]));
  const briefs = new Map(briefsG.flat().map((b) => [b.job_id, b.predicted_issue]));
  const snapsByJob = new Map<string, SnapshotDb[]>();
  for (const s of snapsG.flat()) {
    const list = snapsByJob.get(s.job_id) ?? [];
    list.push(s);
    snapsByJob.set(s.job_id, list);
  }

  const records: LoopRecord[] = [];
  for (const o of outcomes) {
    const job = jobs.get(o.job_id);
    if (!job) continue;

    const started = ms(job.started_at);
    const arrived = ms(job.arrived_at);
    const completed = ms(job.completed_at);
    const scheduled = ms(job.scheduled_datetime);

    // The prediction that counts is the LAST one made before work began.
    const cutoff = started ?? arrived ?? completed ?? ms(o.recorded_at) ?? now;
    const snap = (snapsByJob.get(o.job_id) ?? []).find((s) => (ms(s.created_at) ?? Infinity) <= cutoff) ?? null;

    let actual: number | null = o.duration_minutes && o.duration_minutes > 0 ? o.duration_minutes : null;
    if (actual === null && started !== null && completed !== null) {
      const m = (completed - started) / 60000;
      if (m > 0 && m < 1440) actual = m;
    }

    const prob = snap ? Number(snap.probability) : NaN;
    records.push({
      jobId: o.job_id,
      customerName: job.customer_name ?? 'Customer',
      serviceType: job.service_type,
      jobTypeKey: normalizeKey(o.job_type_key || job.service_type),
      technicianId: o.technician_id ?? job.assigned_technician_id,
      predictedTechnicianId: snap?.technician_id ?? null,
      completedAt: job.completed_at ?? o.recorded_at,
      predictedAt: snap?.created_at ?? null,
      predictedMinutes: snap?.expected_minutes && snap.expected_minutes > 0 ? snap.expected_minutes : null,
      predictedProbability: Number.isFinite(prob) ? prob : null,
      partsScore: snap ? factorScore(snap.factors, 'parts') : null,
      techFitScore: snap ? factorScore(snap.factors, 'technician') : null,
      diagnosisScore: snap ? factorScore(snap.factors, 'diagnosis') : null,
      scheduleScore: snap ? factorScore(snap.factors, 'schedule') : null,
      predictedIssue: briefs.get(o.job_id) ?? null,
      actualMinutes: actual,
      resolution: o.resolution,
      rootCauseKey: o.root_cause_key,
      isRework: o.is_rework,
      causedCallback: o.caused_callback,
      arrivalLateMinutes: arrived !== null && scheduled !== null ? Math.max(0, (arrived - scheduled) / 60000) : null,
      accessWaitMinutes: started !== null && arrived !== null ? Math.max(0, (started - arrived) / 60000) : null,
    });
  }
  return { records, techNames };
}

export async function fetchCorrections(): Promise<CorrectionRow[]> {
  const rows = await soft<Record<string, unknown>>(
    supabase
      .from('improvement_corrections')
      .select('id, scope, job_type_key, technician_id, factor, sample_size, backtest, status, proposed_at, decided_at, activated_at, deactivated_at, decision_reason')
      .order('proposed_at', { ascending: false })
      .limit(300),
  );
  return rows
    .map((r) => ({ ...r, factor: Number(r.factor) }) as unknown as CorrectionRow)
    .filter((r) => Number.isFinite(r.factor));
}

/** Writes new variances and validated proposals. Idempotent; safe to call on every refresh. */
export async function persistLoopRun(a: LoopAnalysis): Promise<{ variances: number; proposals: number }> {
  const variances = variancePayload(a);
  const proposals = proposalPayload(a);
  if (variances.length === 0 && proposals.length === 0) return { variances: 0, proposals: 0 };
  const { data, error } = await supabase.rpc('record_improvement_run', { p_variances: variances, p_proposals: proposals });
  if (error) throw error;
  const d = (data ?? {}) as { variances?: number; proposals?: number };
  return { variances: d.variances ?? 0, proposals: d.proposals ?? 0 };
}

export async function decideCorrection(id: string, decision: 'approve' | 'dismiss' | 'revert', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('decide_improvement_correction', { p_id: id, p_decision: decision, p_reason: reason ?? null });
  if (error) throw error;
}
