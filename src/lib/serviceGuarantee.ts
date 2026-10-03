/**
 * Vireek Verified Service — Service Outcome Guarantee (post-completion).
 *
 * Outcome Assurance (outcomeAssurance.ts) predicts BEFORE dispatch. This module
 * answers the question that matters commercially AFTER the visit:
 * "Was the problem actually solved?"
 *
 *   completed -> 48h -> 7 days -> 30 days -> Verified
 *                          |
 *                  failure detected / reported
 *                          |
 *   warranty + parts check -> root cause -> best technician -> owner approves
 *   -> recovery visit -> Recovered
 *
 * Design rules:
 *  - Everything above the "DATA LAYER" banner is pure and deterministic.
 *  - A checkpoint passes only with evidence, and the two kinds are never merged:
 *    `customer_confirmed` (the customer said "solved") vs `no_failure_signal`
 *    (asked, silent, and no rework / dispute / low rating exists).
 *  - Recovery technician ranking REUSES the Outcome Assurance engine on a
 *    synthetic rework job, so there is one model of "who should take this job".
 *  - Nothing is re-dispatched automatically: the owner approves.
 *
 * Server counterpart: supabase/migrations/20270205000000_service_outcome_guarantee.sql
 */

import { supabase } from '@/lib/supabase';
import {
  DEFAULT_SETTINGS as ASSURANCE_DEFAULTS,
  evaluateJob,
  type AssuranceContext,
  type AssuranceJob,
  type AssuranceSettings,
} from '@/lib/outcomeAssurance';

// ============================================================
// TYPES
// ============================================================

export type GuaranteeStatus = 'verifying' | 'verified' | 'claim_open' | 'recovering' | 'recovered' | 'expired' | 'voided';
export type EvidenceLevel = 'none' | 'no_failure_signal' | 'customer_confirmed';
export type CheckpointStage = 'h48' | 'd7' | 'd30';
export type CheckpointStatus = 'pending' | 'passed' | 'failed' | 'voided';
export type CheckpointEvidence = 'customer_confirmed' | 'no_failure_signal' | 'failure_reported';
export type ClaimSource = 'customer' | 'staff' | 'callback_job' | 'dispute' | 'low_rating';
export type ClaimStatus = 'open' | 'redispatched' | 'resolved' | 'rejected';

export interface GuaranteeSettings {
  enabled: boolean;
  coverage_days: number;
  notify_customer: boolean;
  notify_owner_on_failure: boolean;
}

