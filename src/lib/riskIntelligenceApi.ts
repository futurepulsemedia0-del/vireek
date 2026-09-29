/**
 * Service Risk Intelligence — data layer.
 *
 * Gathers the raw rows behind every risk dimension for one or many jobs in a
 * fixed number of batched queries (no per-job round trips), hands them to the
 * pure engine, and persists the audit trail. Every optional source degrades
 * gracefully: if a table cannot be read, the assessment still works and the
 * report says which data was unavailable.
 */

import { supabase, type Job } from '@/lib/supabase';
import {
  DEFAULT_RISK_POLICY,
  hazardTierFor,
  isAfterHours,
  type EquipmentRisk,
  type RiskInputs,
  type RiskLevel,
  type RiskPolicy,
  type RiskReport,
  type CoverageDecision,
} from '@/lib/riskIntelligence';

const DAY_MS = 86_400_000;

export type RiskJob = Pick<
  Job,
  | 'id'
  | 'user_id'
  | 'customer_id'
  | 'service_type'
  | 'address'
  | 'scheduled_datetime'
  | 'assigned_technician_id'
  | 'invoice_amount'
  | 'customer_type'
  | 'sla_response_hours'
  | 'diagnosis_notes'
  | 'technician_diagnosis'
  | 'before_photos'
>;

// ============================================================
// SMALL HELPERS
// ============================================================

const uniq = <T,>(xs: T[]): T[] => Array.from(new Set(xs));
const isoDaysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);
const todayStr = (): string => dateOnly(new Date());

