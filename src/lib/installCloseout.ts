/**
 * Install Closeout Autopilot - client domain logic.
 *
 * permit -> inspection -> warranty registration -> rebate claim -> customer documents -> done
 *
 * Pure functions here MIRROR the database (state machine, escalation levels,
 * dependencies, pre-approval gate). The database is the authority; this module
 * powers the UI and is unit-tested.
 *
 * Server counterpart: supabase/migrations/20271201000000_install_closeout_autopilot.sql
 *
 * Safety: Vireek never submits anything to a manufacturer, utility or government
 * portal. "submitted" only records that an owner/office human did it.
 */

import { supabase } from '@/lib/supabase';

export type StepKind = 'permit' | 'inspection' | 'warranty' | 'rebate' | 'documents';
export type StepStatus =
  | 'not_started'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_approval'
  | 'submitted'
  | 'done'
  | 'waived'
  | 'missed';
export type OwnerRole = 'technician' | 'office' | 'owner';
export type PreApprovalStatus = 'not_required' | 'pending' | 'approved' | 'denied';
export type RiskLevel = 'none' | 'resolved' | 'low' | 'medium' | 'high' | 'critical' | 'overdue';

export const STEP_KINDS: StepKind[] = ['permit', 'inspection', 'warranty', 'rebate', 'documents'];

export const STEP_LABELS: Record<StepKind, string> = {
  permit: 'Permit',
  inspection: 'Inspection',
  warranty: 'Warranty registration',
  rebate: 'Rebate claim',
  documents: 'Customer documents',
};

export const STATUS_LABELS: Record<StepStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval',
  submitted: 'Submitted',
  done: 'Done',
  waived: 'Waived',
  missed: 'Deadline missed',
};

export const OWNER_LABELS: Record<OwnerRole, string> = {
  technician: 'Technician',
  office: 'Office',
  owner: 'Owner',
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  none: 'No deadline',
  resolved: 'Resolved',
  low: 'On track',
  medium: 'Due within 14 days',
  high: 'Due within 7 days',
  critical: 'Due within 3 days',
  overdue: 'Overdue',
};

/** Tailwind classes per risk level (semantic tokens only). */
export const RISK_BADGE: Record<RiskLevel, string> = {
  overdue: 'bg-danger/15 text-danger',
  critical: 'bg-danger/15 text-danger',
  high: 'bg-warning-500/15 text-warning-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
  none: 'bg-bg-tertiary text-text-secondary',
  resolved: 'bg-success/15 text-success',
};

export const EVIDENCE_LABELS: Record<string, string> = {
  serial_number: 'Serial number',
  model_number: 'Model number',
  install_date: 'Install date',
  photos: 'Job photos',
  permit_number: 'Permit number',
  inspection_pass: 'Passed inspection',
  ahri_certificate: 'AHRI certificate',
  invoice: 'Invoice',
  customer_signature: 'Customer signature',
  proof_of_purchase: 'Proof of purchase',
  rebate_preapproval: 'Rebate pre-approval',
  contractor_enrollment: 'Contractor enrollment',
};

export const MANUAL_EVIDENCE_KEYS = ['ahri_certificate', 'customer_signature', 'proof_of_purchase', 'contractor_enrollment'] as const;
export const ALL_EVIDENCE_KEYS = Object.keys(EVIDENCE_LABELS);

/** Rule data older than this is flagged "re-verify". */
export const RULE_STALE_DAYS = 180;

// ---------------------------------------------------------------------------
// Dates (UTC day math on YYYY-MM-DD, so timezones never shift a deadline)
// ---------------------------------------------------------------------------

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
}

/** Whole days from `today` to `deadline` (negative = overdue). Null when no deadline. */
export function daysUntil(deadline: string | null | undefined, today: string = todayISO()): number | null {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}/.test(deadline)) return null;
  return dayNumber(deadline) - dayNumber(today);
}

// ---------------------------------------------------------------------------
// Escalation + risk
// ---------------------------------------------------------------------------

/** 0 none, 1 technician (<=14d), 2 office (<=7d), 3 owner (<=3d or overdue). */
export function escalationLevel(daysLeft: number | null): 0 | 1 | 2 | 3 {
  if (daysLeft === null) return 0;
  if (daysLeft <= 3) return 3;
  if (daysLeft <= 7) return 2;
  if (daysLeft <= 14) return 1;
  return 0;
}

