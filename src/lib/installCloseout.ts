/**
 * Install Closeout "Autopilot" — pure rules + data layer.
 *
 * Mirrors supabase/migrations/20271201000000_install_closeout_autopilot.sql.
 * Keep the state machine, escalation thresholds, dependency rules and evidence
 * keys in sync with the SQL helpers (closeout_step_transition_allowed,
 * closeout_escalation_level, closeout_transition_step, closeout_manual_keys).
 *
 * Rules:
 *  - The database is the authority. Every client check here is a UX preview of a
 *    guard that the database enforces again.
 *  - Writes to closeout steps/evidence go through validated RPCs only.
 *  - Vireek never files anything externally: submit / complete / waive are human
 *    decisions that need owner or office permission.
 */
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------- types

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

export type PreApprovalState = 'not_required' | 'pending' | 'approved' | 'denied';

export type RiskLevel = 'overdue' | 'critical' | 'high' | 'medium' | 'low' | 'none' | 'resolved';

export type EvidenceKey =
  | 'serial_number'
  | 'model_number'
  | 'install_date'
  | 'photos'
  | 'permit_number'
  | 'inspection_pass'
  | 'ahri_certificate'
  | 'invoice'
  | 'customer_signature'
  | 'proof_of_purchase'
  | 'rebate_preapproval'
  | 'contractor_enrollment';

export type RuleFreshness = 'unverified' | 'fresh' | 'stale';

export interface StepEvidence {
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
  owner_user_id: string | null;
  rule_id: string | null;
  rule_name: string | null;
  source_url: string | null;
  rule_verified_at: string | null;
  required_evidence: string[];
  deadline: string | null;
  days_left: number | null;
  estimated_value_cents: number;
  pre_approval_required: boolean;
  pre_approval_status: PreApprovalState;
  reference_number: string | null;
  escalation_level: number;
  submitted_at: string | null;
  approved_at: string | null;
  completed_at: string | null;
  missed_at: string | null;
  waive_reason: string | null;
  notes: string | null;
  evidence: StepEvidence[];
}

export interface CloseoutJobRow {
  id: string;
  job_id: string;
  equipment_id: string | null;
  permit_application_id: string | null;
  rebate_application_id: string | null;
  install_date: string | null;
  status: 'active' | 'done' | 'cancelled';
  completed_at: string | null;
  created_at: string;
}

