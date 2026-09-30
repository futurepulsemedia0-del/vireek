/**
 * Vireek Outcome Assurance — Service Outcome Guarantee Engine.
 *
 * Before a technician is dispatched, estimate the probability that the job is
 * resolved successfully on the first visit, and intervene when confidence is low.
 *
 * Design rules (same philosophy as partsMarket / outcomeLearning):
 *  - The engine (everything above the "DATA LAYER" banner) is pure and
 *    deterministic: same input, same answer, no I/O. Every number can be
 *    traced to a factor, and every factor to real records.
 *  - Six factors are combined with a weighted GEOMETRIC mean, so one broken
 *    link (missing parts, uncredentialed technician) drags the whole job down
 *    instead of being averaged away.
 *  - Honest about evidence: a factor with no data is excluded (never guessed),
 *    "estimated" factors count 60% as much as measured ones, and the result is
 *    blended toward the company prior when coverage is low. Below 50% coverage
 *    the engine says "insufficient evidence" rather than promising a number.
 *  - Small samples are shrunk toward a prior (Bayesian-style), so three lucky
 *    jobs never make a technician look perfect. Rework jobs are excluded from
 *    historical rates.
 *  - Hard blockers (blocking compliance gap) cap the probability at 35%.
 *  - The probability is never 100%: the ceiling is 99%.
 *
 * Server counterpart: supabase/migrations/20270105000000_service_outcome_assurance.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type FactorKey = 'parts' | 'technician' | 'history' | 'diagnosis' | 'schedule' | 'context';
export type Evidence = 'measured' | 'estimated' | 'missing';
export type AssuranceStatus = 'assured' | 'watch' | 'intervene' | 'insufficient';
export type DisruptionRisk = 'low' | 'medium' | 'high';
export type InterventionKind =
  | 'resolve_parts'
  | 'reassign_technician'
  | 'assign_technician'
  | 'resolve_compliance'
  | 'expert_assist'
  | 'fix_schedule'
  | 'add_evidence';
export type InterventionSeverity = 'critical' | 'high' | 'medium';

export interface AssuranceJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: string;
  customer_type: 'residential' | 'commercial' | string | null;
  sla_response_hours: number | null;
  is_rework: boolean;
  diagnosis_notes: string | null;
}

export interface AssuranceTechnician {
  id: string;
  name: string;
  skills: string[];
  max_jobs_per_day: number;
  dispatch_enabled: boolean;
}

export interface PartsLine {
  job_id: string;
  part_name: string;
  quantity_required: number;
  shortage_quantity: number;
  readiness_status: string;
}

export interface MissionBriefRow {
  job_id: string;
  /** 0..1 */
  confidence: number;
  risk_flag_count: number;
  predicted_issue: string | null;
}

export interface OutcomeRow {
  job_id: string;
  job_type_key: string;
  resolution: string;
  duration_minutes: number | null;
  is_rework: boolean;
  caused_callback: boolean;
  technician_id: string | null;
}

export interface CredentialRow {
  technician_id: string;
  credential_type: string;
  status: string;
  expires_at: string | null;
}

export interface ComplianceRule {
  service_type: string;
  credential_type: string;
  is_blocking: boolean;
}

/** Learned duration correction from the Continuous Improvement Loop. Only owner-approved, active rows reach the engine. */
export interface DurationCorrectionLite {
  scope: 'job_type' | 'technician';
  job_type_key: string | null;
  technician_id: string | null;
  factor: number;
}

export const CORRECTION_LIMITS = { min: 0.5, max: 2.0 } as const;

/** Combined multiplier for a job: best-matching job-type factor x technician factor, clamped. */
export function correctionFactorFor(
  corrections: DurationCorrectionLite[] | undefined,
  serviceType: string | null | undefined,
  technicianId: string | null | undefined,
): number {
  if (!corrections || corrections.length === 0) return 1;
  const jobType = corrections.find((c) => c.scope === 'job_type' && jobTypeMatches(serviceType, c.job_type_key));
  const tech = technicianId ? corrections.find((c) => c.scope === 'technician' && c.technician_id === technicianId) : undefined;
  const f = (jobType?.factor ?? 1) * (tech?.factor ?? 1);
  return Math.min(CORRECTION_LIMITS.max, Math.max(CORRECTION_LIMITS.min, f));
}
export interface AssuranceContext {
  /** Epoch ms — injected so the engine stays deterministic and testable. */
  now: number;
  jobs: AssuranceJob[];
  technicians: AssuranceTechnician[];
  parts: PartsLine[];
  briefs: MissionBriefRow[];
  outcomes: OutcomeRow[];
  credentials: CredentialRow[];
  rules: ComplianceRule[];
  /** Approved learned corrections (Continuous Improvement Loop). Optional. */
  corrections?: DurationCorrectionLite[];
}

export interface AssuranceSettings {
  assured_threshold: number;
  intervene_below: number;
  notify_on_intervene: boolean;
}

export interface Factor {
  key: FactorKey;
  label: string;
  weight: number;
  /** 0-100, or null when there is no evidence. */
  score: number | null;
  evidence: Evidence;
  detail: string;
  issues: string[];
}

export interface Intervention {
  id: string;
  kind: InterventionKind;
  severity: InterventionSeverity;
  title: string;
  detail: string;
  /** In-app route that resolves the problem. */
  href?: string;
  /** One-click technician swap, only offered when it measurably helps. */
  reassignTo?: { technicianId: string; technicianName: string; expectedProbability: number; gain: number };
}