export function escalationTarget(level: number): OwnerRole | null {
  return level === 1 ? 'technician' : level === 2 ? 'office' : level >= 3 ? 'owner' : null;
}

const CLOSED: StepStatus[] = ['done', 'waived'];
const OPEN: StepStatus[] = ['not_started', 'in_progress', 'blocked', 'awaiting_approval', 'missed'];

export function isOpenStep(status: StepStatus): boolean {
  return OPEN.includes(status);
}

export interface RiskInput {
  status: StepStatus;
  deadline: string | null;
}

export function deadlineRisk(step: RiskInput, today: string = todayISO()): RiskLevel {
  if (CLOSED.includes(step.status)) return 'resolved';
  if (step.status === 'missed') return 'overdue';
  if (step.status === 'submitted') return 'low';
  const d = daysUntil(step.deadline, today);
  if (d === null) return 'none';
  if (d < 0) return 'overdue';
  if (d <= 3) return 'critical';
  if (d <= 7) return 'high';
  if (d <= 14) return 'medium';
  return 'low';
}

const RISK_ORDER: Record<RiskLevel, number> = { overdue: 0, critical: 1, high: 2, medium: 3, low: 4, none: 5, resolved: 6 };
export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

// ---------------------------------------------------------------------------
// State machine (mirror of closeout_step_transition_allowed)
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  not_started: ['in_progress', 'blocked', 'waived'],
  in_progress: ['not_started', 'blocked', 'awaiting_approval', 'waived'],
  blocked: ['in_progress', 'waived'],
  awaiting_approval: ['in_progress', 'submitted', 'waived'],
  submitted: ['done', 'in_progress'],
  done: [],
  waived: [],
  missed: ['in_progress', 'submitted', 'waived'],
};

export function transitionAllowed(from: StepStatus, to: StepStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: StepStatus): StepStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** Moves only owner/office may make (the DB enforces it too). */
export function requiresApprover(to: StepStatus): boolean {
  return to === 'submitted' || to === 'done' || to === 'waived';
}

export interface StepLite {
  step_kind: StepKind;
  status: StepStatus;
}

/** The step that must be finished first, or null. Mirrors the DB dependency rules. */
export function blockingDependency(kind: StepKind, steps: StepLite[]): StepKind | null {
  const closed = (k: StepKind) => {
    const s = steps.find((x) => x.step_kind === k);
    return !!s && CLOSED.includes(s.status);
  };
  if (kind === 'inspection') return closed('permit') ? null : 'permit';
  if (kind === 'rebate') return closed('inspection') ? null : 'inspection';
  if (kind === 'documents') {
    return STEP_KINDS.filter((k) => k !== 'documents').find((k) => !closed(k)) ?? null;
  }
  return null;
}

export interface SubmitCheck {
  ok: boolean;
  reason: string | null;
}

/** Everything that must be true before a human may approve + submit a step. */
export function canSubmitStep(
  step: { step_kind: StepKind; status: StepStatus; missing_evidence: string[]; pre_approval_required: boolean; pre_approval_status: PreApprovalStatus },
  allSteps: StepLite[],
): SubmitCheck {
  if (!transitionAllowed(step.status, 'submitted')) {
    return { ok: false, reason: `A step that is "${STATUS_LABELS[step.status]}" cannot be submitted yet.` };
  }
  if (step.missing_evidence.length > 0) {
    return { ok: false, reason: `Missing evidence: ${step.missing_evidence.map(evidenceLabel).join(', ')}.` };
  }
  const dep = blockingDependency(step.step_kind, allSteps);
  if (dep) return { ok: false, reason: `Finish "${STEP_LABELS[dep]}" first.` };
  if (step.pre_approval_required && step.pre_approval_status !== 'approved') {
    return { ok: false, reason: 'The program pre-approval has not been approved.' };
  }
  return { ok: true, reason: null };
}

export interface JobStartCheck {
  blocked: boolean;
  reason: string | null;
}

/** Rebate pre-approval gate: block job start until the reservation is approved (or the step is waived). */
export function jobStartBlock(
  steps: { step_kind: StepKind; status: StepStatus; pre_approval_required: boolean; pre_approval_status: PreApprovalStatus }[],
): JobStartCheck {
  const gate = steps.find(
    (s) =>
      s.step_kind === 'rebate' &&
      s.pre_approval_required &&
      s.pre_approval_status !== 'approved' &&
      !CLOSED.includes(s.status),
  );
  if (!gate) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason:
      gate.pre_approval_status === 'denied'
        ? 'The rebate pre-approval was denied. Waive the rebate step (owner/office) before starting the job.'
        : 'A rebate program requires pre-approval BEFORE work starts. Get the reservation approved first.',
  };
}