export interface CloseoutEventRow {
  id: string;
  closeout_id: string;
  step_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface JobCloseout {
  closeout: CloseoutJobRow;
  steps: StepDetail[];
  events: CloseoutEventRow[];
}

export interface BoardRow {
  step_id: string;
  closeout_id: string;
  job_id: string;
  customer_name: string | null;
  address: string | null;
  service_type: string | null;
  job_status: string | null;
  install_date: string | null;
  step_kind: StepKind;
  status: StepStatus;
  owner_role: OwnerRole;
  deadline: string | null;
  days_left: number | null;
  escalation_level: number;
  estimated_value_cents: number;
  pre_approval_required: boolean;
  pre_approval_status: PreApprovalState;
  missing_evidence: string[];
  source_url: string | null;
  rule_name: string | null;
  rule_verified_at: string | null;
}

export interface CloseoutSummary {
  months: {
    month: string;
    recovered_cents: number;
    protected_cents: number;
    lost_cents: number;
    missed_steps: number;
  }[];
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
  program_id: string | null;
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

export interface RuleInput {
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

/** Keys accepted by closeout_set_step(p_patch). Technicians may only edit notes. */
export interface StepPatch {
  deadline?: string | null;
  owner_role?: OwnerRole;
  owner_user_id?: string | null;
  estimated_value_cents?: number;
  rule_id?: string | null;
  pre_approval_status?: PreApprovalState;
  reference_number?: string | null;
  notes?: string | null;
}

export interface SubmitCheck {
  ok: boolean;
  reason: string | null;
}

export interface JobStartCheck {
  blocked: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------- constants

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
  missed: 'Missed deadline',
};

export const OWNER_LABELS: Record<OwnerRole, string> = {
  technician: 'Technician',
  office: 'Office',
  owner: 'Owner',
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  overdue: 'Overdue',
  critical: '≤ 3 days',
  high: '≤ 7 days',
  medium: '≤ 14 days',
  low: 'On track',
  none: 'No deadline',
  resolved: 'Closed',
};

/** Tailwind classes for the risk badge (design tokens only). */
export const RISK_BADGE: Record<RiskLevel, string> = {
  overdue: 'bg-danger/10 text-danger',
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning-500/10 text-warning-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-secondary text-text-secondary',
  none: 'bg-bg-secondary text-text-secondary',
  resolved: 'bg-success/10 text-success',
};

/** Must match the CHECK constraint on closeout_rules.required_evidence. */
export const ALL_EVIDENCE_KEYS: readonly EvidenceKey[] = [
  'serial_number',
  'model_number',
  'install_date',
  'photos',
  'permit_number',
  'inspection_pass',
  'ahri_certificate',
  'invoice',
  'customer_signature',
  'proof_of_purchase',
  'rebate_preapproval',
  'contractor_enrollment',
];

/** Evidence a person attaches by hand (everything else is collected automatically). */
export const MANUAL_EVIDENCE_KEYS: readonly EvidenceKey[] = [
  'ahri_certificate',
  'customer_signature',
  'proof_of_purchase',
  'contractor_enrollment',
];

const EVIDENCE_LABELS: Record<EvidenceKey, string> = {
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

/** A rule not re-verified for this many days is shown as stale. */
export const RULE_STALE_DAYS = 180;

/** Steps due within this many days count as "money at risk". */
export const AT_RISK_WINDOW_DAYS = 14;

const CLOSED_STATUSES: StepStatus[] = ['done', 'waived'];

// ---------------------------------------------------------------- labels / formatting

export function evidenceLabel(key: string): string {
  if (Object.prototype.hasOwnProperty.call(EVIDENCE_LABELS, key)) return EVIDENCE_LABELS[key as EvidenceKey];
  const plain = key.replace(/_/g, ' ').trim();
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : key;
}

export function formatCents(cents: number, currency = 'USD'): string {
  const value = Number.isFinite(cents) ? cents / 100 : 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString('en-US')}`;
  }
}

/** Only http(s) links are ever rendered as clickable sources. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- dates

/** Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the user's wall clock). */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISODate(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return t;
}

/** Whole calendar days from `today` to `deadline` (negative = overdue). Timezone-safe. */
export function daysUntil(deadline: string | null | undefined, today: string | null | undefined): number | null {
  const a = parseISODate(deadline);
  const b = parseISODate(today);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86_400_000);
}

// ---------------------------------------------------------------- escalation

/** 0 none · 1 technician (≤14d) · 2 office (≤7d) · 3 owner (≤3d or overdue). Mirrors closeout_escalation_level. */
export function escalationLevel(daysLeft: number | null | undefined): 0 | 1 | 2 | 3 {
  if (daysLeft === null || daysLeft === undefined || Number.isNaN(daysLeft)) return 0;
  if (daysLeft <= 3) return 3;
  if (daysLeft <= 7) return 2;
  if (daysLeft <= 14) return 1;
  return 0;
}

export function escalationTarget(level: number): OwnerRole | null {
  if (level >= 3) return 'owner';
  if (level === 2) return 'office';
  if (level === 1) return 'technician';
  return null;
}

// ---------------------------------------------------------------- deadline risk

const RISK_ORDER: Record<RiskLevel, number> = {
  overdue: 0,
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 5,
  resolved: 6,
};

export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

export function deadlineRisk(
  step: { status: StepStatus; deadline: string | null },
  today: string,
): RiskLevel {
  if (CLOSED_STATUSES.includes(step.status)) return 'resolved';
  if (step.status === 'missed') return 'overdue';
  // Filed with the program/authority: no longer at risk of a missed deadline.
  if (step.status === 'submitted') return 'low';
  const days = daysUntil(step.deadline, today);
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days <= 3) return 'critical';
  if (days <= 7) return 'high';
  if (days <= AT_RISK_WINDOW_DAYS) return 'medium';
  return 'low';
}

/**
 * Estimated money at risk: open steps due within 14 days plus every missed step.
 * An estimate from the values the business typed in — never an accounting figure.
 */
export function moneyAtRisk(
  steps: { status: StepStatus; deadline: string | null; estimated_value_cents: number }[],
  today: string,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.status === 'done' || s.status === 'waived' || s.status === 'submitted') continue;
    if (s.status === 'missed') {
      total += s.estimated_value_cents || 0;
      continue;
    }
    const days = daysUntil(s.deadline, today);
    if (days !== null && days <= AT_RISK_WINDOW_DAYS) total += s.estimated_value_cents || 0;
  }
  return total;
}

// ---------------------------------------------------------------- state machine

const TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  not_started: ['in_progress', 'blocked', 'waived'],
  in_progress: ['not_started', 'blocked', 'awaiting_approval', 'waived'],
  blocked: ['in_progress', 'waived'],
  awaiting_approval: ['in_progress', 'submitted', 'waived'],
  submitted: ['done', 'in_progress'],
  done: [],
  waived: [],
  // A missed step can be recovered late, but never silently completed.
  missed: ['in_progress', 'submitted', 'waived'],
};

export function transitionAllowed(from: StepStatus, to: StepStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: StepStatus): StepStatus[] {
  return [...(TRANSITIONS[from] ?? [])];
}

/** Submitting, completing and waiving need owner/office (closeout_can_submit). */
export function requiresApprover(to: StepStatus): boolean {
  return to === 'submitted' || to === 'done' || to === 'waived';
}

// ---------------------------------------------------------------- dependencies

type StepLite = { step_kind: StepKind; status: StepStatus };

function isClosed(status: StepStatus | undefined): boolean {
  return status !== undefined && CLOSED_STATUSES.includes(status);
}

/**
 * The step that must be closed first, or null. Permit and warranty never wait
 * (so a deadline cannot be lost to ordering). Mirrors closeout_transition_step.
 */
export function blockingDependency(kind: StepKind, steps: StepLite[]): StepKind | null {
  const statusOf = (k: StepKind) => steps.find((s) => s.step_kind === k)?.status;
  if (kind === 'inspection') return isClosed(statusOf('permit')) ? null : 'permit';
  if (kind === 'rebate') return isClosed(statusOf('inspection')) ? null : 'inspection';
  if (kind === 'documents') {
    for (const k of STEP_KINDS) {
      if (k === 'documents') continue;
      const st = statusOf(k);
      if (st !== undefined && !isClosed(st)) return k;
    }
  }
  return null;
}

export function canSubmitStep(
  step: {
    step_kind: StepKind;
    status: StepStatus;
    missing_evidence: string[];
    pre_approval_required: boolean;
    pre_approval_status: PreApprovalState;
  },
  steps: StepLite[],
): SubmitCheck {
  if (step.missing_evidence.length > 0) {
    return { ok: false, reason: `Missing: ${step.missing_evidence.map(evidenceLabel).join(', ')}.` };
  }
  const dep = blockingDependency(step.step_kind, steps);
  if (dep) {
    return { ok: false, reason: `Finish "${STEP_LABELS[dep]}" first.` };
  }
  if (step.pre_approval_required && step.pre_approval_status !== 'approved') {
    return { ok: false, reason: 'Program pre-approval has not been approved yet.' };
  }
  return { ok: true, reason: null };
}

/**
 * Mirror of the jobs trigger: a rebate that needs pre-approval blocks the job from
 * moving to En route / In progress until the reservation is approved, or the
 * step is waived / done.
 */
export function jobStartBlock(
  steps: {
    step_kind: StepKind;
    status: StepStatus;
    pre_approval_required: boolean;
    pre_approval_status: PreApprovalState;
  }[],
): JobStartCheck {
  const gate = steps.find(
    (s) =>
      s.step_kind === 'rebate' &&
      s.pre_approval_required &&
      s.pre_approval_status !== 'approved' &&
      !CLOSED_STATUSES.includes(s.status),
  );
  if (!gate) return { blocked: false, reason: null };
  if (gate.pre_approval_status === 'denied') {
    return {
      blocked: true,
      reason: 'The rebate reservation was denied. Have the owner or office waive the rebate step before starting work.',
    };
  }
  return {
    blocked: true,
    reason: 'A rebate program on this job requires pre-approval. Get the reservation approved before starting work.',
  };
}

// ---------------------------------------------------------------- rules as data

export function ruleFreshness(verifiedOn: string | null | undefined, today: string): RuleFreshness {
  const age = daysUntil(today, verifiedOn ?? null);
  if (age === null) return 'unverified';
  return age > RULE_STALE_DAYS ? 'stale' : 'fresh';
}

/** Never claims a customer is eligible — only that they are likely eligible, pending verification. */
export function eligibilityCopy(sourceUrl: string | null | undefined): string {
  return safeHttpUrl(sourceUrl)
    ? 'Likely eligible — verify against the program source before promising anything to the customer.'
    : 'Eligibility is unknown — add a verified rule source and verify before promising anything to the customer.';
}

// ---------------------------------------------------------------- errors

/** Friendly text for the CLOSEOUT_* errors raised by the database. */
export function friendlyCloseoutError(message: string | null | undefined): string {
  const raw = (message ?? '').trim();
  if (!raw) return 'Something went wrong. Please try again.';
  const m = /CLOSEOUT_([A-Z_]+):\s*([\s\S]*)$/.exec(raw);
  if (!m) return raw;
  const detail = m[2].trim();
  switch (m[1]) {
    case 'PREAPPROVAL_REQUIRED':
      return 'Pre-approval is required first: get the rebate reservation approved, or have the owner or office waive the rebate step.';
    case 'EVIDENCE_MISSING':
      return `Required items are missing: ${detail
        .split(',')
        .map((k) => evidenceLabel(k.trim()))
        .filter(Boolean)
        .join(', ')}.`;
    case 'DEPENDENCY':
      return detail || 'Finish the earlier steps first.';
    case 'NOTE_REQUIRED':
      return detail || 'A note is required.';
    case 'FORBIDDEN':
      return 'Only the owner or office can submit, complete or waive a step.';
    case 'INACTIVE':
      return 'This closeout is no longer active.';
    case 'TRANSITION':
      return detail || 'That status change is not allowed.';
    default:
      return detail || 'Something went wrong. Please try again.';
  }
}

// ---------------------------------------------------------------- data layer

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(friendlyCloseoutError(error.message));
  return data as T;
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/** Can this person submit / complete / waive? Never throws: falls back to false. */
export async function fetchCanSubmit(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('closeout_can_submit');
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Checklist, evidence and audit timeline for one job, or null when no closeout exists yet. */
export async function fetchJobCloseout(jobId: string): Promise<JobCloseout | null> {
  const data = await call<JobCloseout | null>('closeout_job_detail', { p_job_id: jobId });
  if (!data) return null;
  return { closeout: data.closeout, steps: data.steps ?? [], events: data.events ?? [] };
}

export async function startCloseout(jobId: string, installDate?: string | null, equipmentId?: string | null): Promise<string> {
  return call<string>('closeout_start', {
    p_job_id: jobId,
    p_install_date: blankToNull(installDate),
    p_equipment_id: equipmentId ?? null,
  });
}

export async function patchStep(stepId: string, patch: StepPatch): Promise<void> {
  await call<void>('closeout_set_step', { p_step_id: stepId, p_patch: patch });
}

export async function setEvidence(
  closeoutId: string,
  key: string,
  present: boolean,
  ref?: string | null,
  note?: string | null,
): Promise<void> {
  await call<void>('closeout_set_evidence', {
    p_closeout_id: closeoutId,
    p_key: key,
    p_ref: blankToNull(ref),
    p_note: blankToNull(note),
    p_present: present,
  });
}

export async function transitionStep(
  stepId: string,
  to: StepStatus,
  note?: string | null,
  reference?: string | null,
): Promise<void> {
  await call<unknown>('closeout_transition_step', {
    p_step_id: stepId,
    p_to: to,
    p_note: blankToNull(note),
    p_reference: blankToNull(reference),
  });
}

export async function fetchCloseoutBoard(includeDone = false): Promise<BoardRow[]> {
  const data = await call<BoardRow[] | null>('closeout_board', { p_include_done: includeDone });
  return data ?? [];
}

export async function fetchCloseoutSummary(months = 6): Promise<CloseoutSummary> {
  const data = await call<CloseoutSummary | null>('closeout_monthly_summary', { p_months: months });
  return data ?? { months: [], at_risk_cents: 0, at_risk_steps: 0, overdue_steps: 0 };
}

/** Escalates tech → office → owner and flags missed steps; returns how many were escalated. */
export async function refreshDeadlines(): Promise<number> {
  const n = await call<number | null>('closeout_refresh_deadlines');
  return typeof n === 'number' ? n : 0;
}

// ---- rules (RLS: owner/office only for writes; user_id is defaulted by the database)

const RULE_COLUMNS =
  'id, step_kind, name, equipment_type, manufacturer, program_id, deadline_days, required_evidence, ' +
  'requires_pre_approval, requires_contractor_enrollment, default_owner_role, estimated_value_cents, ' +
  'source_url, last_verified_at, notes, is_active';

export async function fetchRules(): Promise<CloseoutRule[]> {
  const { data, error } = await supabase
    .from('closeout_rules')
    .select(RULE_COLUMNS)
    .order('step_kind')
    .order('name');
  if (error) throw new Error(friendlyCloseoutError(error.message));
  return (data ?? []) as unknown as CloseoutRule[];
}

export async function saveRule(input: RuleInput, id?: string): Promise<void> {
  const payload = {
    step_kind: input.step_kind,
    name: input.name.trim(),
    equipment_type: blankToNull(input.equipment_type),
    manufacturer: blankToNull(input.manufacturer),
    deadline_days: input.deadline_days,
    required_evidence: input.required_evidence,
    requires_pre_approval: input.step_kind === 'rebate' ? input.requires_pre_approval : false,
    requires_contractor_enrollment: input.requires_contractor_enrollment,
    default_owner_role: input.default_owner_role,
    estimated_value_cents: input.estimated_value_cents,
    source_url: safeHttpUrl(input.source_url),
    last_verified_at: input.last_verified_at,
    notes: blankToNull(input.notes),
    is_active: input.is_active,
  };
  const { error } = id
    ? await supabase.from('closeout_rules').update(payload).eq('id', id)
    : await supabase.from('closeout_rules').insert(payload);
  if (error) throw new Error(friendlyCloseoutError(error.message));
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from('closeout_rules').delete().eq('id', id);
  if (error) throw new Error(friendlyCloseoutError(error.message));
}