export interface GuaranteeRow {
  id: string;
  job_id: string;
  technician_id: string | null;
  customer_name: string;
  service_type: string | null;
  status: GuaranteeStatus;
  evidence_level: EvidenceLevel;
  started_at: string;
  expires_at: string;
  verified_at: string | null;
  last_checkpoint: CheckpointStage | null;
  recovered_by_job_id: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface CheckpointRow {
  id: string;
  guarantee_id: string;
  stage: CheckpointStage;
  due_at: string;
  status: CheckpointStatus;
  evidence: CheckpointEvidence | null;
  prompted_at: string | null;
  customer_response: 'solved' | 'not_solved' | null;
  checked_at: string | null;
}

export interface EquipmentWarranty {
  id: string;
  type: string;
  make: string | null;
  model: string | null;
  warranty_expires_at: string | null;
  in_warranty: boolean;
}

export interface WarrantyCheck {
  workmanship_days_left?: number;
  manufacturer_claims?: number;
  equipment?: EquipmentWarranty[];
}

export interface PartsCheck {
  parts_used?: string[];
  resolution?: string;
}

export interface ClaimRow {
  id: string;
  guarantee_id: string;
  job_id: string;
  source: ClaimSource;
  description: string | null;
  status: ClaimStatus;
  warranty_check: WarrantyCheck;
  parts_check: PartsCheck;
  root_cause_key: string | null;
  proposed_technician_id: string | null;
  redispatch_job_id: string | null;
  resolution_note: string | null;
  escalated_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface GuaranteeEventRow {
  id: string;
  guarantee_id: string;
  event_type: string;
  detail: string | null;
  actor_type: 'system' | 'customer' | 'staff';
  created_at: string;
}

export interface PublicGuarantee {
  business_name: string | null;
  service_type: string | null;
  technician_name: string | null;
  status: GuaranteeStatus;
  evidence_level: EvidenceLevel;
  started_at: string;
  expires_at: string;
  verified_at: string | null;
  can_report: boolean;
  awaiting_stage: CheckpointStage | null;
  checkpoints: Array<{ stage: CheckpointStage; due_at: string; status: CheckpointStatus; evidence: CheckpointEvidence | null }>;
}

// ============================================================
// LABELS & CONSTANTS
// ============================================================

export const DEFAULT_GUARANTEE_SETTINGS: GuaranteeSettings = {
  enabled: false,
  coverage_days: 30,
  notify_customer: true,
  notify_owner_on_failure: true,
};

export const COVERAGE_LIMITS = { min: 30, max: 365 } as const;

export const STAGES: CheckpointStage[] = ['h48', 'd7', 'd30'];

export const STAGE_LABELS: Record<CheckpointStage, string> = {
  h48: '48 hours',
  d7: '7 days',
  d30: '30 days',
};

export const STATUS_LABELS: Record<GuaranteeStatus, string> = {
  verifying: 'Verifying',
  verified: 'Verified',
  claim_open: 'Claim open',
  recovering: 'Recovery scheduled',
  recovered: 'Recovered',
  expired: 'Completed',
  voided: 'Voided',
};

export const STATUS_COLORS: Record<GuaranteeStatus, string> = {
  verifying: 'bg-accent/10 text-accent',
  verified: 'bg-success-500/10 text-success-500',
  claim_open: 'bg-danger/10 text-danger',
  recovering: 'bg-warning-500/10 text-warning-500',
  recovered: 'bg-success-500/10 text-success-500',
  expired: 'bg-bg-tertiary text-text-secondary',
  voided: 'bg-bg-tertiary text-text-secondary',
};

export const EVIDENCE_LABELS: Record<EvidenceLevel, string> = {
  none: 'No evidence yet',
  no_failure_signal: 'No issue reported',
  customer_confirmed: 'Customer-confirmed',
};

export const CLAIM_SOURCE_LABELS: Record<ClaimSource, string> = {
  customer: 'Reported by the customer',
  staff: 'Reported by staff',
  callback_job: 'A rework visit was booked',
  dispute: 'Job flagged as disputed',
  low_rating: 'Low customer rating',
};

export const EVENT_LABELS: Record<string, string> = {
  created: 'Guarantee started',
  checkpoint_prompted: 'Customer asked to confirm',
  checkpoint_passed: 'Checkpoint passed',
  checkpoint_failed: 'Checkpoint failed',
  claim_opened: 'Failure reported',
  warranty_checked: 'Warranty and parts checked',
  claim_escalated: 'Claim escalated',
  redispatch_created: 'Recovery visit scheduled',
  claim_rejected: 'Claim not covered',
  claim_resolved: 'Claim resolved',
  recovered: 'Recovered',
  verified: 'Outcome verified',
  expired: 'Coverage completed',
  voided: 'Guarantee voided',
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Statuses in which the guarantee still needs attention from the business. */
export const NEEDS_ACTION: ReadonlySet<GuaranteeStatus> = new Set(['claim_open']);
export const LIVE_STATUSES: ReadonlySet<GuaranteeStatus> = new Set(['verifying', 'verified', 'claim_open', 'recovering']);

// ============================================================
// PURE HELPERS
// ============================================================

const round1 = (n: number) => Math.round(n * 10) / 10;

export function clampCoverageDays(n: number): number {
  if (!Number.isFinite(n)) return COVERAGE_LIMITS.min;
  return Math.min(COVERAGE_LIMITS.max, Math.max(COVERAGE_LIMITS.min, Math.round(n)));
}

export function daysLeft(expiresAt: string, now: number): number {
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / DAY_MS));
}

export function claimAgeHours(createdAt: string, now: number): number {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / HOUR_MS));
}

