/**
 * Vireek Resolution Probability Engine (RPE) - pure, no I/O.
 *
 * Decision layer that sits ABOVE dispatch. Before any truck rolls it answers:
 *   "What is the probability this problem is fully resolved on the visit,
 *    and what is the cheapest way to raise it?"
 *
 * It is separate from First-Time-Fix Autopilot:
 *   - FTF scores a technician/job pair on six operational factors.
 *   - RPE scores the whole situation across eight dimensions (customer,
 *     equipment, evidence, diagnosis, technician, parts, tools, travel), models
 *     a remote expert as a mitigation, ranks the *levers* (gather evidence,
 *     switch technician, pre-stage parts, involve an expert...) by uplift per
 *     hour of delay, and prices the failed-visit cost it avoids.
 *
 * Model: transparent log-odds. Smoothed prior (fleet history shrunk toward the
 * trade benchmark) + one bounded adjustment per dimension. No LLM, fully
 * explainable, and calibrated against real outcomes (see computeCalibration).
 */

import type { Job, TeamMember } from '@/lib/supabase';
import type { SkillNode } from '@/lib/technicianSkillGraph';
import { haversineMiles } from '@/lib/routing';
import { buildJobContext, type AutopilotData, type JobContext } from '@/lib/firstTimeFixAutopilot';

// ============================================================
// TYPES
// ============================================================

export const RPE_MODEL_VERSION = 1;

export type DimensionKey = 'customer' | 'equipment' | 'evidence' | 'diagnosis' | 'technician' | 'parts' | 'tools' | 'travel';
export type DimensionStatus = 'good' | 'watch' | 'risk' | 'unknown';
export type Verdict = 'dispatch' | 'improve' | 'hold';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface RpeSettings {
  /** Probability at or above which a job is ready to dispatch. */
  threshold: number;
  /** Below this the job should not roll a truck at all until improved. */
  floor: number;
  /** What one failed visit costs the business (truck roll + return trip), in cents. */
  truckRollCostCents: number;
}

export const DEFAULT_RPE_SETTINGS: RpeSettings = { threshold: 80, floor: 60, truckRollCostCents: 18000 };

export interface EvidenceCheckRow {
  job_id: string;
  verdict: 'pass' | 'needs_attention' | 'fail';
  /** Either 0-1 or 0-100; normalised on read. */
  evidence_completeness: number | null;
  quality_issues: unknown[] | null;
  safety_flags: unknown[] | null;
  resolved: boolean;
  created_at: string;
}

export interface ResolutionData {
  base: AutopilotData;
  evidence: EvidenceCheckRow[];
}

export interface EvidenceSignal {
  completeness: number | null; // 0-1
  verdict: EvidenceCheckRow['verdict'] | null;
  openSafetyFlags: number;
  photos: number;
}

export interface CustomerSignal {
  known: boolean;
  priorJobs: number;
  priorReworks: number;
  noShows: number;
  hasPhone: boolean;
  hasAccessNotes: boolean;
}

export interface ResolutionContext {
  ctx: JobContext;
  job: Job;
  evidence: EvidenceSignal;
  customer: CustomerSignal;
  point: { lat: number; lng: number } | null;
  now: Date;
}

export interface DimensionResult {
  key: DimensionKey;
  label: string;
  status: DimensionStatus;
  logit: number;
  /** Leave-one-out effect on the final probability, in percentage points. */
  impactPts: number;
  hasData: boolean;
  detail: string;
}

export interface Assessment {
  probability: number; // 3-97
  low: number;
  high: number;
  verdict: Verdict;
  confidence: ConfidenceLevel;
  priorProbability: number;
  priorSample: number;
  priorSource: 'history' | 'benchmark' | 'default';
  expectedMinutes: number | null;
  travelMiles: number | null;
  etaMinutes: number | null;
  remoteExpert: boolean;
  dimensions: DimensionResult[];
}

export type LeverKind =
  | 'reassign'
  | 'gather_evidence'
  | 'diagnose'
  | 'restock'
  | 'order'
  | 'load_tool'
  | 'extend_time'
  | 'remote_expert';

export interface Lever {
  kind: LeverKind;
  title: string;
  detail: string;
  upliftPts: number;
  projectedProbability: number;
  /** Hours dispatch is delayed by this lever (0 = can happen at dispatch time). */
  delayHours: number;
  /** True when dispatch must wait for the lever to complete. */
  blocking: boolean;
  technicianId?: string;
  minutes?: number;
}

export type RecommendationAction = 'dispatch_now' | 'improve_first' | 'hold';

export interface Recommendation {
  action: RecommendationAction;
  headline: string;
  reason: string;
}