// ---------------------------------------------------------------------------
// Money (always an ESTIMATE)
// ---------------------------------------------------------------------------

export function moneyAtRisk(
  steps: { status: StepStatus; deadline: string | null; estimated_value_cents: number }[],
  today: string = todayISO(),
  windowDays = 14,
): number {
  return steps.reduce((sum, s) => {
    if (!isOpenStep(s.status)) return sum;
    if (s.status === 'missed') return sum + s.estimated_value_cents;
    const d = daysUntil(s.deadline, today);
    return d !== null && d <= windowDays ? sum + s.estimated_value_cents : sum;
  }, 0);
}

export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  const v = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `$${Math.round(v)}`;
  }
}

// ---------------------------------------------------------------------------
// Rules: source + freshness + honest eligibility wording
// ---------------------------------------------------------------------------

export type RuleFreshness = 'unverified' | 'stale' | 'fresh';

export function ruleFreshness(lastVerified: string | null | undefined, today: string = todayISO()): RuleFreshness {
  if (!lastVerified) return 'unverified';
  const age = (daysUntil(today, lastVerified) ?? 0) * -1;
  return age > RULE_STALE_DAYS ? 'stale' : 'fresh';
}

/** Never claims eligibility. Always points at the source. */
export function eligibilityCopy(sourceUrl: string | null | undefined): string {
  return sourceUrl ? 'Likely eligible - verify with the program source.' : 'Possibly eligible - no source on file, verify before promising anything.';
}

export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function evidenceLabel(key: string): string {
  return EVIDENCE_LABELS[key] ?? key;
}

// ---------------------------------------------------------------------------
// Errors from the database -> plain language
// ---------------------------------------------------------------------------

export function friendlyCloseoutError(message: string | null | undefined): string {
  const m = message ?? '';
  if (m.includes('CLOSEOUT_PREAPPROVAL_REQUIRED')) {
    return 'This rebate program requires pre-approval before work starts. Approve the reservation, or have the owner/office waive the rebate step.';
  }
  if (m.includes('CLOSEOUT_EVIDENCE_MISSING')) {
    const keys = m.split('CLOSEOUT_EVIDENCE_MISSING:')[1]?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];
    return keys.length ? `Missing evidence: ${keys.map(evidenceLabel).join(', ')}.` : 'Some required evidence is missing.';
  }
  if (m.includes('CLOSEOUT_DEPENDENCY')) return m.split('CLOSEOUT_DEPENDENCY:')[1]?.trim() || 'An earlier step must be finished first.';
  if (m.includes('CLOSEOUT_FORBIDDEN')) return 'Only the owner or office can submit, complete or waive a step.';
  if (m.includes('CLOSEOUT_NOTE_REQUIRED')) return m.split('CLOSEOUT_NOTE_REQUIRED:')[1]?.trim() || 'A note is required.';
  if (m.includes('CLOSEOUT_TRANSITION')) return 'That status change is not allowed from the current status.';
  if (m.includes('CLOSEOUT_INACTIVE')) return 'This closeout is no longer active.';
  return m || 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Types returned by the RPCs
// ---------------------------------------------------------------------------

export interface BoardRow {
  step_id: string;
  closeout_id: string;
  job_id: string;
  customer_name: string | null;
  address: string | null;
  service_type: string | null;
  job_status: string;
  install_date: string | null;
  step_kind: StepKind;
  status: StepStatus;
  owner_role: OwnerRole;
  deadline: string | null;
  days_left: number | null;
  escalation_level: number;
  estimated_value_cents: number;
  pre_approval_required: boolean;
  pre_approval_status: PreApprovalStatus;
  missing_evidence: string[];
  source_url: string | null;
  rule_name: string | null;
  rule_verified_at: string | null;
}

export interface EvidenceItem {
  key: string;
  present: boolean;
  manual: boolean;
  ref: string | null;
}

export interface StepDetail {
  id: string;
  closeout_id: string;
  step_kind: StepKind;
  position: number;
  status: StepStatus;
  owner_role: OwnerRole;
  deadline: string | null;
  days_left: number | null;
  estimated_value_cents: number;
  pre_approval_required: boolean;
  pre_approval_status: PreApprovalStatus;
  reference_number: string | null;
  rule_name: string | null;
  source_url: string | null;
  rule_verified_at: string | null;
  waive_reason: string | null;
  notes: string | null;
  evidence: EvidenceItem[];
}