/** The checkpoint the system is currently working toward (earliest pending). */
export function nextCheckpoint(checkpoints: CheckpointRow[]): CheckpointRow | null {
  const pending = checkpoints.filter((c) => c.status === 'pending').sort((a, b) => a.due_at.localeCompare(b.due_at));
  return pending[0] ?? null;
}

/** 0-100: share of checkpoints already passed. Voided checkpoints are excluded from the denominator. */
export function verificationProgress(checkpoints: CheckpointRow[]): number {
  const live = checkpoints.filter((c) => c.status !== 'voided');
  if (live.length === 0) return 0;
  return Math.round((live.filter((c) => c.status === 'passed').length / live.length) * 100);
}

/** Human line for the next step of a guarantee. */
export function nextStepLabel(g: GuaranteeRow, checkpoints: CheckpointRow[], now: number): string {
  switch (g.status) {
    case 'claim_open':
      return 'Waiting for you to approve a recovery visit';
    case 'recovering':
      return 'Recovery visit scheduled';
    case 'recovered':
      return 'Fixed by a recovery visit';
    case 'voided':
      return g.void_reason ? `Voided: ${g.void_reason}` : 'Voided';
    case 'expired':
      return 'Coverage period ended with the outcome verified';
    case 'verified':
      return `Verified · covered for ${daysLeft(g.expires_at, now)} more day${daysLeft(g.expires_at, now) === 1 ? '' : 's'}`;
    default: {
      const next = nextCheckpoint(checkpoints);
      if (!next) return 'Verifying';
      const due = new Date(next.due_at).getTime();
      if (due <= now) return next.prompted_at ? `${STAGE_LABELS[next.stage]} check · waiting for the customer` : `${STAGE_LABELS[next.stage]} check · running now`;
      const hours = Math.max(1, Math.round((due - now) / HOUR_MS));
      return hours < 48 ? `${STAGE_LABELS[next.stage]} check in ${hours} h` : `${STAGE_LABELS[next.stage]} check in ${Math.round(hours / 24)} days`;
    }
  }
}

export interface GuaranteeSummary {
  total: number;
  verifying: number;
  verified: number;
  openClaims: number;
  recovering: number;
  recovered: number;
  /**
   * Of guarantees whose outcome is decided (verified / completed / recovered / claim),
   * the share that held WITHOUT needing a recovery. null until at least 1 is decided.
   */
  holdRate: number | null;
  /** Of claims that were closed by a recovery, the share ending in Recovered. null when no claims. */
  recoveryRate: number | null;
  /** Median hours from claim opened to claim closed. null when none closed. */
  medianRecoveryHours: number | null;
  /** Share of decided guarantees that were customer-confirmed (stronger evidence). */
  confirmedShare: number | null;
}

export function summarizeGuarantees(guarantees: GuaranteeRow[], claims: ClaimRow[]): GuaranteeSummary {
  const by = (s: GuaranteeStatus) => guarantees.filter((g) => g.status === s).length;
  const held = guarantees.filter((g) => g.status === 'verified' || g.status === 'expired');
  const failed = guarantees.filter((g) => g.status === 'claim_open' || g.status === 'recovering' || g.status === 'recovered');
  const decided = held.length + failed.length;

  const closed = claims.filter((c) => c.status === 'resolved' && c.resolved_at);
  const durations = closed
    .map((c) => (new Date(c.resolved_at as string).getTime() - new Date(c.created_at).getTime()) / HOUR_MS)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length === 0 ? null : durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;

  const handled = claims.filter((c) => c.status !== 'rejected');
  const confirmed = held.filter((g) => g.evidence_level === 'customer_confirmed').length;

  return {
    total: guarantees.length,
    verifying: by('verifying'),
    verified: by('verified'),
    openClaims: claims.filter((c) => c.status === 'open').length,
    recovering: by('recovering'),
    recovered: by('recovered'),
    holdRate: decided === 0 ? null : round1((held.length / decided) * 100),
    recoveryRate: handled.length === 0 ? null : round1((handled.filter((c) => c.status === 'resolved').length / handled.length) * 100),
    medianRecoveryHours: median === null ? null : round1(median),
    confirmedShare: held.length === 0 ? null : round1((confirmed / held.length) * 100),
  };
}

