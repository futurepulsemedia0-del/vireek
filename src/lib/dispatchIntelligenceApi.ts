/**
 * Dispatch Intelligence — data layer.
 *
 * Turns the board's rows into engine inputs, loads the few extra sources the
 * engine needs (credentials, van stock, quality history) in batched queries,
 * and writes assignments through the EXISTING assign_technician_to_job RPC so
 * server-side capacity and compliance checks still apply. Every optional
 * source degrades gracefully and is reported instead of failing the plan.
 */

import { supabase, type Job, type TeamMember } from '@/lib/supabase';
import { buildStockFitMap, fetchStockFit } from '@/lib/truckStock';
import { fetchTechnicianScorecards } from '@/lib/technicianPerformance';
import { geocodeTargets, jobsNeedingGeocode, techniciansNeedingGeocode } from '@/lib/routing';
import type { AssignTechnicianResult } from '@/lib/technicianCapacity';
import { computeJobRisk, type RiskReport } from '@/lib/riskIntelligence';
import { buildRiskInputs } from '@/lib/riskIntelligenceApi';
import {
  isEmergencyJob,
  isValidPoint,
  type CandidateEval,
  type DispatchJob,
  type DispatchTech,
  type GeoPoint,
  type StockFitEntry,
} from '@/lib/dispatchIntelligence';

const todayStr = (): string => new Date().toISOString().slice(0, 10);

function point(lat: number | null | undefined, lng: number | null | undefined): GeoPoint | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const p = { lat: Number(lat), lng: Number(lng) };
  return isValidPoint(p) ? p : null;
}

// ============================================================
// ROW -> ENGINE MAPPING
// ============================================================

export function toDispatchTechs(team: TeamMember[], firstTimeFix: Record<string, number | null>): DispatchTech[] {
  return team
    .filter((t) => t.role === 'technician')
    .map((t) => ({
      id: t.id,
      name: t.member_name ?? t.member_email,
      skills: Array.isArray(t.skills) ? t.skills : [],
      serviceArea: t.service_area ?? null,
      maxJobsPerDay: t.max_jobs_per_day || 6,
      dispatchEnabled: !!t.dispatch_enabled,
      home: point(t.home_latitude, t.home_longitude),
      current: point(t.current_latitude, t.current_longitude),
      currentAt: t.location_updated_at ?? null,
      firstTimeFixRate: firstTimeFix[t.id] ?? null,
    }));
}

export function toDispatchJobs(jobs: Job[]): DispatchJob[] {
  return jobs.map((j) => ({
    id: j.id,
    customerName: j.customer_name,
    serviceType: j.service_type,
    address: j.address,
    point: point(j.latitude, j.longitude),
    scheduledAt: j.scheduled_datetime,
    durationMinutes: j.duration_minutes,
    assignedTechnicianId: j.assigned_technician_id,
    status: j.job_status,
    createdAt: j.created_at,
    slaResponseHours: j.sla_response_hours ?? null,
    emergency: isEmergencyJob({ serviceType: j.service_type }, Array.isArray(j.tags) ? j.tags : []),
  }));
}

// ============================================================
// PLAN CONTEXT (batched, fault tolerant)
// ============================================================

interface RequirementRow {
  service_type: string;
  credential_type: string;
  credential_label: string | null;
  is_blocking: boolean;
}
interface CredentialRow {
  technician_id: string;
  credential_type: string;
  status: string;
  expires_at: string | null;
}

export interface PlanContext {
  stockFit: Record<string, Record<string, StockFitEntry>>;
  blockingGaps: (technicianId: string, serviceType: string | null) => string[];
  firstTimeFix: Record<string, number | null>;
  /** Sources that could not be read; the plan still works without them. */
  unavailable: string[];
}

