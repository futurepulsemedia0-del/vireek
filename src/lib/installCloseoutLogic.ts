/**
 * Install Closeout — pure domain logic (NO imports, so it runs in the browser,
 * in vitest AND in Deno edge functions).
 *
 * Mirrors the database (keep in sync):
 *   supabase/migrations/20271201000000_install_closeout.sql
 *     closeout_transition_allowed / closeout_step_dependencies / closeout_missing_evidence
 *
 * Rules are DATA (closeout_programs). Nothing here hardcodes a deadline, a
 * program or a document requirement. Not legal advice.
 */

export const CLOSEOUT_STEP_KEYS = ['permit', 'inspection', 'warranty', 'rebate', 'customer_docs'] as const;
export type CloseoutStepKey = (typeof CLOSEOUT_STEP_KEYS)[number];

export const STEP_LABELS: Record<CloseoutStepKey, string> = {
  permit: 'Permit',
  inspection: 'Inspection',
  warranty: 'Warranty registration',
  rebate: 'Rebate claim',
  customer_docs: 'Customer documents',
};

export type CloseoutStepStatus =
  | 'pending' | 'in_progress' | 'ready_for_approval' | 'submitted'
  | 'completed' | 'rejected' | 'missed' | 'not_applicable';

export const STATUS_LABELS: Record<CloseoutStepStatus, string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  ready_for_approval: 'Ready for approval',
  submitted: 'Submitted (human)',
  completed: 'Completed',
  rejected: 'Rejected',
  missed: 'Deadline missed',
  not_applicable: 'Not applicable',
};

/** Steps that still need work and therefore carry deadline risk. */
export const OPEN_STATUSES: CloseoutStepStatus[] = ['pending', 'in_progress', 'ready_for_approval', 'rejected', 'missed'];
export const DONE_STATUSES: CloseoutStepStatus[] = ['completed', 'not_applicable'];

export type EvidenceKind =
  | 'serial_number' | 'model_number' | 'install_date' | 'photo' | 'permit_number'
  | 'certificate' | 'invoice' | 'inspection_report' | 'warranty_confirmation'
  | 'rebate_form' | 'customer_document' | 'other';

export const EVIDENCE_KINDS: EvidenceKind[] = [
  'serial_number', 'model_number', 'install_date', 'photo', 'permit_number', 'certificate',
  'invoice', 'inspection_report', 'warranty_confirmation', 'rebate_form', 'customer_document', 'other',
];

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  serial_number: 'Serial number',
  model_number: 'Model number',
  install_date: 'Install date',
  photo: 'Photo',
  permit_number: 'Permit number',
  certificate: 'Certificate',
  invoice: 'Invoice',
  inspection_report: 'Inspection report',
  warranty_confirmation: 'Warranty confirmation',
  rebate_form: 'Rebate form',
  customer_document: 'Customer document',
  other: 'Other',
};

export type CloseoutAnchor = 'install_date' | 'permit_completed' | 'inspection_completed' | 'job_complete';
export const ANCHOR_LABELS: Record<CloseoutAnchor, string> = {
  install_date: 'Install date',
  permit_completed: 'Permit step completed',
  inspection_completed: 'Inspection step completed',
  job_complete: 'Job completed',
};

export type Eligibility = 'unknown' | 'likely_verify' | 'not_likely';
/** Never promise eligibility. There is deliberately no "eligible" value. */
export const ELIGIBILITY_LABELS: Record<Eligibility, string> = {
  unknown: 'Not assessed',
  likely_verify: 'Likely eligible — verify with the administrator',
  not_likely: 'Unlikely to qualify — verify with the administrator',
};

export type PreApprovalStatus = 'not_required' | 'pending' | 'requested' | 'approved' | 'denied';
export const PRE_APPROVAL_LABELS: Record<PreApprovalStatus, string> = {
  not_required: 'Not required',
  pending: 'Required — not requested',
  requested: 'Requested — waiting',
  approved: 'Approved',
  denied: 'Denied',
};

export const RULES_DISCLAIMER =
  'Program rules are editable data entered and verified by your team. Deadlines, documents and eligibility can change without notice — always confirm with the program administrator or authority. Vireek shows "likely eligible, verify" only. This is not legal advice.';
export const ESTIMATE_DISCLAIMER =
  'Estimate only — based on the values your team entered on each step. Not a guarantee of any payment.';

export interface CloseoutSettings {
  technician_days: number;
  office_days: number;
  owner_days: number;
}
export const DEFAULT_SETTINGS: CloseoutSettings = { technician_days: 7, office_days: 3, owner_days: 0 };