// ============================================================
// RECOVERY PLANNING (reuses the Outcome Assurance engine)
// ============================================================

export interface RecoveryCandidate {
  technicianId: string;
  technicianName: string;
  probability: number;
  isOriginal: boolean;
  /** Plain-language reasons the model is not fully confident (credentials, capacity, history...). */
  concerns: string[];
}

/**
 * Ranks technicians for a recovery visit by running the Outcome Assurance model on a
 * synthetic rework job. Technicians with a blocking compliance gap are excluded.
 */
export function rankRecoveryTechnicians(
  ctx: AssuranceContext,
  original: { customer_name: string; service_type: string | null; duration_minutes: number | null; technician_id: string | null },
  scheduledAt: string,
  settings: AssuranceSettings = ASSURANCE_DEFAULTS,
  limit = 3,
): RecoveryCandidate[] {
  const synthetic: AssuranceJob = {
    id: 'guarantee-recovery',
    customer_name: original.customer_name,
    service_type: original.service_type,
    scheduled_datetime: scheduledAt,
    duration_minutes: original.duration_minutes,
    assigned_technician_id: null,
    job_status: 'scheduled',
    customer_type: null,
    sla_response_hours: null,
    is_rework: true,
    diagnosis_notes: null,
  };

  const out: RecoveryCandidate[] = [];
  for (const t of ctx.technicians) {
    if (!t.dispatch_enabled) continue;
    const r = evaluateJob(synthetic, ctx, settings, { technicianId: t.id, skipInterventions: true });
    if (r.blockers.length > 0) continue;
    const tf = r.factors.find((f) => f.key === 'technician');
    out.push({
      technicianId: t.id,
      technicianName: t.name,
      probability: r.probability,
      isOriginal: t.id === original.technician_id,
      concerns: tf?.issues ?? [],
    });
  }
  return out.sort((a, b) => b.probability - a.probability).slice(0, Math.max(1, limit));
}

// ============================================================
// DATA LAYER
// ============================================================

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function fetchGuaranteeSettings(): Promise<GuaranteeSettings> {
  try {
    const { data, error } = await supabase
      .from('service_guarantee_settings')
      .select('enabled, coverage_days, notify_customer, notify_owner_on_failure')
      .maybeSingle();
    if (error || !data) return DEFAULT_GUARANTEE_SETTINGS;
    return data as GuaranteeSettings;
  } catch {
    return DEFAULT_GUARANTEE_SETTINGS;
  }
}

export async function saveGuaranteeSettings(s: GuaranteeSettings): Promise<void> {
  const { error } = await supabase.rpc('save_service_guarantee_settings', {
    p_enabled: s.enabled,
    p_coverage_days: clampCoverageDays(s.coverage_days),
    p_notify_customer: s.notify_customer,
    p_notify_owner: s.notify_owner_on_failure,
  });
  if (error) throw error;
}

export interface GuaranteeBundle {
  guarantees: GuaranteeRow[];
  checkpoints: CheckpointRow[];
  claims: ClaimRow[];
}