export interface CloseoutEvent {
  id: string;
  step_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
}

export interface JobCloseout {
  closeout: { id: string; job_id: string; status: 'active' | 'done' | 'cancelled'; install_date: string | null };
  steps: StepDetail[];
  events: CloseoutEvent[];
}

export interface MonthSummary {
  month: string;
  recovered_cents: number;
  protected_cents: number;
  lost_cents: number;
  missed_steps: number;
}

export interface CloseoutSummary {
  months: MonthSummary[];
  at_risk_cents: number;
  at_risk_steps: number;
  overdue_steps: number;
}

export interface CloseoutRule {
  id: string;
  step_kind: StepKind;
  name: string;
  equipment_type: string | null;
  manufacturer: string | null;
  deadline_days: number | null;
  required_evidence: string[];
  requires_pre_approval: boolean;
  requires_contractor_enrollment: boolean;
  default_owner_role: OwnerRole;
  estimated_value_cents: number | null;
  source_url: string | null;
  last_verified_at: string | null;
  notes: string | null;
  is_active: boolean;
}

export type RuleInput = Omit<CloseoutRule, 'id'>;

// ---------------------------------------------------------------------------
// RPC wrappers (every failure throws a friendly Error)
// ---------------------------------------------------------------------------

function fail(error: { message?: string } | null): never {
  throw new Error(friendlyCloseoutError(error?.message));
}

export async function fetchCloseoutBoard(includeDone = false): Promise<BoardRow[]> {
  const { data, error } = await supabase.rpc('closeout_board', { p_include_done: includeDone });
  if (error) fail(error);
  return (Array.isArray(data) ? data : []) as BoardRow[];
}

export async function fetchJobCloseout(jobId: string): Promise<JobCloseout | null> {
  const { data, error } = await supabase.rpc('closeout_job_detail', { p_job_id: jobId });
  if (error) fail(error);
  return (data ?? null) as JobCloseout | null;
}

export async function startCloseout(jobId: string, installDate?: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('closeout_start', {
    p_job_id: jobId,
    p_install_date: installDate || null,
    p_equipment_id: null,
  });
  if (error) fail(error);
  return data as string;
}

export async function transitionStep(stepId: string, to: StepStatus, note?: string, reference?: string): Promise<void> {
  const { error } = await supabase.rpc('closeout_transition_step', {
    p_step_id: stepId,
    p_to: to,
    p_note: note?.trim() || null,
    p_reference: reference?.trim() || null,
  });
  if (error) fail(error);
}

export async function patchStep(stepId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('closeout_set_step', { p_step_id: stepId, p_patch: patch });
  if (error) fail(error);
}

export async function setEvidence(closeoutId: string, key: string, present: boolean, ref?: string): Promise<void> {
  const { error } = await supabase.rpc('closeout_set_evidence', {
    p_closeout_id: closeoutId,
    p_key: key,
    p_ref: ref?.trim() || null,
    p_note: null,
    p_present: present,
  });
  if (error) fail(error);
}

export async function fetchCloseoutSummary(months = 6): Promise<CloseoutSummary> {
  const { data, error } = await supabase.rpc('closeout_monthly_summary', { p_months: months });
  if (error) fail(error);
  return data as CloseoutSummary;
}

export async function refreshDeadlines(): Promise<number> {
  const { data, error } = await supabase.rpc('closeout_refresh_deadlines');
  if (error) fail(error);
  return Number(data ?? 0);
}

export async function fetchCanSubmit(): Promise<boolean> {
  const { data, error } = await supabase.rpc('closeout_can_submit');
  if (error) return false;
  return data === true;
}

export async function fetchRules(): Promise<CloseoutRule[]> {
  const { data, error } = await supabase
    .from('closeout_rules')
    .select('*')
    .order('step_kind')
    .order('created_at', { ascending: false });
  if (error) fail(error);
  return (data ?? []) as CloseoutRule[];
}

export async function saveRule(input: RuleInput, id?: string): Promise<void> {
  const q = id
    ? supabase.from('closeout_rules').update(input).eq('id', id)
    : supabase.from('closeout_rules').insert(input);
  const { error } = await q;
  if (error) fail(error);
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from('closeout_rules').delete().eq('id', id);
  if (error) fail(error);
}
