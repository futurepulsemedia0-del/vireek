/**
 * Vireek First-Time-Fix Autopilot - prediction engine (pure, no I/O).
 *
 * Predicts, BEFORE dispatch, the probability that a job is fixed on the first
 * visit, explains every point of that number, ranks technicians, and plans the
 * cheapest set of corrections that lifts the probability.
 *
 * Model: a transparent log-odds model (the same explainable, no-LLM pattern as
 * technicianSkillGraph.ts). Start from a smoothed prior (fleet history for this
 * service type, shrunk toward the trade benchmark), then add one bounded
 * log-odds adjustment per factor. Every factor reports its own impact in points
 * (leave-one-out), a status, and whether it was based on real data.
 *
 * Factors: skill, parts, diagnosis, duration, equipment history, special tools.
 */

import type { Job, TeamMember } from '@/lib/supabase';
import type { SkillGraph, SkillNode } from '@/lib/technicianSkillGraph';
import type { JobPartSourcing, StockFitRow } from '@/lib/truckStock';
import { TRADE_PLAYBOOKS, matchJobType, type TradeJobType } from '@/lib/tradePlaybookCatalog';

// ============================================================
// TYPES
// ============================================================

export const MODEL_VERSION = 1;
export const DEFAULT_THRESHOLD = 75;
export const HOLD_MARGIN = 15;

export type FactorKey = 'skill' | 'parts' | 'diagnosis' | 'duration' | 'equipment' | 'tools';
export type FactorStatus = 'good' | 'watch' | 'risk' | 'unknown';
export type Verdict = 'go' | 'review' | 'hold';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type Enforcement = 'off' | 'warn' | 'hold';

export interface FactorResult {
  key: FactorKey;
  label: string;
  status: FactorStatus;
  /** Log-odds adjustment applied to the prior. */
  logit: number;
  /** Leave-one-out effect on the final probability, in percentage points. */
  impactPts: number;
  hasData: boolean;
  detail: string;
}

export interface Prediction {
  probability: number; // 3-97
  low: number;
  high: number;
  verdict: Verdict;
  confidence: ConfidenceLevel;
  priorProbability: number;
  priorSample: number;
  priorSource: 'history' | 'benchmark' | 'default';
  expectedMinutes: number | null;
  factors: FactorResult[];
}

export interface Prior {
  p: number; // 0-1
  n: number;
  source: 'history' | 'benchmark' | 'default';
  expectedMinutes: number | null;
}

export interface PartsSignal {
  required: number;
  onVan: number;
  needsOrder: number;
  awaitingDelivery: number;
}
export interface DiagnosisSignal {
  confidence: number | null; // 0-1 from Diagnosis Copilot
  documented: boolean;
}
export interface EquipmentHistory {
  linked: boolean;
  priorReworks: number;
  recurrentSameService: boolean;
  pastLifespan: boolean;
}
export interface ToolsSignal {
  required: string[];
  held: string[];
}

export interface Scenario {
  technicianId: string | null;
  skill: SkillNode | null;
  skillListed: boolean;
  bookedMinutes: number | null;
  parts: PartsSignal | null;
  diagnosis: DiagnosisSignal;
  equipment: EquipmentHistory;
  tools: ToolsSignal;
  isDiagnosticJob: boolean;
  prior: Prior;
}

export interface EquipmentRow {
  id: string;
  install_date: string | null;
  expected_lifespan_years: number | null;
  status: string;
}
export interface DiagnosisRow {
  job_id: string;
  confidence: number | null;
  created_at: string;
}
export interface JobEquipmentLink {
  job_id: string;
  equipment_id: string;
}
export interface ToolRequirementRow {
  service_type: string;
  tool_name: string;
}
export interface TechnicianToolRow {
  team_member_id: string;
  tool_name: string;
}

export interface AutopilotData {
  jobs: Job[];
  technicians: TeamMember[];
  graph: SkillGraph;
  stockFit: Record<string, Record<string, StockFitRow>>;
  sourcing: JobPartSourcing[];
  diagnoses: DiagnosisRow[];
  jobEquipment: JobEquipmentLink[];
  equipment: EquipmentRow[];
  toolRequirements: ToolRequirementRow[];
  technicianTools: TechnicianToolRow[];
  now: Date;
}