/** Throws when the guarantees table is unreachable (page shows an error state); child tables fail soft. */
export async function fetchGuaranteeBundle(limit = 300): Promise<GuaranteeBundle> {
  const { data, error } = await supabase
    .from('service_guarantees')
    .select(
      'id, job_id, technician_id, customer_name, service_type, status, evidence_level, started_at, expires_at, verified_at, last_checkpoint, recovered_by_job_id, void_reason, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const guarantees = (data ?? []) as GuaranteeRow[];
  const ids = guarantees.map((g) => g.id);

  const cpParts = await Promise.all(
    chunk(ids, 100).map(async (g) => {
      const res = await supabase
        .from('service_guarantee_checkpoints')
        .select('id, guarantee_id, stage, due_at, status, evidence, prompted_at, customer_response, checked_at')
        .in('guarantee_id', g);
      return res.error ? [] : ((res.data ?? []) as CheckpointRow[]);
    }),
  );

  const claimsRes = await supabase
    .from('service_guarantee_claims')
    .select(
      'id, guarantee_id, job_id, source, description, status, warranty_check, parts_check, root_cause_key, proposed_technician_id, redispatch_job_id, resolution_note, escalated_at, created_at, resolved_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  return {
    guarantees,
    checkpoints: cpParts.flat(),
    claims: claimsRes.error ? [] : ((claimsRes.data ?? []) as ClaimRow[]),
  };
}

export async function fetchGuaranteeEvents(guaranteeId: string, limit = 40): Promise<GuaranteeEventRow[]> {
  const { data, error } = await supabase
    .from('service_guarantee_events')
    .select('id, guarantee_id, event_type, detail, actor_type, created_at')
    .eq('guarantee_id', guaranteeId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as GuaranteeEventRow[];
}

/** The original job's duration, needed to rank technicians for the recovery visit. */
export async function fetchJobDuration(jobId: string): Promise<number | null> {
  const { data } = await supabase.from('jobs').select('duration_minutes').eq('id', jobId).maybeSingle();
  const d = (data as { duration_minutes?: unknown } | null)?.duration_minutes;
  return typeof d === 'number' ? d : null;
}

/** id -> display name for every team member of the account (used to label technicians). */
export async function fetchTeamNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const { data, error } = await supabase.from('team_members').select('id, member_name, member_email');
  if (error) return names;
  for (const m of (data ?? []) as Array<{ id: string; member_name: string | null; member_email: string | null }>) {
    names.set(m.id, m.member_name || m.member_email || 'Technician');
  }
  return names;
}

/** Customer-facing link token (jobs.reschedule_token), used to copy the guarantee link. */
export async function fetchJobToken(jobId: string): Promise<string | null> {
  const { data } = await supabase.from('jobs').select('reschedule_token').eq('id', jobId).maybeSingle();
  const t = (data as { reschedule_token?: unknown } | null)?.reschedule_token;
  return typeof t === 'string' ? t : null;
}

export async function createRedispatch(params: { claimId: string; technicianId: string; scheduledAt: string; note?: string }): Promise<string> {
  const { data, error } = await supabase.rpc('create_guarantee_redispatch', {
    p_claim_id: params.claimId,
    p_technician_id: params.technicianId,
    p_scheduled_at: params.scheduledAt,
    p_note: params.note?.trim() || null,
  });
  if (error) throw error;
  return String(data);
}

export async function resolveClaim(claimId: string, resolution: 'rejected' | 'resolved', note: string): Promise<void> {
  const { error } = await supabase.rpc('resolve_guarantee_claim', { p_claim_id: claimId, p_resolution: resolution, p_note: note });
  if (error) throw error;
}

export async function voidGuarantee(guaranteeId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_service_guarantee', { p_guarantee_id: guaranteeId, p_reason: reason });
  if (error) throw error;
}

export async function openStaffClaim(guaranteeId: string, description: string): Promise<void> {
  const { error } = await supabase.rpc('open_staff_guarantee_claim', { p_guarantee_id: guaranteeId, p_description: description });
  if (error) throw error;
}

// ---------- customer (token-gated) ----------

export async function fetchPublicGuarantee(token: string): Promise<PublicGuarantee | null> {
  const { data, error } = await supabase.rpc('get_public_service_guarantee', { p_token: token });
  if (error || !data) return null;
  return data as PublicGuarantee;
}

export type CustomerActionResult = { ok: true; result?: string } | { ok: false; reason: string };

export async function respondToCheckpoint(token: string, stage: CheckpointStage, solved: boolean, note?: string): Promise<CustomerActionResult> {
  const { data, error } = await supabase.rpc('respond_service_guarantee_checkpoint', {
    p_token: token,
    p_stage: stage,
    p_solved: solved,
    p_note: note?.trim() || null,
  });
  if (error || !data) return { ok: false, reason: 'error' };
  return data as CustomerActionResult;
}

export async function reportIssue(token: string, description: string): Promise<CustomerActionResult> {
  const { data, error } = await supabase.rpc('report_service_guarantee_issue', { p_token: token, p_description: description });
  if (error || !data) return { ok: false, reason: 'error' };
  return data as CustomerActionResult;
}

export function getPublicGuaranteeLink(token: string): string {
  return `${window.location.origin}/guarantee/${token}`;
}