export interface JobAssurance {
  jobId: string;
  technicianId: string | null;
  /** 0-100, one decimal. */
  probability: number;
  /** 0-100: how much of the model is backed by evidence. */
  coverage: number;
  status: AssuranceStatus;
  expectedResolutionMinutes: number;
  partsReadiness: number | null;
  technicianFit: number | null;
  disruptionRisk: DisruptionRisk;
  factors: Factor[];
  blockers: string[];
  interventions: Intervention[];
}

// ============================================================
// LABELS & CONSTANTS (documented so the model is auditable)
// ============================================================

export const FACTOR_LABELS: Record<FactorKey, string> = {
  parts: 'Parts readiness',
  technician: 'Technician fit',
  history: 'Historical resolution',
  diagnosis: 'Diagnosis confidence',
  schedule: 'Schedule integrity',
  context: 'Job complexity',
};

/** Sum = 100. */
export const FACTOR_WEIGHTS: Record<FactorKey, number> = {
  parts: 26,
  technician: 24,
  history: 16,
  diagnosis: 14,
  schedule: 12,
  context: 8,
};

export const STATUS_LABELS: Record<AssuranceStatus, string> = {
  assured: 'Assured',
  watch: 'Watch',
  intervene: 'Intervene',
  insufficient: 'Not enough evidence',
};

export const STATUS_COLORS: Record<AssuranceStatus, string> = {
  assured: 'bg-success-500/10 text-success-500',
  watch: 'bg-warning-500/10 text-warning-500',
  intervene: 'bg-danger/10 text-danger',
  insufficient: 'bg-bg-tertiary text-text-secondary',
};

export const RISK_LABELS: Record<DisruptionRisk, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const RISK_COLORS: Record<DisruptionRisk, string> = {
  low: 'text-success-500',
  medium: 'text-warning-500',
  high: 'text-danger',
};

export const DEFAULT_SETTINGS: AssuranceSettings = {
  assured_threshold: 85,
  intervene_below: 70,
  notify_on_intervene: true,
};

export const ASSURANCE = {
  /** Company-wide prior for first-visit resolution when there is no history. */
  prior: 0.8,
  /** Pseudo-observations pulling small samples toward the prior. */
  shrinkK: 8,
  ceiling: 0.99,
  probabilityFloor: 0.02,
  /** Per-factor floor inside the geometric mean (avoids ln(0)). */
  factorFloor: 0.05,
  /** Estimated factors count this much compared with measured ones. */
  estimatedWeight: 0.6,
  /** Below this evidence coverage the engine refuses to promise a number. */
  minCoverage: 0.5,
  /** Probability cap when a hard blocker exists. */
  blockerCap: 0.35,
  minTechSample: 3,
  travelBufferMin: 30,
  tightGapMin: 60,
  defaultDurationMin: 90,
  partsDelayPerShortLineMin: 90,
  partsDelayCapMin: 240,
  /** Extra expected on-site time per unit of failure probability (revisit). */
  revisitFactor: 0.6,
  /** Minimum probability gain (points) before a reassignment is suggested. */
  reassignMinGain: 5,
  overdueGraceMin: 15,
} as const;

const EMERGENCY_RE = /emergenc|urgent|no (heat|cool|hot water|power)|burst|flood|leak|gas|carbon monoxide|sparking|sewage/i;

// ============================================================
// SMALL HELPERS
// ============================================================

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

function tokens(s: string | null | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1);
}

/** True when a playbook job-type key and a free-text service type describe the same work. */
export function jobTypeMatches(serviceType: string | null | undefined, jobTypeKey: string | null | undefined): boolean {
  const a = new Set(tokens(serviceType));
  const b = tokens(jobTypeKey);
  if (a.size === 0 || b.length === 0) return false;
  const shared = b.filter((t) => a.has(t)).length;
  if (shared === b.length) return true;
  return shared / new Set([...a, ...b]).size >= 0.6;
}

export function skillMatch(skills: string[], serviceType: string | null | undefined): 'full' | 'partial' | 'none' | 'unknown' {
  if (skills.length === 0 || !serviceType) return 'unknown';
  const svc = new Set(tokens(serviceType));
  let partial = false;
  for (const skill of skills) {
    if (jobTypeMatches(serviceType, skill)) return 'full';
    const st = tokens(skill);
    if (st.some((t) => t.length >= 3 && svc.has(t))) partial = true;
  }
  return partial ? 'partial' : 'none';
}

/** Bayesian-style shrinkage of an observed success rate toward a prior. */
export function shrunkRate(successes: number, n: number, prior: number, k: number = ASSURANCE.shrinkK): number {
  return (successes + prior * k) / (n + k);
}

const isSuccess = (o: OutcomeRow) => o.resolution === 'fixed_first_visit' && !o.caused_callback;

export function companyTypeRate(outcomes: OutcomeRow[], serviceType: string | null): { rate: number; n: number } {
  const rows = outcomes.filter((o) => !o.is_rework && jobTypeMatches(serviceType, o.job_type_key));
  return { rate: shrunkRate(rows.filter(isSuccess).length, rows.length, ASSURANCE.prior), n: rows.length };
}

export function technicianTypeRate(
  outcomes: OutcomeRow[],
  technicianId: string,
  serviceType: string | null,
  fallback: number,
): { rate: number; n: number; scope: 'type' | 'overall' | 'none' } {
  const mine = outcomes.filter((o) => !o.is_rework && o.technician_id === technicianId);
  const ofType = mine.filter((o) => jobTypeMatches(serviceType, o.job_type_key));
  if (ofType.length >= ASSURANCE.minTechSample) {
    return { rate: shrunkRate(ofType.filter(isSuccess).length, ofType.length, fallback), n: ofType.length, scope: 'type' };
  }
  if (mine.length >= ASSURANCE.minTechSample) {
    return { rate: shrunkRate(mine.filter(isSuccess).length, mine.length, fallback), n: mine.length, scope: 'overall' };
  }
  return { rate: fallback, n: mine.length, scope: 'none' };
}