export interface ProgramLike {
  id?: string;
  name?: string;
  required_evidence: string[];
  source_url: string | null;
  last_verified_on: string | null;
  reverify_days: number;
}

export interface StepLike {
  id: string;
  step_key: CloseoutStepKey;
  status: CloseoutStepStatus;
  deadline_on: string | null;
  estimated_value_cents: number | null;
  pre_approval_required: boolean;
  pre_approval_status: PreApprovalStatus;
  program_name?: string | null;
}

export interface EvidenceLike {
  kind: string;
  value: string | null;
  job_photo_id: string | null;
  document_id: string | null;
}

// ---------------------------------------------------------------- state machine

const TRANSITIONS: Record<CloseoutStepStatus, CloseoutStepStatus[]> = {
  pending: ['in_progress', 'not_applicable'],
  in_progress: ['ready_for_approval', 'not_applicable', 'pending'],
  ready_for_approval: ['submitted', 'in_progress'],
  submitted: ['completed', 'rejected'],
  rejected: ['in_progress'],
  // "missed" is only ever SET by the daily engine; people reopen it (the miss stays on record).
  missed: ['in_progress', 'not_applicable'],
  completed: [],
  not_applicable: ['pending'],
};

export function canTransition(from: CloseoutStepStatus, to: CloseoutStepStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
export function allowedTransitions(from: CloseoutStepStatus): CloseoutStepStatus[] {
  return [...(TRANSITIONS[from] ?? [])];
}

/** A step may only be submitted/completed once these step kinds are done or N/A. */
export function stepDependencies(key: CloseoutStepKey): CloseoutStepKey[] {
  switch (key) {
    case 'inspection': return ['permit'];
    case 'rebate': return ['inspection'];
    case 'customer_docs': return ['permit', 'inspection', 'warranty', 'rebate'];
    default: return [];
  }
}

export function unmetDependencies(key: CloseoutStepKey, siblings: Pick<StepLike, 'step_key' | 'status'>[]): CloseoutStepKey[] {
  return stepDependencies(key).filter((dep) => {
    const of = siblings.filter((s) => s.step_key === dep);
    return of.some((s) => !DONE_STATUSES.includes(s.status));
  });
}

export type BlockerCode =
  | 'invalid_transition' | 'missing_evidence' | 'dependency' | 'pre_approval'
  | 'needs_note' | 'needs_attestation' | 'needs_reference';

export interface Blocker { code: BlockerCode; detail?: string }

export function transitionBlockers(args: {
  step: StepLike;
  to: CloseoutStepStatus;
  siblings: Pick<StepLike, 'step_key' | 'status'>[];
  missing: string[];
  note?: string;
  reference?: string;
  attested?: boolean;
}): Blocker[] {
  const { step, to, siblings, missing, note = '', reference = '', attested = false } = args;
  if (!canTransition(step.status, to)) return [{ code: 'invalid_transition', detail: `${step.status} → ${to}` }];
  const out: Blocker[] = [];
  if (to === 'not_applicable' && note.trim().length < 5) out.push({ code: 'needs_note', detail: 'Reason required (5+ characters)' });
  if (to === 'rejected' && note.trim().length < 3) out.push({ code: 'needs_note', detail: 'Rejection reason required' });
  if (to === 'ready_for_approval' || to === 'submitted') {
    if (missing.length) out.push({ code: 'missing_evidence', detail: missing.join(',') });
  }
  if (to === 'submitted') {
    if (!attested) out.push({ code: 'needs_attestation', detail: 'A person must approve and submit externally' });
    if (!reference.trim() && !note.trim()) out.push({ code: 'needs_reference' });
    if (step.pre_approval_required && step.pre_approval_status !== 'approved') out.push({ code: 'pre_approval' });
  }
  if (to === 'submitted' || to === 'completed') {
    const deps = unmetDependencies(step.step_key, siblings);
    if (deps.length) out.push({ code: 'dependency', detail: deps.join(',') });
  }
  return out;
}

// ---------------------------------------------------------------- evidence

export function evidencePresent(e: EvidenceLike): boolean {
  return (e.value ?? '').trim() !== '' || e.job_photo_id != null || e.document_id != null;
}

/** Required evidence kinds with nothing usable attached, sorted. */
export function missingEvidence(requiredKinds: string[], evidence: EvidenceLike[]): string[] {
  const have = new Set(evidence.filter(evidencePresent).map((e) => e.kind));
  return Array.from(new Set(requiredKinds)).filter((k) => !have.has(k)).sort();
}

// ---------------------------------------------------------------- deadlines & risk

export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Whole days from `today` to `deadline` (negative = overdue). */
export function daysLeft(deadline: string, today: string): number {
  return dayNumber(deadline) - dayNumber(today);
}

export type RiskLevel = 'overdue' | 'critical' | 'at_risk' | 'on_track' | 'no_deadline' | 'done' | 'filed';

export function deadlineRisk(step: Pick<StepLike, 'status' | 'deadline_on'>, today: string, s: CloseoutSettings = DEFAULT_SETTINGS): RiskLevel {
  if (DONE_STATUSES.includes(step.status)) return 'done';
  if (step.status === 'submitted') return 'filed';
  if (!step.deadline_on) return 'no_deadline';
  const d = daysLeft(step.deadline_on, today);
  if (d < 0) return 'overdue';
  if (d <= s.office_days) return 'critical';
  if (d <= s.technician_days) return 'at_risk';
  return 'on_track';
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  overdue: 'Overdue', critical: 'Critical', at_risk: 'At risk', on_track: 'On track',
  no_deadline: 'No deadline set', done: 'Done', filed: 'Filed',
};

/** 0 = none, 1 = technician, 2 = office, 3 = owner. Mirrors closeout_engine_tick(). */
export function escalationTier(days: number, s: CloseoutSettings = DEFAULT_SETTINGS): 0 | 1 | 2 | 3 {
  if (days <= s.owner_days) return 3;
  if (days <= s.office_days) return 2;
  if (days <= s.technician_days) return 1;
  return 0;
}
export const TIER_LABELS = { 0: 'None', 1: 'Technician', 2: 'Office', 3: 'Owner' } as const;

export interface MoneyAtRisk {
  atRiskCents: number;
  overdueCents: number;
  stepCount: number;
  isEstimate: true;
  disclaimer: string;
}

/** Estimated value on open steps that are overdue or inside the warning window. Always an estimate. */
export function moneyAtRisk(steps: StepLike[], today: string, s: CloseoutSettings = DEFAULT_SETTINGS): MoneyAtRisk {
  let atRisk = 0, overdue = 0, count = 0;
  for (const st of steps) {
    if (!OPEN_STATUSES.includes(st.status) || !st.deadline_on) continue;
    const v = st.estimated_value_cents ?? 0;
    if (v <= 0) continue;
    const d = daysLeft(st.deadline_on, today);
    if (d < 0) { overdue += v; atRisk += v; count++; }
    else if (d <= s.technician_days) { atRisk += v; count++; }
  }
  return { atRiskCents: atRisk, overdueCents: overdue, stepCount: count, isEstimate: true, disclaimer: ESTIMATE_DISCLAIMER };
}

// ---------------------------------------------------------------- programs (rules as data)

export type ProgramFreshness = 'unverified' | 'stale' | 'fresh';
export function programFreshness(p: Pick<ProgramLike, 'source_url' | 'last_verified_on' | 'reverify_days'>, today: string): ProgramFreshness {
  if (!p.source_url || !p.last_verified_on) return 'unverified';
  return daysLeft(today, p.last_verified_on) > p.reverify_days ? 'stale' : 'fresh';
}

export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- gating (mirror of the jobs trigger)

export const START_STATUSES = ['en_route', 'in_progress'];

export function preApprovalBlockers(steps: StepLike[]): string[] {
  return steps
    .filter((s) => s.pre_approval_required && s.pre_approval_status !== 'approved' && s.status !== 'not_applicable')
    .map((s) => s.program_name || STEP_LABELS[s.step_key]);
}

const GATE_PREFIX = 'CLOSEOUT_PRE_APPROVAL_REQUIRED:';
export function isCloseoutGateError(message: string | undefined | null): boolean {
  return !!message && message.includes(GATE_PREFIX);
}
export function parseCloseoutGateError(message: string): string[] {
  const i = message.indexOf(GATE_PREFIX);
  if (i < 0) return [];
  return message.slice(i + GATE_PREFIX.length).split('||').map((s) => s.trim()).filter(Boolean);
}
export function closeoutGateMessage(message: string): string {
  return `Can't start this job yet — pre-approval required: ${parseCloseoutGateError(message).join(', ')}. Get approval first, then record it in Install Closeout.`;
}

// ---------------------------------------------------------------- summary helpers

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

export function riskCounts(steps: Pick<StepLike, 'status' | 'deadline_on'>[], today: string, s: CloseoutSettings = DEFAULT_SETTINGS): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = { overdue: 0, critical: 0, at_risk: 0, on_track: 0, no_deadline: 0, done: 0, filed: 0 };
  for (const st of steps) out[deadlineRisk(st, today, s)]++;
  return out;
}