export async function fetchPlanContext(ownerId: string, jobs: Job[], technicians: TeamMember[]): Promise<PlanContext> {
  const unavailable: string[] = [];
  const techIds = technicians.map((t) => t.id);
  const unassignedIds = jobs.filter((j) => !j.assigned_technician_id).map((j) => j.id);

  const [reqRes, credRes, fitRows, scorecards] = await Promise.all([
    supabase
      .from('compliance_requirements')
      .select('service_type, credential_type, credential_label, is_blocking')
      .eq('user_id', ownerId)
      .eq('is_blocking', true),
    techIds.length > 0
      ? supabase.from('technician_credentials').select('technician_id, credential_type, status, expires_at').in('technician_id', techIds)
      : Promise.resolve({ data: [], error: null }),
    fetchStockFit(unassignedIds).catch(() => {
      unavailable.push('van stock');
      return [];
    }),
    fetchTechnicianScorecards().catch(() => {
      unavailable.push('quality history');
      return [];
    }),
  ]);

  let requirements: RequirementRow[] = [];
  let credentials: CredentialRow[] = [];
  if (reqRes.error || credRes.error) {
    unavailable.push('credentials');
  } else {
    requirements = (reqRes.data ?? []) as RequirementRow[];
    credentials = (credRes.data ?? []) as CredentialRow[];
  }

  const today = todayStr();
  const credsByTech = new Map<string, CredentialRow[]>();
  for (const c of credentials) {
    const list = credsByTech.get(c.technician_id) ?? [];
    list.push(c);
    credsByTech.set(c.technician_id, list);
  }

  const blockingGaps = (technicianId: string, serviceType: string | null): string[] => {
    if (!serviceType) return [];
    const creds = credsByTech.get(technicianId) ?? [];
    return requirements
      .filter((r) => r.service_type === serviceType)
      .filter(
        (r) => !creds.some((c) => c.credential_type === r.credential_type && c.status === 'active' && (!c.expires_at || c.expires_at >= today)),
      )
      .map((r) => r.credential_label || r.credential_type);
  };

  const stockFit: Record<string, Record<string, StockFitEntry>> = {};
  for (const [jobId, byTech] of Object.entries(buildStockFitMap(fitRows))) {
    stockFit[jobId] = {};
    for (const [techId, row] of Object.entries(byTech)) {
      stockFit[jobId][techId] = { partsRequired: row.parts_required, partsOnVan: row.parts_on_van };
    }
  }

  const firstTimeFix: Record<string, number | null> = {};
  for (const r of scorecards) {
    if (!(r.technician_id in firstTimeFix)) firstTimeFix[r.technician_id] = r.first_time_fix_rate;
  }

  return { stockFit, blockingGaps, firstTimeFix, unavailable };
}

// ============================================================
// RISK (reuses the Risk Intelligence engine)
// ============================================================

/**
 * Scores jobs with Risk Intelligence. `overrides` lets the dispatcher see the
 * risk of a job WITH the technician the AI proposes, before anyone is assigned.
 */
export async function assessJobsRisk(
  jobs: Job[],
  ownerId: string,
  overrides?: Record<string, string | null>,
): Promise<Record<string, RiskReport>> {
  const list = jobs.slice(0, 100).map((j) => (overrides && j.id in overrides ? { ...j, assigned_technician_id: overrides[j.id] } : j));
  if (list.length === 0) return {};
  const { inputs } = await buildRiskInputs(list, ownerId);
  const out: Record<string, RiskReport> = {};
  for (const j of list) {
    const i = inputs.get(j.id);
    if (i) out[j.id] = computeJobRisk(i);
  }
  return out;
}

// ============================================================
// APPLY + AUDIT
// ============================================================

export interface ApplyParams {
  ownerId: string;
  job: Job;
  candidate: CandidateEval;
  routeSequence: number | null;
  risk: RiskReport | null;
  engineVersion: string;
  source: 'ai_plan' | 'ai_plan_bulk';
}

export async function applyRecommendation(p: ApplyParams): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase.rpc('assign_technician_to_job', {
    p_job_id: p.job.id,
    p_technician_id: p.candidate.technicianId,
  });
  const result = data as AssignTechnicianResult | null;
  if (error || result?.status !== 'assigned') {
    return { ok: false, message: result?.reason || error?.message || 'Could not assign this job.' };
  }

  // Audit trail is best-effort: a logging failure must never undo a real assignment.
  try {
    await supabase.from('dispatch_decisions').insert({
      user_id: p.ownerId,
      job_id: p.job.id,
      technician_id: p.candidate.technicianId,
      engine_version: p.engineVersion,
      source: p.source,
      score: p.candidate.score,
      confidence: p.candidate.confidence,
      planned_arrival_at: p.candidate.plannedArrivalMs !== null ? new Date(p.candidate.plannedArrivalMs).toISOString() : null,
      travel_minutes: p.candidate.travelMinutes,
      route_sequence: p.routeSequence,
      sla_breach: p.candidate.slaBreach,
      risk_level: p.risk?.overallLevel ?? null,
      risk_decision: p.risk?.coverage.decision ?? null,
      breakdown: p.candidate.breakdown,
      reasons: p.candidate.reasons,
    });
  } catch {
    // ignore
  }
  return { ok: true, message: `Assigned to ${result.technician_name ?? p.candidate.technicianName}.` };
}

// ============================================================
// GEOCODING (uses the existing geocode-address function)
// ============================================================

export function countMissingLocations(jobs: Job[], technicians: TeamMember[]): number {
  return jobsNeedingGeocode(jobs).length + techniciansNeedingGeocode(technicians).length;
}

/** Geocodes every job/technician that has an address but no coordinates, 25 per call. */
export async function geocodeMissingLocations(jobs: Job[], technicians: TeamMember[]): Promise<{ geocoded: number; total: number }> {
  const targets = [...jobsNeedingGeocode(jobs), ...techniciansNeedingGeocode(technicians)];
  let geocoded = 0;
  for (let i = 0; i < targets.length; i += 25) {
    const res = await geocodeTargets(targets.slice(i, i + 25));
    geocoded += res.geocoded;
  }
  return { geocoded, total: targets.length };
}