export function typicalDuration(outcomes: OutcomeRow[], serviceType: string | null): number | null {
  const d = outcomes
    .filter((o) => !o.is_rework && o.duration_minutes && o.duration_minutes > 0 && jobTypeMatches(serviceType, o.job_type_key))
    .map((o) => o.duration_minutes as number)
    .sort((a, b) => a - b);
  if (d.length < 3) return null;
  const mid = Math.floor(d.length / 2);
  return d.length % 2 ? d[mid] : Math.round((d[mid - 1] + d[mid]) / 2);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(Math.round((minutes / 60) * 10) / 10).toString()} h`;
}

function startMs(job: AssuranceJob): number | null {
  if (!job.scheduled_datetime) return null;
  const t = new Date(job.scheduled_datetime).getTime();
  return Number.isFinite(t) ? t : null;
}

const ACTIVE_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);
export const EVALUATED_STATUSES = new Set(['scheduled', 'en_route']);

// ============================================================
// FACTORS
// ============================================================

function missing(key: FactorKey, detail: string): Factor {
  return { key, label: FACTOR_LABELS[key], weight: FACTOR_WEIGHTS[key], score: null, evidence: 'missing', detail, issues: [] };
}

function partsFactor(job: AssuranceJob, ctx: AssuranceContext): { factor: Factor; readiness: number | null; shortLines: PartsLine[] } {
  const lines = ctx.parts.filter((p) => p.job_id === job.id);
  if (lines.length === 0) {
    return { factor: missing('parts', 'No required parts recorded for this job.'), readiness: null, shortLines: [] };
  }
  const ready = lines.filter((l) => l.readiness_status === 'ready').length;
  const shortLines = lines.filter((l) => l.readiness_status !== 'ready');
  const readiness = Math.round((ready / lines.length) * 100);
  return {
    readiness,
    shortLines,
    factor: {
      key: 'parts',
      label: FACTOR_LABELS.parts,
      weight: FACTOR_WEIGHTS.parts,
      score: readiness,
      evidence: 'measured',
      detail: `${ready} of ${lines.length} required part${lines.length === 1 ? '' : 's'} available on the assigned van or warehouse.`,
      issues: shortLines.map((l) =>
        l.readiness_status === 'no_location'
          ? `${l.part_name}: not stocked anywhere`
          : `${l.part_name}: short by ${l.shortage_quantity}`,
      ),
    },
  };
}

function credentialGaps(tech: AssuranceTechnician, job: AssuranceJob, ctx: AssuranceContext): string[] {
  const svc = (job.service_type ?? '').trim().toLowerCase();
  if (!svc) return [];
  const gaps: string[] = [];
  for (const rule of ctx.rules) {
    if (!rule.is_blocking || rule.service_type.trim().toLowerCase() !== svc) continue;
    const ok = ctx.credentials.some(
      (c) =>
        c.technician_id === tech.id &&
        c.credential_type === rule.credential_type &&
        c.status === 'active' &&
        (!c.expires_at || new Date(c.expires_at).getTime() > ctx.now),
    );
    if (!ok) gaps.push(rule.credential_type);
  }
  return gaps;
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function technicianFactor(
  job: AssuranceJob,
  tech: AssuranceTechnician | null,
  ctx: AssuranceContext,
  companyRate: number,
): { factor: Factor; fit: number | null; gaps: string[] } {
  if (!tech) {
    return {
      fit: null,
      gaps: [],
      factor: {
        key: 'technician',
        label: FACTOR_LABELS.technician,
        weight: FACTOR_WEIGHTS.technician,
        score: 40,
        evidence: 'estimated',
        detail: 'No technician assigned yet.',
        issues: ['No technician assigned'],
      },
    };
  }

  const issues: string[] = [];
  const match = skillMatch(tech.skills, job.service_type);
  const skillScore = { full: 100, partial: 70, none: 30, unknown: 65 }[match];
  if (match === 'none') issues.push(`${tech.name} has no listed skill for "${job.service_type ?? 'this job'}"`);
  if (match === 'partial') issues.push('Skills only partially match this service type');

  const hist = technicianTypeRate(ctx.outcomes, tech.id, job.service_type, companyRate);
  const histScore = hist.rate * 100;
  if (hist.scope !== 'none' && hist.rate < ASSURANCE.prior - 0.1) {
    issues.push(`First-visit fix rate ${Math.round(hist.rate * 100)}% on ${hist.scope === 'type' ? 'this job type' : 'recent jobs'}`);
  }

  const start = startMs(job);
  let capScore = 100;
  if (start !== null) {
    const dayJobs = ctx.jobs.filter((j) => {
      if (j.assigned_technician_id !== tech.id || !ACTIVE_STATUSES.has(j.job_status)) return false;
      const s = startMs(j);
      return s !== null && sameLocalDay(s, start);
    }).length;
    const max = Math.max(1, tech.max_jobs_per_day || 1);
    if (dayJobs > max) {
      capScore = 40;
      issues.push(`${tech.name} is over capacity that day (${dayJobs}/${max} jobs)`);
    } else if (dayJobs === max) {
      capScore = 80;
    }
  }

  let score = 0.35 * skillScore + 0.4 * histScore + 0.25 * capScore;
  const gaps = credentialGaps(tech, job, ctx);
  if (gaps.length > 0) {
    score = Math.min(score, 20);
    issues.unshift(`Missing required credential: ${gaps.join(', ')}`);
  }

  const measured = match !== 'unknown' && hist.scope !== 'none';
  return {
    gaps,
    fit: Math.round(clamp(score, 0, 100)),
    factor: {
      key: 'technician',
      label: FACTOR_LABELS.technician,
      weight: FACTOR_WEIGHTS.technician,
      score: Math.round(clamp(score, 0, 100)),
      evidence: measured ? 'measured' : 'estimated',
      detail:
        hist.scope === 'none'
          ? `${tech.name}: no completed-job history yet, using the company baseline.`
          : `${tech.name}: ${hist.n} past ${hist.scope === 'type' ? 'jobs of this type' : 'jobs'}, ${Math.round(hist.rate * 100)}% fixed on the first visit.`,
      issues,
    },
  };
}

function historyFactor(job: AssuranceJob, ctx: AssuranceContext): { factor: Factor; rate: number } {
  const { rate, n } = companyTypeRate(ctx.outcomes, job.service_type);
  if (n === 0) return { rate: ASSURANCE.prior, factor: missing('history', 'No completed jobs of this type on record yet.') };
  return {
    rate,
    factor: {
      key: 'history',
      label: FACTOR_LABELS.history,
      weight: FACTOR_WEIGHTS.history,
      score: Math.round(rate * 100),
      evidence: n >= 5 ? 'measured' : 'estimated',
      detail: `${n} similar completed job${n === 1 ? '' : 's'}; ${Math.round(rate * 100)}% resolved on the first visit (small samples are pulled toward the ${Math.round(ASSURANCE.prior * 100)}% baseline).`,
      issues: [],
    },
  };
}

function diagnosisFactor(job: AssuranceJob, ctx: AssuranceContext): Factor {
  const brief = ctx.briefs.find((b) => b.job_id === job.id);
  if (brief) {
    const base = clamp(brief.confidence, 0, 1) * 100;
    const penalty = Math.min(12, brief.risk_flag_count * 4);
    const score = Math.round(clamp(base - penalty, 0, 100));
    return {
      key: 'diagnosis',
      label: FACTOR_LABELS.diagnosis,
      weight: FACTOR_WEIGHTS.diagnosis,
      score,
      evidence: 'measured',
      detail: `AI mission brief predicts "${brief.predicted_issue ?? 'issue'}" at ${Math.round(base)}% confidence${brief.risk_flag_count ? `, ${brief.risk_flag_count} risk flag${brief.risk_flag_count === 1 ? '' : 's'}` : ''}.`,
      issues: score < 60 ? ['Diagnosis confidence is low'] : [],
    };
  }
  if (job.diagnosis_notes && job.diagnosis_notes.trim().length > 10) {
    return {
      key: 'diagnosis',
      label: FACTOR_LABELS.diagnosis,
      weight: FACTOR_WEIGHTS.diagnosis,
      score: 55,
      evidence: 'estimated',
      detail: 'Diagnosis notes exist but no AI mission brief has scored them.',
      issues: [],
    };
  }
  return missing('diagnosis', 'No mission brief or diagnosis notes for this job.');
}

function scheduleFactor(job: AssuranceJob, tech: AssuranceTechnician | null, ctx: AssuranceContext): Factor {
  const start = startMs(job);
  if (start === null) return missing('schedule', 'No scheduled time set.');
  const issues: string[] = [];
  let score = 100;

  if (job.job_status === 'scheduled' && start < ctx.now - ASSURANCE.overdueGraceMin * 60000) {
    score = 30;
    issues.push('Scheduled time has already passed');
  }

  if (tech) {
    const myEnd = start + (job.duration_minutes ?? ASSURANCE.defaultDurationMin) * 60000;
    let minGap = Infinity;
    for (const o of ctx.jobs) {
      if (o.id === job.id || o.assigned_technician_id !== tech.id || !ACTIVE_STATUSES.has(o.job_status)) continue;
      const os = startMs(o);
      if (os === null) continue;
      const oe = os + (o.duration_minutes ?? ASSURANCE.defaultDurationMin) * 60000;
      minGap = Math.min(minGap, Math.max(os - myEnd, start - oe) / 60000);
    }
    if (minGap < 0) {
      score = Math.min(score, 25);
      issues.push(`${tech.name} has an overlapping job`);
    } else if (minGap < ASSURANCE.travelBufferMin) {
      score = Math.min(score, 55);
      issues.push('Less than 30 minutes of travel time between jobs');
    } else if (minGap < ASSURANCE.tightGapMin) {
      score = Math.min(score, 75);
    }
  }

  return {
    key: 'schedule',
    label: FACTOR_LABELS.schedule,
    weight: FACTOR_WEIGHTS.schedule,
    score,
    evidence: 'measured',
    detail: issues.length ? issues[0] : 'No conflicts with the technician’s other jobs.',
    issues,
  };
}

function isEmergency(job: AssuranceJob): boolean {
  return EMERGENCY_RE.test(job.service_type ?? '');
}

function slaTight(job: AssuranceJob): boolean {
  return job.sla_response_hours !== null && job.sla_response_hours <= 4;
}

function contextFactor(job: AssuranceJob): Factor {
  const issues: string[] = [];
  let score = 100;
  if (job.is_rework) {
    score -= 35;
    issues.push('This is a rework visit');
  }
  if (isEmergency(job)) {
    score -= 10;
    issues.push('Emergency-type service');
  }
  if (slaTight(job)) {
    score -= 8;
    issues.push(`Tight SLA (${job.sla_response_hours}h)`);
  }
  return {
    key: 'context',
    label: FACTOR_LABELS.context,
    weight: FACTOR_WEIGHTS.context,
    score,
    evidence: 'measured',
    detail: issues.length ? issues.join('; ') : 'Routine job with no complexity flags.',
    issues,
  };
}

/** 0-100: how costly a failed visit would be for this customer. */
function customerCriticality(job: AssuranceJob): number {
  let c = 0;
  if (job.is_rework) c += 30;
  if (isEmergency(job)) c += 25;
  if (job.customer_type === 'commercial') c += 10;
  if (job.sla_response_hours !== null) {
    if (job.sla_response_hours <= 2) c += 30;
    else if (job.sla_response_hours <= 4) c += 20;
    else if (job.sla_response_hours <= 8) c += 10;
  }
  return Math.min(100, c);
}

// ============================================================
// COMBINATION
// ============================================================

export function combineFactors(factors: Factor[]): { probability: number; coverage: number } {
  let wSum = 0;
  let logSum = 0;
  for (const f of factors) {
    if (f.score === null) continue;
    const w = f.weight * (f.evidence === 'measured' ? 1 : ASSURANCE.estimatedWeight);
    wSum += w;
    logSum += w * Math.log(Math.max(ASSURANCE.factorFloor, f.score / 100));
  }
  const coverage = clamp(wSum / 100, 0, 1);
  if (wSum === 0) return { probability: ASSURANCE.prior, coverage: 0 };
  const geo = Math.exp(logSum / wSum);
  const blended = coverage * geo + (1 - coverage) * ASSURANCE.prior;
  return { probability: clamp(blended, ASSURANCE.probabilityFloor, ASSURANCE.ceiling), coverage };
}

/** `probabilityPct` and `coverage` are both on a 0-100 scale. */
export function statusFor(probabilityPct: number, coverage: number, hasBlocker: boolean, settings: AssuranceSettings): AssuranceStatus {
  if (hasBlocker) return 'intervene';
  if (coverage < ASSURANCE.minCoverage * 100) return 'insufficient';
  if (probabilityPct >= settings.assured_threshold) return 'assured';
  if (probabilityPct >= settings.intervene_below) return 'watch';
  return 'intervene';
}

// ============================================================
// EVALUATION
// ============================================================

interface EvalOptions {
  /** Evaluate as if this technician (or none) were assigned. */
  technicianId?: string | null;
  skipInterventions?: boolean;
}

export function evaluateJob(
  job: AssuranceJob,
  ctx: AssuranceContext,
  settings: AssuranceSettings = DEFAULT_SETTINGS,
  opts: EvalOptions = {},
): JobAssurance {
  const techId = opts.technicianId !== undefined ? opts.technicianId : job.assigned_technician_id;
  const tech = techId ? ctx.technicians.find((t) => t.id === techId) ?? null : null;
  const effectiveJob: AssuranceJob = techId === job.assigned_technician_id ? job : { ...job, assigned_technician_id: techId };

  const parts = partsFactor(effectiveJob, ctx);
  const history = historyFactor(effectiveJob, ctx);
  const technician = technicianFactor(effectiveJob, tech, ctx, history.rate);
  const diagnosis = diagnosisFactor(effectiveJob, ctx);
  const schedule = scheduleFactor(effectiveJob, tech, ctx);
  const context = contextFactor(effectiveJob);

  const factors = [parts.factor, technician.factor, history.factor, diagnosis, schedule, context];
  const blockers: string[] = technician.gaps.map((g) => `Missing blocking credential: ${g}`);

  const combined = combineFactors(factors);
  let p = combined.probability;
  if (blockers.length > 0) p = Math.min(p, ASSURANCE.blockerCap);
  const probability = round1(p * 100);
  const coverage = round1(combined.coverage * 100);
  const status = statusFor(probability, coverage, blockers.length > 0, settings);

  const base = effectiveJob.duration_minutes ?? typicalDuration(ctx.outcomes, effectiveJob.service_type) ?? ASSURANCE.defaultDurationMin;
  const partsDelay = Math.min(ASSURANCE.partsDelayCapMin, parts.shortLines.length * ASSURANCE.partsDelayPerShortLineMin);
    const rawExpectedMinutes = base * (1 + (1 - p) * ASSURANCE.revisitFactor) + partsDelay;
  const expectedResolutionMinutes = Math.round(rawExpectedMinutes * correctionFactorFor(ctx.corrections, effectiveJob.service_type, techId));

  const criticality = customerCriticality(effectiveJob);
  const risk = criticality * 0.6 + (1 - p) * 100 * 0.4;
  const disruptionRisk: DisruptionRisk = risk < 25 ? 'low' : risk < 50 ? 'medium' : 'high';

  const result: JobAssurance = {
    jobId: job.id,
    technicianId: techId,
    probability,
    coverage,
    status,
    expectedResolutionMinutes,
    partsReadiness: parts.readiness,
    technicianFit: technician.fit,
    disruptionRisk,
    factors,
    blockers,
    interventions: [],
  };

  if (!opts.skipInterventions && status !== 'assured') {
    result.interventions = buildInterventions(job, ctx, settings, result, parts.shortLines);
  }
  return result;
}

function buildInterventions(
  job: AssuranceJob,
  ctx: AssuranceContext,
  settings: AssuranceSettings,
  current: JobAssurance,
  shortLines: PartsLine[],
): Intervention[] {
  const out: Intervention[] = [];
  const start = startMs(job);
  const within24h = start !== null && start - ctx.now < 24 * 3600000;
  const f = (k: FactorKey) => current.factors.find((x) => x.key === k) as Factor;

  // Best alternative technician — only when it measurably helps and has no blocker.
  let best: { id: string; name: string; probability: number } | null = null;
  for (const t of ctx.technicians) {
    if (!t.dispatch_enabled || t.id === job.assigned_technician_id) continue;
    const alt = evaluateJob(job, ctx, settings, { technicianId: t.id, skipInterventions: true });
    if (alt.blockers.length > 0) continue;
    if (!best || alt.probability > best.probability) best = { id: t.id, name: t.name, probability: alt.probability };
  }
  const gain = best ? round1(best.probability - current.probability) : 0;
  const reassignTo =
    best && gain >= ASSURANCE.reassignMinGain
      ? { technicianId: best.id, technicianName: best.name, expectedProbability: best.probability, gain }
      : undefined;

  if (current.blockers.length > 0) {
    out.push({
      id: 'resolve_compliance',
      kind: 'resolve_compliance',
      severity: 'critical',
      title: 'Technician cannot legally take this job',
      detail: `${current.blockers.join('; ')}. Renew the credential or swap the technician before dispatch.`,
      href: '/dashboard/compliance',
      reassignTo,
    });
  }

  if (shortLines.length > 0) {
    out.push({
      id: 'resolve_parts',
      kind: 'resolve_parts',
      severity: within24h ? 'critical' : 'high',
      title: `Secure ${shortLines.length} missing part${shortLines.length === 1 ? '' : 's'} before dispatch`,
      detail: `${f('parts').issues.join('; ')}. Compare van, warehouse, vendor and nearby-contractor options in the Parts Market.`,
      href: '/dashboard/parts-market',
    });
  }

  const techScore = f('technician').score ?? 100;
  if (!job.assigned_technician_id) {
    out.push({
      id: 'assign_technician',
      kind: 'assign_technician',
      severity: within24h ? 'critical' : 'high',
      title: 'Assign a technician',
      detail: reassignTo
        ? `${reassignTo.technicianName} would give an estimated ${Math.round(reassignTo.expectedProbability)}% success probability.`
        : 'No technician is assigned, so fit cannot be measured.',
      href: '/dashboard/dispatch',
      reassignTo,
    });
  } else if (techScore < 70 && current.blockers.length === 0) {
    out.push({
      id: 'reassign_technician',
      kind: 'reassign_technician',
      severity: techScore < 50 ? 'high' : 'medium',
      title: reassignTo ? `Reassign to ${reassignTo.technicianName} (+${Math.round(reassignTo.gain)} pts)` : 'Technician fit is weak',
      detail: reassignTo
        ? `${f('technician').issues.join('; ') || 'Better skills, history or capacity'}. Parts availability is re-checked against the new technician's van after the swap.`
        : `${f('technician').issues.join('; ') || 'Technician fit is below target'}. No available technician scores meaningfully higher.`,
      href: '/dashboard/dispatch',
      reassignTo,
    });
  }

  const dx = f('diagnosis');
  if (dx.score !== null && dx.score < 60) {
    out.push({
      id: 'expert_assist',
      kind: 'expert_assist',
      severity: 'high',
      title: 'Get a remote expert to confirm the diagnosis',
      detail: 'Diagnosis confidence is low. A second opinion before dispatch avoids a wasted visit.',
      href: '/dashboard/expert-assist',
    });
  }

  const sc = f('schedule');
  if (sc.score !== null && sc.score < 70) {
    out.push({
      id: 'fix_schedule',
      kind: 'fix_schedule',
      severity: sc.score < 40 ? 'high' : 'medium',
      title: 'Fix the schedule conflict',
      detail: `${sc.issues.join('; ')}. Move the job or the neighbouring one on the dispatch board.`,
      href: '/dashboard/dispatch',
    });
  }

  if (current.status === 'insufficient') {
    const gaps = current.factors.filter((x) => x.evidence === 'missing').map((x) => x.label.toLowerCase());
    if (gaps.length) {
      out.push({
        id: 'add_evidence',
        kind: 'add_evidence',
        severity: 'medium',
        title: 'Add the missing evidence',
        detail: `Not enough data to promise an outcome. Missing: ${gaps.join(', ')}. Record required parts on the job and generate its mission brief.`,
        href: '/dashboard/jobs',
      });
    }
  }

  const order: Record<InterventionSeverity, number> = { critical: 0, high: 1, medium: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function evaluateAll(ctx: AssuranceContext, settings: AssuranceSettings = DEFAULT_SETTINGS): Array<{ job: AssuranceJob; result: JobAssurance }> {
  return ctx.jobs
    .filter((j) => EVALUATED_STATUSES.has(j.job_status))
    .map((job) => ({ job, result: evaluateJob(job, ctx, settings) }))
    .sort((a, b) => {
      const rank: Record<AssuranceStatus, number> = { intervene: 0, watch: 1, insufficient: 2, assured: 3 };
      if (rank[a.result.status] !== rank[b.result.status]) return rank[a.result.status] - rank[b.result.status];
      const ta = startMs(a.job) ?? Infinity;
      const tb = startMs(b.job) ?? Infinity;
      return ta - tb;
    });
}

export interface AssuranceSummary {
  total: number;
  assured: number;
  watch: number;
  intervene: number;
  insufficient: number;
  avgProbability: number | null;
}

export function summarizeAssurance(rows: JobAssurance[]): AssuranceSummary {
  const scored = rows.filter((r) => r.status !== 'insufficient');
  return {
    total: rows.length,
    assured: rows.filter((r) => r.status === 'assured').length,
    watch: rows.filter((r) => r.status === 'watch').length,
    intervene: rows.filter((r) => r.status === 'intervene').length,
    insufficient: rows.filter((r) => r.status === 'insufficient').length,
    avgProbability: scored.length ? round1(scored.reduce((s, r) => s + r.probability, 0) / scored.length) : null,
  };
}

// ============================================================
// CALIBRATION — "when Vireek said 90%, how often was it right?"
// ============================================================

export interface SnapshotRow {
  job_id: string;
  probability: number;
  status: AssuranceStatus;
  created_at: string;
}

export interface CalibrationBucket {
  label: string;
  n: number;
  predicted: number;
  actual: number;
}

export interface Calibration {
  n: number;
  brier: number | null;
  buckets: CalibrationBucket[];
}

/** Uses the last prediction made before the job's outcome was recorded. */
export function computeCalibration(snapshots: SnapshotRow[], outcomes: OutcomeRow[]): Calibration {
  const latest = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    const prev = latest.get(s.job_id);
    if (!prev || s.created_at > prev.created_at) latest.set(s.job_id, s);
  }
  const pairs: Array<{ p: number; y: number }> = [];
  for (const o of outcomes) {
    if (o.is_rework) continue;
    const s = latest.get(o.job_id);
    if (!s) continue;
    pairs.push({ p: s.probability / 100, y: isSuccess(o) ? 1 : 0 });
  }
  const defs: Array<[string, number, number]> = [
    ['90%+', 0.9, 1.01],
    ['80-89%', 0.8, 0.9],
    ['70-79%', 0.7, 0.8],
    ['Below 70%', 0, 0.7],
  ];
  const buckets: CalibrationBucket[] = defs
    .map(([label, lo, hi]) => {
      const rows = pairs.filter((x) => x.p >= lo && x.p < hi);
      return {
        label,
        n: rows.length,
        predicted: rows.length ? round1((rows.reduce((s, x) => s + x.p, 0) / rows.length) * 100) : 0,
        actual: rows.length ? round1((rows.reduce((s, x) => s + x.y, 0) / rows.length) * 100) : 0,
      };
    })
    .filter((b) => b.n > 0);
  const brier = pairs.length ? Math.round((pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / pairs.length) * 1000) / 1000 : null;
  return { n: pairs.length, brier, buckets };
}