function normAddress(a: string | null | undefined): string {
  return (a ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function daysUntilDate(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const today = Date.parse(`${todayStr()}T00:00:00Z`);
  return Math.round((t - today) / DAY_MS);
}

function ageYears(installDate: string | null | undefined): number | null {
  if (!installDate) return null;
  const t = Date.parse(installDate);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / (365.25 * DAY_MS));
}

type QueryResult = { data: unknown; error: { message: string } | null };

async function rowsIf<T>(
  enabled: boolean,
  source: string,
  unavailable: Set<string>,
  run: () => PromiseLike<QueryResult>,
): Promise<T[]> {
  if (!enabled) return [];
  try {
    const { data, error } = await run();
    if (error) {
      unavailable.add(source);
      return [];
    }
    return (data as T[] | null) ?? [];
  } catch {
    unavailable.add(source);
    return [];
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ============================================================
// POLICY
// ============================================================

interface PolicyRow {
  liability_limit_cents: number | string | null;
  high_value_job_cents: number | string;
  high_risk_service_types: string[] | null;
  require_ack_for_high_risk: boolean;
}

export async function fetchRiskPolicy(ownerId: string): Promise<RiskPolicy> {
  const { data, error } = await supabase
    .from('risk_policies')
    .select('liability_limit_cents, high_value_job_cents, high_risk_service_types, require_ack_for_high_risk')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_RISK_POLICY };
  const row = data as PolicyRow;
  return {
    liabilityLimitCents: row.liability_limit_cents != null ? Number(row.liability_limit_cents) : null,
    highValueJobCents: Number(row.high_value_job_cents) || DEFAULT_RISK_POLICY.highValueJobCents,
    highRiskServiceTypes: row.high_risk_service_types ?? [],
    requireAckForHighRisk: !!row.require_ack_for_high_risk,
  };
}

export async function saveRiskPolicy(ownerId: string, p: RiskPolicy): Promise<void> {
  const { error } = await supabase.from('risk_policies').upsert(
    {
      user_id: ownerId,
      liability_limit_cents: p.liabilityLimitCents,
      high_value_job_cents: p.highValueJobCents,
      high_risk_service_types: p.highRiskServiceTypes,
      require_ack_for_high_risk: p.requireAckForHighRisk,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

// ============================================================
// INPUT ASSEMBLY (batched)
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
interface OutcomeRow {
  technician_id: string | null;
  caused_callback: boolean;
  is_rework: boolean;
}
interface CompletedRow {
  assigned_technician_id: string | null;
  service_type: string | null;
}
interface CustomerJobRow {
  id: string;
  customer_id: string | null;
  is_rework: boolean;
}
interface ClaimRow {
  job_id: string | null;
  property_address: string | null;
  status: string;
}
interface JobEquipmentRow {
  job_id: string;
  equipment_id: string;
}
interface EquipmentRow {
  id: string;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  expected_lifespan_years: number | null;
}
interface PartRow {
  job_id: string;
  status: 'needed' | 'allocated' | 'installed' | 'backordered';
}
interface EvidenceRow {
  job_id: string;
  verdict: 'pass' | 'needs_attention' | 'fail';
}
interface WarrantyClaimRow {
  job_id: string | null;
  status: string;
  claim_deadline: string | null;
}

const OPEN_WARRANTY_STATUSES = new Set(['eligible', 'packet_pending', 'submitted']);
const CLOSED_INSURANCE_STATUSES = new Set(['denied', 'closed']);

export interface RiskInputsResult {
  inputs: Map<string, RiskInputs>;
  policy: RiskPolicy;
}

/**
 * Builds engine inputs for a set of jobs owned by one account.
 * A fixed number of queries regardless of how many jobs are passed.
 */
export async function buildRiskInputs(jobs: RiskJob[], ownerId: string, knownPolicy?: RiskPolicy): Promise<RiskInputsResult> {
  const policy = knownPolicy ?? (await fetchRiskPolicy(ownerId));
  const result = new Map<string, RiskInputs>();
  if (jobs.length === 0) return { inputs: result, policy };

  const unavailable = new Set<string>();
  const jobIds = jobs.map((j) => j.id);
  const techIds = uniq(jobs.map((j) => j.assigned_technician_id).filter((x): x is string => !!x));
  const customerIds = uniq(jobs.map((j) => j.customer_id).filter((x): x is string => !!x));

  const [requirements, credentials, outcomes, completed, customerJobs, claims, jobEquipment, parts, evidence, warrantyClaims] =
    await Promise.all([
      rowsIf<RequirementRow>(techIds.length > 0, 'compliance_requirements', unavailable, () =>
        supabase
          .from('compliance_requirements')
          .select('service_type, credential_type, credential_label, is_blocking')
          .eq('user_id', ownerId),
      ),
      rowsIf<CredentialRow>(techIds.length > 0, 'technician_credentials', unavailable, () =>
        supabase
          .from('technician_credentials')
          .select('technician_id, credential_type, status, expires_at')
          .in('technician_id', techIds),
      ),
      rowsIf<OutcomeRow>(techIds.length > 0, 'job_outcomes', unavailable, () =>
        supabase
          .from('job_outcomes')
          .select('technician_id, caused_callback, is_rework')
          .in('technician_id', techIds)
          .gte('recorded_at', isoDaysAgo(180))
          .limit(5000),
      ),
      rowsIf<CompletedRow>(techIds.length > 0, 'jobs', unavailable, () =>
        supabase
          .from('jobs')
          .select('assigned_technician_id, service_type')
          .in('assigned_technician_id', techIds)
          .eq('job_status', 'completed')
          .gte('completed_at', isoDaysAgo(365))
          .limit(5000),
      ),
      rowsIf<CustomerJobRow>(customerIds.length > 0, 'customer_jobs', unavailable, () =>
        supabase
          .from('jobs')
          .select('id, customer_id, is_rework')
          .eq('user_id', ownerId)
          .in('customer_id', customerIds)
          .limit(5000),
      ),
      rowsIf<ClaimRow>(true, 'insurance_claims', unavailable, () =>
        supabase
          .from('insurance_claims')
          .select('job_id, property_address, status')
          .eq('user_id', ownerId)
          .gte('created_at', isoDaysAgo(1095))
          .limit(2000),
      ),
      rowsIf<JobEquipmentRow>(true, 'job_equipment', unavailable, () =>
        supabase.from('job_equipment').select('job_id, equipment_id').in('job_id', jobIds),
      ),
      rowsIf<PartRow>(true, 'job_parts_required', unavailable, () =>
        supabase.from('job_parts_required').select('job_id, status').in('job_id', jobIds),
      ),
      rowsIf<EvidenceRow>(true, 'job_evidence_checks', unavailable, () =>
        supabase
          .from('job_evidence_checks')
          .select('job_id, verdict')
          .in('job_id', jobIds)
          .order('created_at', { ascending: false })
          .limit(2000),
      ),
      rowsIf<WarrantyClaimRow>(true, 'warranty_claims', unavailable, () =>
        supabase.from('warranty_claims').select('job_id, status, claim_deadline').in('job_id', jobIds),
      ),
    ]);

  const equipmentIds = uniq(jobEquipment.map((r) => r.equipment_id));
  const equipmentRows = await rowsIf<EquipmentRow>(equipmentIds.length > 0, 'equipment', unavailable, () =>
    supabase
      .from('equipment')
      .select('id, serial_number, install_date, warranty_expires_at, expected_lifespan_years')
      .in('id', equipmentIds)
      .eq('status', 'active'),
  );

  const equipmentById = new Map(equipmentRows.map((e) => [e.id, e]));
  const equipmentByJob = groupBy(jobEquipment, (r) => r.job_id);
  const partsByJob = groupBy(parts, (r) => r.job_id);
  const credsByTech = groupBy(credentials, (r) => r.technician_id);
  const outcomesByTech = groupBy(outcomes, (r) => r.technician_id);
  const completedByTech = groupBy(completed, (r) => r.assigned_technician_id);
  const customerJobsByCustomer = groupBy(customerJobs, (r) => r.customer_id);
  const claimsByJob = groupBy(claims, (r) => r.job_id);
  const warrantyByJob = groupBy(warrantyClaims, (r) => r.job_id);

  // Latest evidence verdict per job (rows arrive newest-first).
  const evidenceByJob = new Map<string, EvidenceRow['verdict']>();
  for (const e of evidence) if (!evidenceByJob.has(e.job_id)) evidenceByJob.set(e.job_id, e.verdict);

  const claimsByAddress = groupBy(claims, (c) => normAddress(c.property_address) || null);
  const today = todayStr();
  const unavailableList = Array.from(unavailable).sort();

  for (const job of jobs) {
    const commercial = job.customer_type === 'commercial';
    const svc = job.service_type;
    const addrKey = normAddress(job.address);

    // ---- property ----
    const linked = (equipmentByJob.get(job.id) ?? [])
      .map((r) => equipmentById.get(r.equipment_id))
      .filter((e): e is EquipmentRow => !!e);
    const equipmentRisk: EquipmentRisk[] = linked.map((e) => ({
      ageYears: ageYears(e.install_date),
      lifespanYears: e.expected_lifespan_years && e.expected_lifespan_years > 0 ? e.expected_lifespan_years : 15,
    }));
    const addressClaims = addrKey ? (claimsByAddress.get(addrKey) ?? []).filter((c) => c.job_id !== job.id) : [];
    const ownClaims = claimsByJob.get(job.id) ?? [];
    const openClaim =
      ownClaims.some((c) => !CLOSED_INSURANCE_STATUSES.has(c.status)) ||
      addressClaims.some((c) => !CLOSED_INSURANCE_STATUSES.has(c.status));
    const customerReworkCount = job.customer_id
      ? (customerJobsByCustomer.get(job.customer_id) ?? []).filter((r) => r.is_rework && r.id !== job.id).length
      : 0;

    // ---- technician ----
    const techId = job.assigned_technician_id;
    const blockingGaps: string[] = [];
    const advisoryGaps: string[] = [];
    const expiringSoon: { label: string; days: number }[] = [];
    let reworkRatePct: number | null = null;
    let outcomesCount = 0;
    let completedSameService: number | null = null;

    if (techId) {
      const required = svc ? requirements.filter((r) => r.service_type === svc) : [];
      const creds = credsByTech.get(techId) ?? [];
      for (const req of required) {
        const valid = creds.filter(
          (c) => c.credential_type === req.credential_type && c.status === 'active' && (!c.expires_at || c.expires_at >= today),
        );
        const label = req.credential_label || req.credential_type;
        if (valid.length === 0) {
          (req.is_blocking ? blockingGaps : advisoryGaps).push(label);
        } else {
          const withExpiry = valid.filter((c) => c.expires_at).map((c) => daysUntilDate(c.expires_at));
          const soonest = withExpiry.length === valid.length ? Math.max(...(withExpiry as number[])) : null;
          if (soonest !== null && soonest <= 30) expiringSoon.push({ label, days: soonest });
        }
      }
      const techOutcomes = outcomesByTech.get(techId) ?? [];
      outcomesCount = techOutcomes.length;
      if (outcomesCount > 0) {
        reworkRatePct = (techOutcomes.filter((o) => o.caused_callback || o.is_rework).length / outcomesCount) * 100;
      }
      if (unavailable.has('jobs')) {
        completedSameService = null;
      } else {
        const wanted = (svc ?? '').trim().toLowerCase();
        completedSameService = (completedByTech.get(techId) ?? []).filter(
          (r) => (r.service_type ?? '').trim().toLowerCase() === wanted,
        ).length;
      }
    }

    // ---- liability ----
    const amount = job.invoice_amount === null || job.invoice_amount === undefined ? null : Number(job.invoice_amount);
    const valueCents = amount !== null && Number.isFinite(amount) ? Math.round(amount * 100) : null;

    // ---- parts ----
    const jobParts = partsByJob.get(job.id) ?? [];
    const start = job.scheduled_datetime ? Date.parse(job.scheduled_datetime) : NaN;

    // ---- warranty ----
    const withWarranty = linked.filter((e) => !!e.warranty_expires_at);
    const expiryDays = withWarranty.map((e) => daysUntilDate(e.warranty_expires_at)).filter((d): d is number => d !== null);
    const activeDays = expiryDays.filter((d) => d >= 0);
    const relevantEquipment = activeDays.length > 0 ? withWarranty.filter((e) => (daysUntilDate(e.warranty_expires_at) ?? -1) >= 0) : linked;
    const openWarranty = (warrantyByJob.get(job.id) ?? []).find((c) => OPEN_WARRANTY_STATUSES.has(c.status));
    const diagnosis = (job.technician_diagnosis || job.diagnosis_notes || '').trim();

    result.set(job.id, {
      policy,
      property: {
        hasAddress: addrKey.length > 0,
        commercial,
        equipment: equipmentRisk,
        priorClaims36m: addressClaims.length,
        openClaim,
        customerReworkCount,
      },
      technician: {
        assigned: !!techId,
        blockingGaps,
        advisoryGaps,
        expiringSoon,
        reworkRatePct,
        outcomesCount,
        completedSameService,
      },
      liability: {
        hazardTier: hazardTierFor(svc, policy),
        valueCents,
        afterHours: isAfterHours(job.scheduled_datetime),
        commercial,
        hasSla: job.sla_response_hours != null,
      },
      parts: {
        total: jobParts.length,
        backordered: jobParts.filter((p) => p.status === 'backordered').length,
        needed: jobParts.filter((p) => p.status === 'needed').length,
        hoursUntilStart: Number.isNaN(start) ? null : (start - Date.now()) / 3_600_000,
      },
      warranty: {
        warrantyEquipmentCount: withWarranty.length,
        activeWarrantyCount: activeDays.length,
        expiredWarrantyCount: expiryDays.length - activeDays.length,
        soonestExpiryDays: activeDays.length > 0 ? Math.min(...activeDays) : null,
        docs: {
          serialOnFile: relevantEquipment.length > 0 && relevantEquipment.every((e) => !!e.serial_number?.trim()),
          installDateOnFile: relevantEquipment.length > 0 && relevantEquipment.every((e) => !!e.install_date),
          diagnosisNotes: diagnosis.length >= 20,
          beforePhotos: Array.isArray(job.before_photos) ? job.before_photos.length : 0,
          evidenceVerdict: evidenceByJob.get(job.id) ?? null,
        },
        claim: openWarranty ? { deadlineDays: daysUntilDate(openWarranty.claim_deadline) } : null,
      },
      unavailableSources: unavailableList,
    });
  }

  return { inputs: result, policy };
}

// ============================================================
// AUDIT TRAIL
// ============================================================

export interface StoredAssessment {
  id: string;
  created_at: string;
  overall_score: number;
  overall_level: RiskLevel;
  coverage_decision: CoverageDecision;
  requires_ack: boolean;
  signature: string;
}

export interface StoredAcknowledgement {
  id: string;
  assessment_id: string;
  acknowledged_by: string;
  reason: string;
  created_at: string;
}

export async function recordAssessment(
  ownerId: string,
  jobId: string,
  technicianId: string | null,
  report: RiskReport,
): Promise<string> {
  const d = report.dimensions;
  const { data, error } = await supabase
    .from('job_risk_assessments')
    .insert({
      user_id: ownerId,
      job_id: jobId,
      technician_id: technicianId,
      engine_version: report.engineVersion,
      overall_score: report.overallScore,
      overall_level: report.overallLevel,
      property_score: d.property.score,
      property_level: d.property.level,
      technician_score: d.technician.score,
      technician_level: d.technician.level,
      liability_score: d.liability.score,
      liability_level: d.liability.level,
      parts_score: d.parts.score,
      parts_level: d.parts.level,
      warranty_score: d.warranty.score,
      warranty_level: d.warranty.level,
      coverage_decision: report.coverage.decision,
      requires_ack: report.coverage.requiresAck,
      data_coverage: report.dataCoverage,
      flags: report.flags,
      coverage_reasons: report.coverage.reasons,
      signature: report.signature,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function fetchAssessmentHistory(jobId: string, limit = 10): Promise<StoredAssessment[]> {
  const { data, error } = await supabase
    .from('job_risk_assessments')
    .select('id, created_at, overall_score, overall_level, coverage_decision, requires_ack, signature')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as StoredAssessment[] | null) ?? [];
}

export async function fetchAcknowledgements(jobId: string): Promise<StoredAcknowledgement[]> {
  const { data, error } = await supabase
    .from('job_risk_acknowledgements')
    .select('id, assessment_id, acknowledged_by, reason, created_at')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as StoredAcknowledgement[] | null) ?? [];
}

export async function acknowledgeAssessment(
  ownerId: string,
  userId: string,
  jobId: string,
  assessmentId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.from('job_risk_acknowledgements').insert({
    user_id: ownerId,
    job_id: jobId,
    assessment_id: assessmentId,
    acknowledged_by: userId,
    reason: reason.trim(),
  });
  if (error) throw error;
}

// ============================================================
// ERROR PARSING — trigger raises "JOB_RISK_ACK_REQUIRED: ..."
// ============================================================

const ACK_ERROR_PREFIX = 'JOB_RISK_ACK_REQUIRED:';

export function isRiskAckError(message: string | undefined | null): boolean {
  return !!message && message.includes(ACK_ERROR_PREFIX);
}

export function parseRiskAckError(message: string): string {
  const idx = message.indexOf(ACK_ERROR_PREFIX);
  return idx === -1 ? message : message.slice(idx + ACK_ERROR_PREFIX.length).trim();
}