export interface JobContext {
  job: Job;
  prior: Prior;
  isDiagnosticJob: boolean;
  diagnosis: DiagnosisSignal;
  equipment: EquipmentHistory;
  sourcing: { needsOrder: number; awaitingDelivery: number };
  stockFit: Record<string, StockFitRow>;
  toolsRequired: string[];
  toolsHeld: Record<string, string[]>;
  skillNodes: Record<string, SkillNode | undefined>;
  technicians: TeamMember[];
  /** Same-day job count per technician, used for capacity. */
  dayLoad: Record<string, number>;
}

export interface Options {
  threshold?: number;
}

export interface TechnicianRanking {
  technician: TeamMember;
  prediction: Prediction;
  atCapacity: boolean;
  load: number;
  capacity: number;
}

export type ActionKind = 'reassign' | 'extend_duration' | 'restock' | 'order' | 'diagnose' | 'equip';

export interface AutofixStep {
  kind: ActionKind;
  title: string;
  detail: string;
  upliftPts: number;
  projectedProbability: number;
  /** Set for steps Vireek can apply in one click. */
  technicianId?: string;
  minutes?: number;
  /** True when dispatch should wait until the step is done (e.g. parts must be ordered). */
  blocking: boolean;
}

export interface AutofixPlan {
  startProbability: number;
  finalProbability: number;
  reachesThreshold: boolean;
  steps: AutofixStep[];
}