// ============================================================
// DATA LAYER
// ============================================================

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function currentUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  return user.id;
}

/** Optional data sources fail soft: a missing module lowers coverage instead of breaking the page. */
async function soft<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await p;
    if (error) return [];
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

export async function gatherAssuranceContext(): Promise<AssuranceContext> {
  const now = Date.now();
  const since = new Date(now - 7 * 86400000).toISOString();

  const [jobsRes, teamRes] = await Promise.all([
    supabase
      .from('jobs')
      .select(
        'id, customer_name, service_type, scheduled_datetime, duration_minutes, assigned_technician_id, job_status, customer_type, sla_response_hours, is_rework, diagnosis_notes',
      )
      .in('job_status', ['scheduled', 'en_route', 'in_progress'])
      .or(`scheduled_datetime.is.null,scheduled_datetime.gte.${since}`)
      .order('scheduled_datetime', { ascending: true, nullsFirst: false })
      .limit(300),
    supabase
      .from('team_members')
      .select('id, member_name, member_email, role, skills, max_jobs_per_day, dispatch_enabled, invite_status')
      .eq('invite_status', 'active'),
  ]);
  if (jobsRes.error) throw jobsRes.error;
  if (teamRes.error) throw teamRes.error;

  const jobs = ((jobsRes.data ?? []) as Array<Record<string, unknown>>).map(
    (j): AssuranceJob => ({
      id: String(j.id),
      customer_name: String(j.customer_name ?? ''),
      service_type: (j.service_type as string | null) ?? null,
      scheduled_datetime: (j.scheduled_datetime as string | null) ?? null,
      duration_minutes: typeof j.duration_minutes === 'number' ? j.duration_minutes : null,
      assigned_technician_id: (j.assigned_technician_id as string | null) ?? null,
      job_status: String(j.job_status),
      customer_type: (j.customer_type as string | null) ?? null,
      sla_response_hours: typeof j.sla_response_hours === 'number' ? j.sla_response_hours : null,
      is_rework: Boolean(j.is_rework),
      diagnosis_notes: (j.diagnosis_notes as string | null) ?? null,
    }),
  );

  const technicians = ((teamRes.data ?? []) as Array<Record<string, unknown>>).map(
    (m): AssuranceTechnician => ({
      id: String(m.id),
      name: (m.member_name as string | null) || (m.member_email as string | null) || 'Technician',
      skills: Array.isArray(m.skills) ? (m.skills as string[]) : [],
      max_jobs_per_day: typeof m.max_jobs_per_day === 'number' && m.max_jobs_per_day > 0 ? m.max_jobs_per_day : 6,
      dispatch_enabled: m.dispatch_enabled !== false && (m.role === 'technician' || m.dispatch_enabled === true),
    }),
  );

  const ids = jobs.filter((j) => EVALUATED_STATUSES.has(j.job_status)).map((j) => j.id);
  const groups = chunk(ids, 60);

  const [partsG, briefsG, outcomes, credentials, rules] = await Promise.all([
    Promise.all(
      groups.map((g) =>
        soft<PartsLine>(
          supabase.from('job_parts_readiness').select('job_id, part_name, quantity_required, shortage_quantity, readiness_status').in('job_id', g),
        ),
      ),
    ),
    Promise.all(
      groups.map((g) =>
        soft<Record<string, unknown>>(
          supabase.from('job_mission_briefs').select('job_id, confidence, risk_flags, predicted_issue').in('job_id', g),
        ),
      ),
    ),
    soft<OutcomeRow>(
      supabase
        .from('job_outcomes')
        .select('job_id, job_type_key, resolution, duration_minutes, is_rework, caused_callback, technician_id')
        .order('recorded_at', { ascending: false })
        .limit(1500),
    ),
    soft<CredentialRow>(supabase.from('technician_credentials').select('technician_id, credential_type, status, expires_at')),
    soft<ComplianceRule>(supabase.from('compliance_requirements').select('service_type, credential_type, is_blocking')),
  ]);

  const corrections = (
    await soft<DurationCorrectionLite>(
      supabase.from('improvement_corrections').select('scope, job_type_key, technician_id, factor').eq('status', 'active'),
    )
  )
    .map((c) => ({ ...c, factor: Number(c.factor) }))
    .filter((c) => Number.isFinite(c.factor));
  return {
    now,
    jobs,
    technicians,
    parts: partsG.flat(),
    briefs: briefsG.flat().map(
      (b): MissionBriefRow => ({
        job_id: String(b.job_id),
        confidence: Number(b.confidence ?? 0),
        risk_flag_count: Array.isArray(b.risk_flags) ? b.risk_flags.length : 0,
        predicted_issue: (b.predicted_issue as string | null) ?? null,
      }),
    ),
    outcomes,
    credentials,
    rules,
  };
}