export interface ResolutionPlan {
  startProbability: number;
  finalProbability: number;
  reachesThreshold: boolean;
  levers: Lever[];
  totalDelayHours: number;
  /** Expected cost of failed visits before vs after the plan, in cents. */
  startFailureCostCents: number;
  finalFailureCostCents: number;
  recommendation: Recommendation;
}

export interface CandidateRanking {
  technician: TeamMember;
  assessment: Assessment;
  atCapacity: boolean;
  load: number;
  capacity: number;
}

export interface Overrides {
  bookedMinutes?: number | null;
  evidenceFixed?: boolean;
  diagnosisFixed?: boolean;
  partsFixed?: boolean;
  toolsFixed?: boolean;
  remoteExpert?: boolean;
}

// ============================================================
// HELPERS
// ============================================================

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const logit = (p: number) => Math.log(clamp(p, 0.001, 0.999) / (1 - clamp(p, 0.001, 0.999)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const norm = (s: string) => s.trim().toLowerCase();
const roundUp15 = (m: number) => Math.ceil(m / 15) * 15;
const DAY = 86400000;

const TECH_STRENGTH = 4;
const CIRCUITY = 1.3;
const AVG_MPH = 30;
const FRESH_GPS_MS = 3 * 3600000;
/** Share of a technician/diagnosis shortfall a remote expert is assumed to cover. */
export const REMOTE_EXPERT_RECOVERY = 0.6;
const EXPERT_MIN_PROFICIENCY = 70;
const EXPERT_MIN_SAMPLE = 5;

const LABELS: Record<DimensionKey, string> = {
  customer: 'Customer',
  equipment: 'Equipment history',
  evidence: 'Evidence',
  diagnosis: 'Diagnosis',
  technician: 'Technician fit',
  parts: 'Parts readiness',
  tools: 'Special tools',
  travel: 'Travel & time window',
};

const WEIGHTS: Record<DimensionKey, number> = {
  customer: 0.05,
  equipment: 0.1,
  evidence: 0.15,
  diagnosis: 0.15,
  technician: 0.2,
  parts: 0.2,
  tools: 0.05,
  travel: 0.1,
};

const statusOf = (adj: number, goodAt = 0, watchAt = -0.5): DimensionStatus => (adj >= goodAt ? 'good' : adj > watchAt ? 'watch' : 'risk');

export const formatMoney = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

/** Expected cost of failed visits: P(not resolved) x cost of a failed visit. */
export const failureCostCents = (probabilityPct: number, truckRollCostCents: number) =>
  Math.round(((100 - probabilityPct) / 100) * truckRollCostCents);

// ============================================================
// CONTEXT
// ============================================================

function normaliseCompleteness(v: number | null): number | null {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  return clamp(n > 1 ? n / 100 : n, 0, 1);
}

export function buildResolutionContext(data: ResolutionData, job: Job): ResolutionContext {
  const { base } = data;
  const ctx = buildJobContext(base, job);
  const now = base.now;
  const ref = new Date(job.scheduled_datetime ?? now).getTime();

  const checks = data.evidence.filter((e) => e.job_id === job.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = checks[0];
  const evidence: EvidenceSignal = {
    completeness: latest ? normaliseCompleteness(latest.evidence_completeness) : null,
    verdict: latest?.verdict ?? null,
    openSafetyFlags: checks.filter((c) => !c.resolved).reduce((n, c) => n + (c.safety_flags?.length ?? 0), 0),
    photos: Array.isArray(job.before_photos) ? job.before_photos.length : 0,
  };

  let priorJobs = 0;
  let priorReworks = 0;
  let noShows = 0;
  if (job.customer_id) {
    for (const j of base.jobs) {
      if (j.id === job.id || j.customer_id !== job.customer_id) continue;
      const at = new Date(j.completed_at ?? j.scheduled_datetime ?? 0).getTime();
      if (at >= ref || ref - at > 365 * DAY) continue;
      if (j.job_status === 'completed') priorJobs += 1;
      if (j.is_rework || j.rework_of_job_id) priorReworks += 1;
      if (j.job_status === 'no_show') noShows += 1;
    }
  }

  const customer: CustomerSignal = {
    known: !!job.customer_id,
    priorJobs,
    priorReworks,
    noShows,
    hasPhone: !!(job.customer_phone ?? '').trim(),
    hasAccessNotes: (job.dispatch_note ?? '').trim().length >= 10,
  };

  const point = typeof job.latitude === 'number' && typeof job.longitude === 'number' ? { lat: job.latitude, lng: job.longitude } : null;
  return { ctx, job, evidence, customer, point, now };
}

function technicianPoint(tech: TeamMember, now: Date): { lat: number; lng: number } | null {
  const fresh = tech.location_updated_at && now.getTime() - new Date(tech.location_updated_at).getTime() <= FRESH_GPS_MS;
  if (fresh && typeof tech.current_latitude === 'number' && typeof tech.current_longitude === 'number') {
    return { lat: tech.current_latitude, lng: tech.current_longitude };
  }
  if (typeof tech.home_latitude === 'number' && typeof tech.home_longitude === 'number') {
    return { lat: tech.home_latitude, lng: tech.home_longitude };
  }
  return null;
}

/** Best other technician who could coach this job remotely, if any. */
export function findRemoteExpert(rc: ResolutionContext, techId: string | null): { id: string; name: string } | null {
  const key = rc.job.service_type ? norm(rc.job.service_type) : null;
  if (!key) return null;
  let best: { node: SkillNode; id: string } | null = null;
  for (const t of rc.ctx.technicians) {
    if (t.id === techId) continue;
    const node = rc.ctx.skillNodes[t.id];
    if (!node || node.sampleSize < EXPERT_MIN_SAMPLE || node.proficiencyScore < EXPERT_MIN_PROFICIENCY) continue;
    if (!best || node.proficiencyScore > best.node.proficiencyScore) best = { node, id: t.id };
  }
  if (!best) return null;
  const tech = rc.ctx.technicians.find((t) => t.id === best.id);
  return { id: best.id, name: tech?.member_name ?? tech?.member_email ?? 'Senior technician' };
}

// ============================================================
// DIMENSIONS
// ============================================================

interface Raw {
  logit: number;
  status: DimensionStatus;
  hasData: boolean;
  detail: string;
}

function expectedMinutesFor(rc: ResolutionContext, techId: string | null): number | null {
  const base = rc.ctx.prior.expectedMinutes;
  if (base === null) return null;
  const sk = techId ? rc.ctx.skillNodes[techId] : undefined;
  if (sk && sk.sampleSize >= 3 && sk.relativeSpeedPct !== null) return base * clamp(1 + sk.relativeSpeedPct / 100, 0.7, 1.6);
  return base;
}

function customerDim(rc: ResolutionContext): Raw {
  const c = rc.customer;
  let adj = 0;
  const bits: string[] = [];
  if (c.priorJobs >= 2 && c.priorReworks === 0) {
    adj += 0.1;
    bits.push(`${c.priorJobs} prior jobs, no callbacks`);
  }
  if (c.priorReworks > 0) {
    adj -= Math.min(1, 0.5 * c.priorReworks);
    bits.push(`${c.priorReworks} prior callback(s)`);
  }
  if (c.noShows > 0) {
    adj -= Math.min(0.4, 0.2 * c.noShows);
    bits.push(`${c.noShows} past no-show(s)`);
  }
  if (!c.hasPhone) {
    adj -= 0.25;
    bits.push('no phone number to confirm access');
  }
  if (c.hasAccessNotes) {
    adj += 0.05;
    bits.push('access notes on file');
  }
  const hasData = c.known || c.hasPhone;
  return {
    logit: adj,
    status: hasData ? statusOf(adj, 0, -0.3) : 'unknown',
    hasData,
    detail: bits.length ? `${bits.join('; ')}.` : 'No customer history on this job yet.',
  };
}

function equipmentDim(rc: ResolutionContext): Raw {
  const e = rc.ctx.equipment;
  if (!e.linked) return { logit: 0, status: 'unknown', hasData: false, detail: 'No equipment or customer history linked to this job.' };
  const adj = -Math.min(1.4, 0.55 * e.priorReworks) - (e.recurrentSameService ? 0.4 : 0) - (e.pastLifespan ? 0.25 : 0);
  const bits = [
    e.priorReworks ? `${e.priorReworks} prior callback(s) on this equipment` : '',
    e.recurrentSameService ? 'same service repeated within 90 days' : '',
    e.pastLifespan ? 'past expected lifespan' : '',
  ].filter(Boolean);
  return {
    logit: adj,
    status: adj === 0 ? 'good' : adj > -0.5 ? 'watch' : 'risk',
    hasData: true,
    detail: bits.length ? `${bits.join(', ')}.` : 'No repeat problems on record for this equipment.',
  };
}

function evidenceDim(rc: ResolutionContext, o: Overrides): Raw {
  if (o.evidenceFixed) return { logit: 0.45, status: 'good', hasData: true, detail: 'Complete evidence collected before dispatch (projected).' };
  const e = rc.evidence;
  const diagnostic = rc.ctx.isDiagnosticJob;
  if (e.completeness !== null) {
    const adj = clamp((e.completeness - 0.6) * 1.8, -0.8, 0.6) - (e.verdict === 'fail' ? 0.3 : 0) - (e.openSafetyFlags > 0 ? 0.15 : 0);
    const flags = e.openSafetyFlags > 0 ? `, ${e.openSafetyFlags} open safety flag(s)` : '';
    return { logit: adj, status: statusOf(adj, 0.1, -0.3), hasData: true, detail: `Evidence ${Math.round(e.completeness * 100)}% complete${flags}.` };
  }
  if (e.photos > 0) {
    const adj = e.photos >= 3 ? 0.2 : 0.05;
    return { logit: adj, status: 'watch', hasData: true, detail: `${e.photos} photo(s) attached but not yet verified by AI.` };
  }
  return diagnostic
    ? { logit: -0.45, status: 'risk', hasData: false, detail: 'Fault-finding job with no photos, video or serial data.' }
    : { logit: -0.05, status: 'unknown', hasData: false, detail: 'No evidence attached; routine work, so a minor risk.' };
}

function diagnosisDim(rc: ResolutionContext, o: Overrides): Raw {
  const d = o.diagnosisFixed ? { confidence: Math.max(rc.ctx.diagnosis.confidence ?? 0, 0.8), documented: true } : rc.ctx.diagnosis;
  if (d.confidence !== null) {
    const c = clamp(d.confidence, 0, 1);
    return {
      logit: clamp((c - 0.65) * 2.4, -1.2, 0.8),
      status: c >= 0.75 ? 'good' : c >= 0.5 ? 'watch' : 'risk',
      hasData: true,
      detail: `Diagnosis confidence ${Math.round(c * 100)}%.`,
    };
  }
  if (d.documented) return { logit: 0, status: 'watch', hasData: true, detail: 'A diagnosis is documented but not validated.' };
  if (rc.ctx.isDiagnosticJob) return { logit: -0.5, status: 'risk', hasData: false, detail: 'Fault-finding job with no diagnosis on record.' };
  return { logit: 0, status: 'good', hasData: true, detail: 'Routine service; diagnosis is not a risk driver.' };
}

function technicianDim(rc: ResolutionContext, techId: string | null): Raw {
  if (!techId) return { logit: 0, status: 'unknown', hasData: false, detail: 'No technician assigned yet.' };
  const tech = rc.ctx.technicians.find((t) => t.id === techId);
  const sk = rc.ctx.skillNodes[techId];
  const priorP = rc.ctx.prior.p;
  const load = rc.ctx.dayLoad[techId] ?? 0;
  const capacity = tech?.max_jobs_per_day || 6;
  const strain = load >= capacity ? -0.3 : 0;
  const strainNote = strain ? ` Already at capacity (${load}/${capacity} jobs).` : '';

  if (sk && sk.sampleSize >= 2 && sk.firstTimeFixRate !== null) {
    const smoothed = ((sk.firstTimeFixRate / 100) * sk.sampleSize + priorP * TECH_STRENGTH) / (sk.sampleSize + TECH_STRENGTH);
    let adj = clamp(logit(smoothed) - logit(priorP), -1.6, 1.2);
    if (sk.trend === 'declining') adj -= 0.15;
    if (sk.trend === 'improving') adj += 0.1;
    adj += strain;
    return { logit: adj, status: statusOf(adj), hasData: true, detail: `${sk.firstTimeFixRate}% fix rate on ${sk.sampleSize} recent ${sk.serviceType} jobs (${sk.level}).${strainNote}` };
  }
  if (sk && sk.sampleSize > 0) {
    const adj = clamp(((sk.proficiencyScore - 60) / 40) * 1.2, -1.5, 1) + strain;
    return { logit: adj, status: statusOf(adj), hasData: true, detail: `${sk.proficiencyScore}% proficiency from ${sk.sampleSize} job(s); too few for a reliable fix rate.${strainNote}` };
  }
  const listed = !!tech && !!rc.job.service_type && tech.skills.some((s) => norm(s) === norm(rc.job.service_type as string));
  return listed
    ? { logit: strain, status: 'watch', hasData: false, detail: `Skill is listed but there are no completed jobs of this type yet.${strainNote}` }
    : { logit: -0.7 + strain, status: 'risk', hasData: false, detail: `No listed skill and no completed jobs of this type.${strainNote}` };
}

function partsDim(rc: ResolutionContext, techId: string | null, o: Overrides): Raw {
  const fit = techId ? rc.ctx.stockFit[techId] : undefined;
  if (!fit || fit.parts_required === 0) {
    return {
      logit: rc.ctx.isDiagnosticJob ? -0.15 : 0,
      status: 'unknown',
      hasData: false,
      detail: 'No required parts recorded, so truck readiness cannot be verified.',
    };
  }
  if (o.partsFixed) return { logit: 0.3, status: 'good', hasData: true, detail: `All ${fit.parts_required} required part(s) on the truck (projected).` };
  const missing = Math.max(0, fit.parts_required - fit.parts_on_van);
  if (missing === 0) return { logit: 0.3, status: 'good', hasData: true, detail: `All ${fit.parts_required} required part(s) are on the truck.` };
  const { needsOrder, awaitingDelivery } = rc.ctx.sourcing;
  const unobtainable = Math.min(needsOrder, missing);
  const awaiting = Math.min(awaitingDelivery, missing - unobtainable);
  const transferable = missing - unobtainable - awaiting;
  const adj = -Math.min(2.4, 0.5 * transferable + 0.9 * awaiting + 1.5 * unobtainable);
  const bits = [
    transferable ? `${transferable} transferable` : '',
    awaiting ? `${awaiting} awaiting delivery` : '',
    unobtainable ? `${unobtainable} must be ordered` : '',
  ].filter(Boolean);
  return { logit: adj, status: adj < -0.5 ? 'risk' : 'watch', hasData: true, detail: `${missing} of ${fit.parts_required} required part(s) missing (${bits.join(', ')}).` };
}

function toolsDim(rc: ResolutionContext, techId: string | null, o: Overrides): Raw {
  const required = rc.ctx.toolsRequired;
  if (required.length === 0) return { logit: 0, status: 'unknown', hasData: false, detail: 'No special tools configured for this service type.' };
  if (!techId) return { logit: 0, status: 'unknown', hasData: true, detail: `Needs: ${required.join(', ')}.` };
  if (o.toolsFixed) return { logit: 0.15, status: 'good', hasData: true, detail: 'Every required tool loaded (projected).' };
  const held = new Set((rc.ctx.toolsHeld[techId] ?? []).map(norm));
  const missing = required.filter((t) => !held.has(norm(t)));
  if (missing.length === 0) return { logit: 0.15, status: 'good', hasData: true, detail: 'Technician holds every required tool.' };
  return { logit: -Math.min(1.8, 0.9 * missing.length), status: 'risk', hasData: true, detail: `Technician is missing: ${missing.join(', ')}.` };
}

interface TravelInfo {
  raw: Raw;
  miles: number | null;
  eta: number | null;
}

function travelDim(rc: ResolutionContext, techId: string | null, o: Overrides): TravelInfo {
  const tech = techId ? rc.ctx.technicians.find((t) => t.id === techId) : undefined;
  const from = tech ? technicianPoint(tech, rc.now) : null;
  let miles: number | null = null;
  let eta: number | null = null;
  let travelAdj = 0;
  const bits: string[] = [];

  if (from && rc.point) {
    miles = Math.round(haversineMiles(from.lat, from.lng, rc.point.lat, rc.point.lng) * CIRCUITY * 10) / 10;
    eta = Math.round((miles / AVG_MPH) * 60);
    travelAdj = eta <= 30 ? 0 : eta <= 60 ? -0.1 : -Math.min(0.5, 0.1 + ((eta - 60) / 60) * 0.3);
    bits.push(`~${eta} min drive (${miles} mi)`);
  }

  const booked = o.bookedMinutes !== undefined ? o.bookedMinutes : rc.job.duration_minutes;
  const expected = expectedMinutesFor(rc, techId);
  let timeAdj = 0;
  let timeKnown = false;
  if (booked !== null && booked !== undefined && expected !== null && expected > 0) {
    timeKnown = true;
    const ratio = booked / expected;
    timeAdj = ratio >= 1 ? Math.min(0.25, (ratio - 1) * 0.5) : ratio >= 0.75 ? -(1 - ratio) * 1.2 : Math.max(-1.4, -0.3 - (0.75 - ratio) * 2.6);
    bits.push(`${Math.round(booked)} min booked vs ~${Math.round(expected)} min typical`);
  }

  const adj = travelAdj + timeAdj;
  const hasData = miles !== null || timeKnown;
  return {
    miles,
    eta,
    raw: {
      logit: adj,
      status: hasData ? statusOf(adj, 0, -0.4) : 'unknown',
      hasData,
      detail: hasData ? `${bits.join('; ')}.` : 'No location or booked duration to evaluate travel and time window.',
    },
  };
}

// ============================================================
// ASSESSMENT
// ============================================================

export function assess(rc: ResolutionContext, techId: string | null, settings: RpeSettings = DEFAULT_RPE_SETTINGS, o: Overrides = {}): Assessment {
  const remote = !!o.remoteExpert && !!findRemoteExpert(rc, techId);
  const travel = travelDim(rc, techId, o);

  const raws: Record<DimensionKey, Raw> = {
    customer: customerDim(rc),
    equipment: equipmentDim(rc),
    evidence: evidenceDim(rc, o),
    diagnosis: diagnosisDim(rc, o),
    technician: technicianDim(rc, techId),
    parts: partsDim(rc, techId, o),
    tools: toolsDim(rc, techId, o),
    travel: travel.raw,
  };

  // A remote expert absorbs most of a skill or diagnosis shortfall (never a parts or tools gap).
  if (remote) {
    for (const k of ['technician', 'diagnosis'] as const) {
      const r = raws[k];
      if (r.logit < 0) raws[k] = { ...r, logit: r.logit * (1 - REMOTE_EXPERT_RECOVERY), status: r.status === 'risk' ? 'watch' : r.status, detail: `${r.detail} Remote expert covers part of this gap.` };
    }
  }

  // Interaction: guessing at the fault with no parts margin is worse than either alone.
  const blind = (raws.diagnosis.status === 'risk' || raws.diagnosis.status === 'watch') && raws.diagnosis.logit <= 0 && raws.parts.logit < -0.3 && !remote;
  const interaction = blind ? -0.25 : 0;

  const keys = Object.keys(raws) as DimensionKey[];
  const priorL = logit(rc.ctx.prior.p);
  // Risk signals overlap (a weak diagnosis and thin evidence are partly the same problem),
  // so stacked penalties are discounted slightly instead of compounding without limit.
  const negatives = keys.filter((k) => raws[k].logit < 0).length;
  const discount = negatives >= 4 ? 0.85 : negatives === 3 ? 0.92 : 1;
  const adjusted = (l: number) => (l < 0 ? l * discount : l);
  const total = keys.reduce((s, k) => s + adjusted(raws[k].logit), priorL) + interaction;
  const pct = (l: number) => clamp(sigmoid(l) * 100, 3, 97);
  const probability = Math.round(pct(total));

  const dimensions: DimensionResult[] = keys
    .map((k) => ({
      key: k,
      label: LABELS[k],
      status: raws[k].status,
      logit: raws[k].logit,
      hasData: raws[k].hasData,
      detail: raws[k].detail,
      impactPts: Math.round(pct(total) - pct(total - adjusted(raws[k].logit))),
    }))
    .sort((a, b) => a.impactPts - b.impactPts);

  const coverage = keys.reduce((s, k) => s + (raws[k].hasData ? WEIGHTS[k] : 0), 0);
  const half = Math.round(4 + (1 - coverage) * 14 + (rc.ctx.prior.n < 10 ? 3 : 0));
  const confidence: ConfidenceLevel = coverage >= 0.75 && rc.ctx.prior.n >= 10 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';
  const expected = expectedMinutesFor(rc, techId);

  return {
    probability,
    low: clamp(probability - half, 1, 99),
    high: clamp(probability + half, 1, 99),
    verdict: probability >= settings.threshold ? 'dispatch' : probability >= settings.floor ? 'improve' : 'hold',
    confidence,
    priorProbability: Math.round(rc.ctx.prior.p * 100),
    priorSample: rc.ctx.prior.n,
    priorSource: rc.ctx.prior.source,
    expectedMinutes: expected === null ? null : Math.round(expected),
    travelMiles: travel.miles,
    etaMinutes: travel.eta,
    remoteExpert: remote,
    dimensions,
  };
}

export function rankCandidates(rc: ResolutionContext, settings: RpeSettings = DEFAULT_RPE_SETTINGS, o: Overrides = {}): CandidateRanking[] {
  return rc.ctx.technicians
    .filter((t) => t.role === 'technician' && t.dispatch_enabled)
    .map((technician) => {
      const load = rc.ctx.dayLoad[technician.id] ?? 0;
      const capacity = technician.max_jobs_per_day || 6;
      return { technician, assessment: assess(rc, technician.id, settings, o), atCapacity: load >= capacity, load, capacity };
    })
    .sort((a, b) => Number(a.atCapacity) - Number(b.atCapacity) || b.assessment.probability - a.assessment.probability);
}

// ============================================================
// LEVER PLANNER
// ============================================================

interface Working extends Overrides {
  techId: string | null;
}

type Candidate = { lever: Omit<Lever, 'upliftPts' | 'projectedProbability'>; next: Working };

const nameOf = (t: TeamMember) => t.member_name ?? t.member_email;

export function recommend(start: Assessment, plan: Pick<ResolutionPlan, 'levers' | 'reachesThreshold' | 'finalProbability'>, settings: RpeSettings): Recommendation {
  if (start.probability >= settings.threshold) {
    return { action: 'dispatch_now', headline: 'Dispatch now', reason: `${start.probability}% resolution probability meets your ${settings.threshold}% target.` };
  }
  const first = plan.levers[0];
  if (!first) {
    return {
      action: 'hold',
      headline: 'Hold dispatch',
      reason: `${start.probability}% is below your ${settings.threshold}% target and no available lever lifts it. Review the weakest dimensions before sending anyone.`,
    };
  }
  const headlines: Record<LeverKind, string> = {
    reassign: `Send ${first.title.replace(/^(Assign|Send) /, '')} instead`,
    gather_evidence: 'Collect more evidence before dispatch',
    diagnose: 'Validate the diagnosis before dispatch',
    restock: 'Pre-stage the parts before dispatch',
    order: 'Order the missing parts before dispatch',
    load_tool: 'Load the required tools before dispatch',
    extend_time: 'Book enough time for this job',
    remote_expert: 'Dispatch with a remote expert on call',
  };
  const reach = plan.reachesThreshold ? `reaches ${plan.finalProbability}%` : `lifts it to ${plan.finalProbability}%, still short of ${settings.threshold}%`;
  return {
    action: plan.reachesThreshold || start.probability >= settings.floor ? 'improve_first' : 'hold',
    headline: headlines[first.kind],
    reason: `${start.probability}% is below target. Following the plan below ${reach}.`,
  };
}

export function planResolution(rc: ResolutionContext, technicianId: string | null, settings: RpeSettings = DEFAULT_RPE_SETTINGS): ResolutionPlan {
  const run = (w: Working) => assess(rc, w.techId, settings, w);
  const ranking = rankCandidates(rc, settings);

  let w: Working = { techId: technicianId };
  // Unassigned: evaluate against the best available candidate so the plan is actionable.
  const seed = technicianId ? undefined : ranking.find((r) => !r.atCapacity);
  const levers: Lever[] = [];
  if (seed) {
    w = { techId: seed.technician.id };
    levers.push({
      kind: 'reassign',
      title: `Assign ${nameOf(seed.technician)}`,
      detail: `Best available fit for this job (${seed.assessment.probability}% on their own).`,
      upliftPts: 0,
      projectedProbability: seed.assessment.probability,
      delayHours: 0,
      blocking: false,
      technicianId: seed.technician.id,
    });
  }

  const startAssessment = run({ techId: technicianId });
  let current = run(w);
  const used = new Set<LeverKind>(seed ? ['reassign'] : []);
  const kept: Lever[] = [...levers];

  for (let i = 0; i < 6 && current.probability < settings.threshold; i++) {
    const candidates: Candidate[] = [];
    const dims = Object.fromEntries(current.dimensions.map((d) => [d.key, d])) as Record<DimensionKey, DimensionResult>;

    if (!used.has('reassign')) {
      const best = ranking.find((r) => !r.atCapacity && r.technician.id !== w.techId);
      if (best) {
        candidates.push({
          lever: { kind: 'reassign', title: `Send ${nameOf(best.technician)}`, detail: `Fits this job better (${best.assessment.probability}% on their own).`, delayHours: 0, blocking: false, technicianId: best.technician.id },
          next: { techId: best.technician.id, bookedMinutes: w.bookedMinutes, evidenceFixed: w.evidenceFixed, diagnosisFixed: w.diagnosisFixed, remoteExpert: w.remoteExpert },
        });
      }
    }

    if (!used.has('gather_evidence') && dims.evidence.logit < 0.3) {
      candidates.push({
        lever: { kind: 'gather_evidence', title: 'Get more evidence from the customer', detail: 'Request photos or video of the fault, the unit nameplate and the surrounding area.', delayHours: 3, blocking: true },
        next: { ...w, evidenceFixed: true },
      });
    }

    const conf = rc.ctx.diagnosis.confidence;
    if (!used.has('diagnose') && !w.diagnosisFixed && rc.ctx.isDiagnosticJob && (conf === null || conf < 0.75)) {
      candidates.push({
        lever: { kind: 'diagnose', title: 'Run Diagnosis Copilot first', detail: 'Validate the probable cause so the technician arrives with the right plan and parts.', delayHours: 1, blocking: true },
        next: { ...w, diagnosisFixed: true },
      });
    }

    const fit = w.techId ? rc.ctx.stockFit[w.techId] : undefined;
    if (!used.has('restock') && !used.has('order') && !w.partsFixed && fit && fit.parts_required > fit.parts_on_van) {
      const missing = fit.parts_required - fit.parts_on_van;
      const { needsOrder, awaitingDelivery } = rc.ctx.sourcing;
      const order = needsOrder > 0 || awaitingDelivery > 0;
      candidates.push({
        lever: {
          kind: order ? 'order' : 'restock',
          title: order ? 'Order or receive the missing parts' : 'Pre-stage the missing parts on the truck',
          detail: `${missing} required part(s) are not on this technician's truck.`,
          delayHours: needsOrder > 0 ? 24 : awaitingDelivery > 0 ? 12 : 2,
          blocking: true,
        },
        next: { ...w, partsFixed: true },
      });
    }

    if (!used.has('load_tool') && !w.toolsFixed && w.techId && rc.ctx.toolsRequired.length > 0) {
      const held = new Set((rc.ctx.toolsHeld[w.techId] ?? []).map(norm));
      const missing = rc.ctx.toolsRequired.filter((t) => !held.has(norm(t)));
      if (missing.length) {
        candidates.push({
          lever: { kind: 'load_tool', title: `Load ${missing.join(', ')}`, detail: 'The assigned technician does not hold every special tool this job needs.', delayHours: 1, blocking: true },
          next: { ...w, toolsFixed: true },
        });
      }
    }

    const expected = expectedMinutesFor(rc, w.techId);
    const booked = w.bookedMinutes !== undefined ? w.bookedMinutes : rc.job.duration_minutes;
    if (!used.has('extend_time') && w.techId && expected !== null && (booked ?? 0) < expected * 0.95) {
      const minutes = roundUp15(expected);
      candidates.push({
        lever: { kind: 'extend_time', title: `Book ${minutes} minutes`, detail: `Currently ${Math.round(booked ?? 0)} min; this job type typically needs ~${Math.round(expected)} min.`, delayHours: 0, blocking: false, minutes },
        next: { ...w, bookedMinutes: minutes },
      });
    }

    if (!used.has('remote_expert') && !w.remoteExpert) {
      const expert = findRemoteExpert(rc, w.techId);
      if (expert) {
        candidates.push({
          lever: { kind: 'remote_expert', title: `Put ${expert.name} on remote standby`, detail: 'A senior technician with strong history on this service type can coach on site over video.', delayHours: 0.25, blocking: false },
          next: { ...w, remoteExpert: true },
        });
      }
    }

    // Best uplift per hour of delay; a lever that waits a day must earn it.
    const scored = candidates
      .map((c) => ({ c, result: run(c.next) }))
      .map((s) => ({ ...s, uplift: s.result.probability - current.probability }))
      .filter((s) => s.uplift >= 1)
      .sort((a, b) => b.uplift / (1 + b.c.lever.delayHours / 4) - a.uplift / (1 + a.c.lever.delayHours / 4));
    const pick = scored[0];
    if (!pick) break;

    kept.push({ ...pick.c.lever, upliftPts: pick.uplift, projectedProbability: pick.result.probability });
    used.add(pick.c.lever.kind);
    if (pick.c.lever.kind === 'order') used.add('restock');
    if (pick.c.lever.kind === 'restock') used.add('order');
    w = pick.c.next;
    current = pick.result;
  }

  // The seeded assignment's uplift is measured against the unassigned baseline.
  if (seed && kept[0]) kept[0] = { ...kept[0], upliftPts: seed.assessment.probability - startAssessment.probability };

  const totalDelayHours = kept.filter((l) => l.blocking).reduce((m, l) => Math.max(m, l.delayHours), 0);
  const partial = {
    levers: kept,
    reachesThreshold: current.probability >= settings.threshold,
    finalProbability: current.probability,
  };
  return {
    startProbability: startAssessment.probability,
    finalProbability: current.probability,
    reachesThreshold: partial.reachesThreshold,
    levers: kept,
    totalDelayHours,
    startFailureCostCents: failureCostCents(startAssessment.probability, settings.truckRollCostCents),
    finalFailureCostCents: failureCostCents(current.probability, settings.truckRollCostCents),
    recommendation: recommend(startAssessment, partial, settings),
  };
}

// ============================================================
// CALIBRATION
// ============================================================

export interface AssessmentRecord {
  job_id: string;
  technician_id: string;
  probability: number;
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

/** A visit counts as resolved when it completed and no callback was opened within the window. */
export function computeCalibration(records: AssessmentRecord[], jobs: Job[], now: Date, windowDays = 14): Calibration {
  const reworked = new Set(jobs.filter((j) => j.rework_of_job_id).map((j) => j.rework_of_job_id as string));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const resolved: { p: number; ok: boolean }[] = [];

  for (const r of records) {
    const job = byId.get(r.job_id);
    if (!job || job.job_status !== 'completed' || !job.completed_at || job.assigned_technician_id !== r.technician_id) continue;
    const failed = reworked.has(job.id);
    const aged = now.getTime() - new Date(job.completed_at).getTime() >= windowDays * DAY;
    if (failed || aged) resolved.push({ p: r.probability / 100, ok: !failed });
  }

  const n = resolved.length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pctOf = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);

  return {
    n,
    brier: n ? Math.round((resolved.reduce((s, r) => s + (r.p - (r.ok ? 1 : 0)) ** 2, 0) / n) * 1000) / 1000 : null,
    actualRate: pctOf(avg(resolved.map((r) => (r.ok ? 1 : 0)))),
    meanPredicted: pctOf(avg(resolved.map((r) => r.p))),
    buckets: BUCKETS.map(([label, lo, hi]) => {
      const rows = resolved.filter((r) => r.p * 100 >= lo && r.p * 100 < hi);
      return { label, n: rows.length, predicted: pctOf(avg(rows.map((r) => r.p))), actual: pctOf(avg(rows.map((r) => (r.ok ? 1 : 0)))) };
    }),
  };
}