// ============================================================
// MATH HELPERS
// ============================================================

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const logit = (p: number) => Math.log(clamp(p, 0.001, 0.999) / (1 - clamp(p, 0.001, 0.999)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const roundUp15 = (m: number) => Math.ceil(m / 15) * 15;
const norm = (s: string) => s.trim().toLowerCase();

const PRIOR_STRENGTH = 8; // pseudo-jobs of benchmark evidence
const TECH_STRENGTH = 4; // pseudo-jobs of fleet evidence when scoring one technician
const HORIZON_DAYS = 365;

const WEIGHTS: Record<FactorKey, number> = {
  skill: 0.25,
  parts: 0.25,
  diagnosis: 0.2,
  duration: 0.1,
  equipment: 0.1,
  tools: 0.1,
};

const LABELS: Record<FactorKey, string> = {
  skill: 'Technician skill fit',
  parts: 'Parts on the truck',
  diagnosis: 'Diagnosis confidence',
  duration: 'Time booked',
  equipment: 'Equipment history',
  tools: 'Special tools',
};

const DIAGNOSTIC_RE = /repair|leak|no (heat|cool|hot|power|water)|not (working|heating|cooling)|fault|broken|emergency|diagnos|trip|clog|burst/i;

// ============================================================
// PRIOR (fleet history shrunk toward trade benchmark)
// ============================================================

export function findJobType(serviceType: string | null | undefined): TradeJobType | undefined {
  for (const pb of TRADE_PLAYBOOKS) {
    const jt = matchJobType(pb, serviceType);
    if (jt) return jt;
  }
  return undefined;
}

function actualMinutes(j: Job): number | null {
  if (j.completed_at && j.scheduled_datetime) {
    const m = (new Date(j.completed_at).getTime() - new Date(j.scheduled_datetime).getTime()) / 60000;
    if (m >= 10 && m <= 720) return m;
  }
  return j.duration_minutes ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function buildPrior(allJobs: Job[], serviceType: string | null, now: Date): Prior {
  const jt = findJobType(serviceType);
  const benchP = jt ? jt.benchmark.firstTimeFixPct / 100 : 0.8;
  const benchMinutes = jt ? jt.benchmark.durationMinutes : null;
  const start = now.getTime() - HORIZON_DAYS * 86400000;
  const key = serviceType ? norm(serviceType) : null;

  const reworked = new Set(allJobs.filter((j) => j.rework_of_job_id).map((j) => j.rework_of_job_id as string));
  const originals = key
    ? allJobs.filter((j) => {
        if (j.job_status !== 'completed' || j.is_rework || !j.service_type || norm(j.service_type) !== key) return false;
        const at = new Date(j.completed_at ?? j.scheduled_datetime ?? 0).getTime();
        return at >= start && at <= now.getTime();
      })
    : [];

  const n = originals.length;
  const fixed = originals.filter((j) => !reworked.has(j.id)).length;
  const p = (fixed + benchP * PRIOR_STRENGTH) / (n + PRIOR_STRENGTH);
  const med = median(originals.map(actualMinutes).filter((m): m is number => m !== null));
  const expectedMinutes = n >= 3 && med !== null ? med : benchMinutes;

  return { p, n, source: n >= 3 ? 'history' : jt ? 'benchmark' : 'default', expectedMinutes };
}

// ============================================================
// FACTORS
// ============================================================

interface Raw {
  logit: number;
  status: FactorStatus;
  hasData: boolean;
  detail: string;
}

function expectedFor(s: Scenario): number | null {
  const base = s.prior.expectedMinutes;
  if (base === null) return null;
  const sk = s.skill;
  if (sk && sk.sampleSize >= 3 && sk.relativeSpeedPct !== null) {
    return base * clamp(1 + sk.relativeSpeedPct / 100, 0.7, 1.6);
  }
  return base;
}

function skillFactor(s: Scenario): Raw {
  if (!s.technicianId) {
    return { logit: 0, status: 'unknown', hasData: false, detail: 'No technician assigned yet - see the ranking for the best fit.' };
  }
  const sk = s.skill;
  const priorL = logit(s.prior.p);
  if (sk && sk.sampleSize >= 2 && sk.firstTimeFixRate !== null) {
    const smoothed = ((sk.firstTimeFixRate / 100) * sk.sampleSize + s.prior.p * TECH_STRENGTH) / (sk.sampleSize + TECH_STRENGTH);
    let adj = clamp(logit(smoothed) - priorL, -1.6, 1.2);
    if (sk.trend === 'declining') adj -= 0.15;
    if (sk.trend === 'improving') adj += 0.1;
    return {
      logit: adj,
      status: adj >= 0 ? 'good' : adj > -0.6 ? 'watch' : 'risk',
      hasData: true,
      detail: `${sk.firstTimeFixRate}% first-time-fix on ${sk.sampleSize} recent ${sk.serviceType} jobs (${sk.level}).`,
    };
  }
  if (sk && sk.sampleSize > 0) {
    const adj = clamp(((sk.proficiencyScore - 60) / 40) * 1.2, -1.5, 1.0);
    return {
      logit: adj,
      status: adj >= 0 ? 'good' : adj > -0.6 ? 'watch' : 'risk',
      hasData: true,
      detail: `${sk.proficiencyScore}% proficiency from ${sk.sampleSize} job(s); too few for a reliable fix rate.`,
    };
  }
  return s.skillListed
    ? { logit: 0, status: 'watch', hasData: false, detail: 'Skill is listed on the profile but there are no completed jobs of this type yet.' }
    : { logit: -0.7, status: 'risk', hasData: false, detail: 'No listed skill and no completed jobs of this type.' };
}

function partsFactor(s: Scenario): Raw {
  const p = s.parts;
  if (!p || p.required === 0) {
    return {
      logit: s.isDiagnosticJob ? -0.15 : 0,
      status: 'unknown',
      hasData: false,
      detail: 'No required parts recorded for this job, so truck readiness cannot be verified.',
    };
  }
  const missing = Math.max(0, p.required - p.onVan);
  if (missing === 0) return { logit: 0.3, status: 'good', hasData: true, detail: `All ${p.required} required part(s) are on the truck.` };
  const unobtainable = Math.min(p.needsOrder, missing);
  const awaiting = Math.min(p.awaitingDelivery, missing - unobtainable);
  const transferable = missing - unobtainable - awaiting;
  const adj = -Math.min(2.4, 0.5 * transferable + 0.9 * awaiting + 1.5 * unobtainable);
  const bits = [
    transferable ? `${transferable} can be transferred` : '',
    awaiting ? `${awaiting} awaiting delivery` : '',
    unobtainable ? `${unobtainable} must be ordered` : '',
  ].filter(Boolean);
  return {
    logit: adj,
    status: adj < -0.5 ? 'risk' : 'watch',
    hasData: true,
    detail: `${missing} of ${p.required} required part(s) missing from the truck (${bits.join(', ')}).`,
  };
}

function diagnosisFactor(s: Scenario): Raw {
  const d = s.diagnosis;
  if (d.confidence !== null) {
    const c = clamp(d.confidence, 0, 1);
    return {
      logit: clamp((c - 0.65) * 2.4, -1.2, 0.8),
      status: c >= 0.75 ? 'good' : c >= 0.5 ? 'watch' : 'risk',
      hasData: true,
      detail: `Diagnosis Copilot confidence ${Math.round(c * 100)}%.`,
    };
  }
  if (d.documented) return { logit: 0, status: 'watch', hasData: true, detail: 'A diagnosis is documented but has not been validated by Diagnosis Copilot.' };
  if (s.isDiagnosticJob) return { logit: -0.5, status: 'risk', hasData: false, detail: 'Fault-finding job with no diagnosis on record.' };
  return { logit: 0, status: 'good', hasData: true, detail: 'Routine service - diagnosis is not a risk driver.' };
}

function durationFactor(s: Scenario): Raw {
  const expected = expectedFor(s);
  if (s.bookedMinutes === null || expected === null || expected <= 0) {
    return { logit: 0, status: 'unknown', hasData: false, detail: 'No booked duration or benchmark to compare against.' };
  }
  const ratio = s.bookedMinutes / expected;
  const adj = ratio >= 1 ? Math.min(0.25, (ratio - 1) * 0.5) : ratio >= 0.75 ? -(1 - ratio) * 1.2 : Math.max(-1.4, -0.3 - (0.75 - ratio) * 2.6);
  return {
    logit: adj,
    status: adj >= 0 ? 'good' : adj > -0.5 ? 'watch' : 'risk',
    hasData: true,
    detail: `${Math.round(s.bookedMinutes)} min booked vs ~${Math.round(expected)} min typically needed.`,
  };
}

function equipmentFactor(s: Scenario): Raw {
  const e = s.equipment;
  if (!e.linked) return { logit: 0, status: 'unknown', hasData: false, detail: 'No equipment or customer history linked to this job.' };
  const adj = -Math.min(1.4, 0.55 * e.priorReworks) - (e.recurrentSameService ? 0.4 : 0) - (e.pastLifespan ? 0.25 : 0);
  const bits = [
    e.priorReworks ? `${e.priorReworks} prior callback(s)` : '',
    e.recurrentSameService ? 'same service repeated within 90 days' : '',
    e.pastLifespan ? 'equipment past expected lifespan' : '',
  ].filter(Boolean);
  return {
    logit: adj,
    status: adj === 0 ? 'good' : adj > -0.5 ? 'watch' : 'risk',
    hasData: true,
    detail: bits.length ? `History flags: ${bits.join(', ')}.` : 'No repeat problems on record for this equipment.',
  };
}

function toolsFactor(s: Scenario): Raw {
  if (s.tools.required.length === 0) {
    return { logit: 0, status: 'unknown', hasData: false, detail: 'No special tools are configured for this service type.' };
  }
  if (!s.technicianId) return { logit: 0, status: 'unknown', hasData: true, detail: `Needs: ${s.tools.required.join(', ')}.` };
  const held = new Set(s.tools.held.map(norm));
  const missing = s.tools.required.filter((t) => !held.has(norm(t)));
  if (missing.length === 0) return { logit: 0.15, status: 'good', hasData: true, detail: 'Technician holds every required special tool.' };
  return {
    logit: -Math.min(1.8, 0.9 * missing.length),
    status: 'risk',
    hasData: true,
    detail: `Technician is missing: ${missing.join(', ')}.`,
  };
}

// ============================================================
// EVALUATION
// ============================================================

export function evaluate(s: Scenario, opts: Options = {}): Prediction {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const raws: Record<FactorKey, Raw> = {
    skill: skillFactor(s),
    parts: partsFactor(s),
    diagnosis: diagnosisFactor(s),
    duration: durationFactor(s),
    equipment: equipmentFactor(s),
    tools: toolsFactor(s),
  };
  const keys = Object.keys(raws) as FactorKey[];
  const priorL = logit(s.prior.p);
  const total = keys.reduce((sum, k) => sum + raws[k].logit, priorL);
  const pct = (l: number) => clamp(sigmoid(l) * 100, 3, 97);
  const probability = Math.round(pct(total));

  const factors: FactorResult[] = keys.map((k) => ({
    key: k,
    label: LABELS[k],
    status: raws[k].status,
    logit: raws[k].logit,
    hasData: raws[k].hasData,
    detail: raws[k].detail,
    impactPts: Math.round(pct(total) - pct(total - raws[k].logit)),
  }));

  const coverage = keys.reduce((sum, k) => sum + (raws[k].hasData ? WEIGHTS[k] : 0), 0);
  const half = Math.round(4 + (1 - coverage) * 14 + (s.prior.n < 10 ? 3 : 0));
  const confidence: ConfidenceLevel = coverage >= 0.75 && s.prior.n >= 10 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';

  return {
    probability,
    low: clamp(probability - half, 1, 99),
    high: clamp(probability + half, 1, 99),
    verdict: probability >= threshold ? 'go' : probability >= threshold - HOLD_MARGIN ? 'review' : 'hold',
    confidence,
    priorProbability: Math.round(s.prior.p * 100),
    priorSample: s.prior.n,
    priorSource: s.prior.source,
    expectedMinutes: expectedFor(s) === null ? null : Math.round(expectedFor(s) as number),
    factors: factors.sort((a, b) => a.impactPts - b.impactPts),
  };
}

// ============================================================
// CONTEXT BUILDERS
// ============================================================

export function buildEquipmentHistory(job: Job, data: Pick<AutopilotData, 'jobs' | 'jobEquipment' | 'equipment'>, now: Date): EquipmentHistory {
  const ref = new Date(job.scheduled_datetime ?? now).getTime();
  const equipIds = new Set(data.jobEquipment.filter((l) => l.job_id === job.id).map((l) => l.equipment_id));
  const linked = equipIds.size > 0 || !!job.customer_id;
  const sameEquipJobIds = new Set(data.jobEquipment.filter((l) => equipIds.has(l.equipment_id) && l.job_id !== job.id).map((l) => l.job_id));
  const key = job.service_type ? norm(job.service_type) : null;

  let priorReworks = 0;
  let recurrent = false;
  for (const j of data.jobs) {
    if (j.id === job.id) continue;
    const at = new Date(j.completed_at ?? j.scheduled_datetime ?? 0).getTime();
    const sameEquip = sameEquipJobIds.has(j.id);
    const sameCustomer = !!job.customer_id && j.customer_id === job.customer_id;
    if (!sameEquip && !sameCustomer) continue;
    if (at >= ref || ref - at > 180 * 86400000) continue;
    if (sameEquip && (j.is_rework || j.rework_of_job_id)) priorReworks += 1;
    if (key && j.service_type && norm(j.service_type) === key && j.job_status === 'completed' && ref - at <= 90 * 86400000) recurrent = true;
  }

  const pastLifespan = data.equipment.some((e) => {
    if (!equipIds.has(e.id) || !e.install_date || !e.expected_lifespan_years) return false;
    return (ref - new Date(e.install_date).getTime()) / (365.25 * 86400000) > e.expected_lifespan_years;
  });

  return { linked, priorReworks, recurrentSameService: recurrent, pastLifespan };
}

function sameDay(a: string | null, b: string | null): boolean {
  return !!a && !!b && new Date(a).toDateString() === new Date(b).toDateString();
}

export function buildJobContext(data: AutopilotData, job: Job): JobContext {
  const { now } = data;
  const key = job.service_type ? norm(job.service_type) : '';
  const prior = buildPrior(data.jobs, job.service_type, now);
  const jt = findJobType(job.service_type);

  const diag = data.diagnoses.filter((d) => d.job_id === job.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const rows = data.sourcing.filter((r) => r.job_id === job.id);

  const toolsRequired = key
    ? [...new Set(data.toolRequirements.filter((t) => norm(t.service_type) && key.includes(norm(t.service_type))).map((t) => t.tool_name.trim()))]
    : [];
  const toolsHeld: Record<string, string[]> = {};
  for (const t of data.technicianTools) (toolsHeld[t.team_member_id] ??= []).push(t.tool_name);

  const skillNodes: Record<string, SkillNode | undefined> = {};
  for (const tech of data.technicians) {
    skillNodes[tech.id] = (data.graph.nodesByTechnician.get(tech.id) ?? []).find((n) => job.service_type !== null && norm(n.serviceType) === key);
  }

  const dayLoad: Record<string, number> = {};
  for (const j of data.jobs) {
    if (!j.assigned_technician_id || j.id === job.id || j.job_status === 'cancelled' || j.job_status === 'completed') continue;
    if (sameDay(j.scheduled_datetime, job.scheduled_datetime)) dayLoad[j.assigned_technician_id] = (dayLoad[j.assigned_technician_id] ?? 0) + 1;
  }

  return {
    job,
    prior,
    isDiagnosticJob: !!jt?.troubleshooting || DIAGNOSTIC_RE.test(job.service_type ?? ''),
    diagnosis: {
      confidence: diag?.confidence ?? null,
      documented: [job.technician_diagnosis, job.diagnosis_notes].some((t) => (t ?? '').trim().length >= 15),
    },
    equipment: buildEquipmentHistory(job, data, now),
    sourcing: {
      needsOrder: rows.filter((r) => r.sourcing_status === 'order_required').length,
      awaitingDelivery: rows.filter((r) => r.sourcing_status === 'awaiting_delivery').length,
    },
    stockFit: data.stockFit[job.id] ?? {},
    toolsRequired,
    toolsHeld,
    skillNodes,
    technicians: data.technicians,
    dayLoad,
  };
}

// ============================================================
// SCENARIOS, RANKING, AUTOFIX
// ============================================================

interface Overrides {
  bookedMinutes?: number | null;
  partsFixed?: boolean;
  diagnosisFixed?: boolean;
  toolsFixed?: boolean;
}

export function scenarioFor(ctx: JobContext, technicianId: string | null, o: Overrides = {}): Scenario {
  const tech = technicianId ? ctx.technicians.find((t) => t.id === technicianId) : undefined;
  const fit = technicianId ? ctx.stockFit[technicianId] : undefined;
  let parts: PartsSignal | null = fit
    ? { required: fit.parts_required, onVan: fit.parts_on_van, needsOrder: ctx.sourcing.needsOrder, awaitingDelivery: ctx.sourcing.awaitingDelivery }
    : null;
  if (o.partsFixed && parts) parts = { ...parts, onVan: parts.required, needsOrder: 0, awaitingDelivery: 0 };

  const diagnosis: DiagnosisSignal = o.diagnosisFixed
    ? { confidence: Math.max(ctx.diagnosis.confidence ?? 0, 0.8), documented: true }
    : ctx.diagnosis;

  return {
    technicianId,
    skill: technicianId ? (ctx.skillNodes[technicianId] ?? null) : null,
    skillListed: !!tech && !!ctx.job.service_type && tech.skills.some((s) => norm(s) === norm(ctx.job.service_type as string)),
    bookedMinutes: o.bookedMinutes !== undefined ? o.bookedMinutes : ctx.job.duration_minutes,
    parts,
    diagnosis,
    equipment: ctx.equipment,
    tools: {
      required: ctx.toolsRequired,
      held: o.toolsFixed ? ctx.toolsRequired : technicianId ? (ctx.toolsHeld[technicianId] ?? []) : [],
    },
    isDiagnosticJob: ctx.isDiagnosticJob,
    prior: ctx.prior,
  };
}

export function predict(ctx: JobContext, technicianId: string | null, opts: Options = {}): Prediction {
  return evaluate(scenarioFor(ctx, technicianId), opts);
}

export function rankTechnicians(ctx: JobContext, opts: Options = {}): TechnicianRanking[] {
  return ctx.technicians
    .filter((t) => t.role === 'technician' && t.dispatch_enabled)
    .map((technician) => {
      const load = ctx.dayLoad[technician.id] ?? 0;
      const capacity = technician.max_jobs_per_day || 6;
      return { technician, prediction: predict(ctx, technician.id, opts), atCapacity: load >= capacity, load, capacity };
    })
    .sort((a, b) => Number(a.atCapacity) - Number(b.atCapacity) || b.prediction.probability - a.prediction.probability);
}

interface Working extends Overrides {
  techId: string | null;
}

export function planAutofix(ctx: JobContext, technicianId: string | null, opts: Options = {}): AutofixPlan {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const run = (w: Working) => evaluate(scenarioFor(ctx, w.techId, w), opts);
  let w: Working = { techId: technicianId };
  let current = run(w);
  const start = current.probability;
  const steps: AutofixStep[] = [];
  const used = new Set<ActionKind>();
  const ranking = rankTechnicians(ctx, opts);

  for (let i = 0; i < 5 && current.probability < threshold; i++) {
    const candidates: { step: Omit<AutofixStep, 'upliftPts' | 'projectedProbability'>; next: Working }[] = [];
    const scen = scenarioFor(ctx, w.techId, w);

    if (!used.has('reassign')) {
      const best = ranking.find((r) => !r.atCapacity && r.technician.id !== w.techId);
      if (best) {
        const name = best.technician.member_name ?? best.technician.member_email;
        candidates.push({
          step: { kind: 'reassign', title: `Assign ${name}`, detail: `${name} fits this job best (${best.prediction.probability}% on their own).`, technicianId: best.technician.id, blocking: false },
          next: { techId: best.technician.id },
        });
      }
    }
    const expected = expectedFor(scen);
    if (!used.has('extend_duration') && expected !== null && w.techId && (scen.bookedMinutes ?? 0) < expected * 0.95) {
      const minutes = roundUp15(expected);
      candidates.push({
        step: { kind: 'extend_duration', title: `Book ${minutes} minutes`, detail: `Currently ${Math.round(scen.bookedMinutes ?? 0)} min; this job type typically needs ~${Math.round(expected)} min.`, minutes, blocking: false },
        next: { ...w, bookedMinutes: minutes },
      });
    }
    const p = scen.parts;
    if (!used.has('restock') && !used.has('order') && p && p.required > p.onVan) {
      const order = p.needsOrder > 0 || p.awaitingDelivery > 0;
      candidates.push({
        step: {
          kind: order ? 'order' : 'restock',
          title: order ? 'Order or receive the missing parts' : 'Load the missing parts onto the truck',
          detail: `${p.required - p.onVan} required part(s) are not on this technician's truck.`,
          blocking: order,
        },
        next: { ...w, partsFixed: true },
      });
    }
    const conf = scen.diagnosis.confidence;
    if (!used.has('diagnose') && ctx.isDiagnosticJob && (conf === null || conf < 0.75)) {
      candidates.push({
        step: { kind: 'diagnose', title: 'Run Diagnosis Copilot before dispatch', detail: 'Validate the probable cause so the technician arrives with the right plan and parts.', blocking: false },
        next: { ...w, diagnosisFixed: true },
      });
    }
    if (!used.has('equip') && w.techId && scen.tools.required.length > 0) {
      const held = new Set(scen.tools.held.map(norm));
      const missing = scen.tools.required.filter((t) => !held.has(norm(t)));
      if (missing.length) {
        candidates.push({
          step: { kind: 'equip', title: `Load ${missing.join(', ')}`, detail: 'The assigned technician does not hold every special tool this job needs.', blocking: false },
          next: { ...w, toolsFixed: true },
        });
      }
    }

    const scored = candidates
      .map((c) => ({ ...c, result: run(c.next) }))
      .filter((c) => c.result.probability - current.probability >= 1)
      .sort((a, b) => b.result.probability - a.result.probability);
    const pick = scored[0];
    if (!pick) break;

    steps.push({ ...pick.step, upliftPts: pick.result.probability - current.probability, projectedProbability: pick.result.probability });
    used.add(pick.step.kind);
    if (pick.step.kind === 'order') used.add('restock');
    w = pick.step.kind === 'reassign' ? { techId: pick.next.techId, bookedMinutes: w.bookedMinutes, diagnosisFixed: w.diagnosisFixed } : pick.next;
    current = pick.result;
  }

  return { startProbability: start, finalProbability: current.probability, reachesThreshold: current.probability >= threshold, steps };
}

// ============================================================
// GATE (used by the dispatch board)
// ============================================================

export interface GateResult {
  action: 'allow' | 'warn' | 'hold';
  probability: number;
  message: string;
}

export function gateAssignment(prediction: Prediction, enforcement: Enforcement, threshold: number): GateResult {
  const worst = prediction.factors[0];
  const why = worst && worst.impactPts < 0 ? ` Biggest risk: ${worst.label.toLowerCase()} (${worst.impactPts} pts).` : '';
  if (enforcement === 'off' || prediction.probability >= threshold) return { action: 'allow', probability: prediction.probability, message: '' };
  const base = `First-time-fix probability is ${prediction.probability}%, below your ${threshold}% target.${why}`;
  if (enforcement === 'hold' && prediction.verdict === 'hold') {
    return { action: 'hold', probability: prediction.probability, message: `${base} Fix the issues in First-Time-Fix Autopilot before dispatching.` };
  }
  return { action: 'warn', probability: prediction.probability, message: base };
}

// ============================================================
// CALIBRATION (does the predicted % match reality?)
// ============================================================

export interface PredictionRecord {
  job_id: string;
  technician_id: string;
  probability: number;
  verdict: Verdict;
}

export interface CalibrationBucket {
  label: string;
  n: number;
  predicted: number | null;
  actual: number | null;
}

export interface Calibration {
  n: number;
  brier: number | null;
  actualRate: number | null;
  meanPredicted: number | null;
  buckets: CalibrationBucket[];
}

const BUCKETS: [string, number, number][] = [
  ['Under 50%', 0, 50],
  ['50-69%', 50, 70],
  ['70-84%', 70, 85],
  ['85%+', 85, 101],
];

export function computeCalibration(preds: PredictionRecord[], jobs: Job[], now: Date, windowDays = 14): Calibration {
  const reworked = new Set(jobs.filter((j) => j.rework_of_job_id).map((j) => j.rework_of_job_id as string));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const resolved: { p: number; ok: boolean }[] = [];

  for (const r of preds) {
    const job = byId.get(r.job_id);
    if (!job || job.job_status !== 'completed' || !job.completed_at || job.assigned_technician_id !== r.technician_id) continue;
    const failed = reworked.has(job.id);
    const aged = now.getTime() - new Date(job.completed_at).getTime() >= windowDays * 86400000;
    if (failed || aged) resolved.push({ p: r.probability / 100, ok: !failed });
  }

  const n = resolved.length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);

  return {
    n,
    brier: n ? Math.round((resolved.reduce((s, r) => s + (r.p - (r.ok ? 1 : 0)) ** 2, 0) / n) * 1000) / 1000 : null,
    actualRate: pct(avg(resolved.map((r) => (r.ok ? 1 : 0)))),
    meanPredicted: pct(avg(resolved.map((r) => r.p))),
    buckets: BUCKETS.map(([label, lo, hi]) => {
      const rows = resolved.filter((r) => r.p * 100 >= lo && r.p * 100 < hi);
      return { label, n: rows.length, predicted: pct(avg(rows.map((r) => r.p))), actual: pct(avg(rows.map((r) => (r.ok ? 1 : 0)))) };
    }),
  };
}