export async function fetchAssuranceSettings(): Promise<AssuranceSettings> {
  try {
    const { data, error } = await supabase
      .from('outcome_assurance_settings')
      .select('assured_threshold, intervene_below, notify_on_intervene')
      .maybeSingle();
    if (error || !data) return DEFAULT_SETTINGS;
    return data as AssuranceSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveAssuranceSettings(s: AssuranceSettings): Promise<void> {
  const { error } = await supabase.rpc('save_outcome_assurance_settings', {
    p_assured_threshold: s.assured_threshold,
    p_intervene_below: s.intervene_below,
    p_notify_on_intervene: s.notify_on_intervene,
  });
  if (error) throw error;
}

/** Writes history + fires the automatic "job at risk" alert (deduplicated server-side). */
export async function persistSnapshots(results: JobAssurance[]): Promise<number> {
  if (results.length === 0) return 0;
  let written = 0;
  for (const part of chunk(results, 200)) {
    const { data, error } = await supabase.rpc('record_assurance_snapshots', {
      p_items: part.map((r) => ({
        job_id: r.jobId,
        technician_id: r.technicianId,
        probability: r.probability,
        status: r.status,
        coverage: r.coverage,
        expected_minutes: r.expectedResolutionMinutes,
        parts_readiness: r.partsReadiness,
        technician_fit: r.technicianFit,
        disruption_risk: r.disruptionRisk,
        factors: r.factors.map((f) => ({ key: f.key, weight: f.weight, score: f.score, evidence: f.evidence })),
      })),
    });
    if (error) throw error;
    written += typeof data === 'number' ? data : 0;
  }
  return written;
}

export async function fetchLatestSnapshots(limit = 1500): Promise<SnapshotRow[]> {
  return soft<SnapshotRow>(
    supabase
      .from('job_assurance_snapshots')
      .select('job_id, probability, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

export interface InterventionRow {
  id: string;
  job_id: string;
  kind: string;
  title: string;
  outcome: 'applied' | 'dismissed';
  probability_before: number | null;
  probability_after: number | null;
  created_at: string;
}

export async function fetchRecentInterventions(limit = 8): Promise<InterventionRow[]> {
  return soft<InterventionRow>(
    supabase
      .from('job_assurance_interventions')
      .select('id, job_id, kind, title, outcome, probability_before, probability_after, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

export async function recordIntervention(params: {
  jobId: string;
  intervention: Intervention;
  outcome: 'applied' | 'dismissed';
  probabilityBefore: number;
  probabilityAfter?: number | null;
  technicianFrom?: string | null;
  technicianTo?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('record_assurance_intervention', {
    p_job_id: params.jobId,
    p_kind: params.intervention.kind,
    p_title: params.intervention.title,
    p_detail: params.intervention.detail,
    p_outcome: params.outcome,
    p_probability_before: params.probabilityBefore,
    p_probability_after: params.probabilityAfter ?? null,
    p_technician_from: params.technicianFrom ?? null,
    p_technician_to: params.technicianTo ?? null,
  });
  if (error) throw error;
}

/** One-click technician swap. Guarded so a job that changed meanwhile is never overwritten. */
export async function applyReassignment(job: AssuranceJob, result: JobAssurance, intervention: Intervention): Promise<void> {
  const target = intervention.reassignTo;
  if (!target) throw new Error('No reassignment available');
  await currentUserId();
  let q = supabase.from('jobs').update({ assigned_technician_id: target.technicianId }).eq('id', job.id);
  q = job.assigned_technician_id ? q.eq('assigned_technician_id', job.assigned_technician_id) : q.is('assigned_technician_id', null);
  const { data, error } = await q.select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This job was changed by someone else. Refresh and try again.');
  await recordIntervention({
    jobId: job.id,
    intervention,
    outcome: 'applied',
    probabilityBefore: result.probability,
    probabilityAfter: target.expectedProbability,
    technicianFrom: job.assigned_technician_id,
    technicianTo: target.technicianId,
  });
}
