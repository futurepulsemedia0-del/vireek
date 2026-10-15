/**
 * Extended job workflow — pure domain logic (no network, no React).
 *
 * Five statuses sit beside the legacy six (`scheduled … no_show`) in `jobs.job_status`:
 * on_hold · waiting_on_parts · waiting_on_customer · needs_follow_up · return_visit_needed.
 *
 * Every transition INTO one of them needs a reason (enforced in the database too — see
 * supabase/migrations/20270610000000_job_workflow_statuses.sql; a unit test keeps the reason
 * lists and SLA defaults here in sync with that file). Time-dependent helpers take an
 * injectable `now` so they are deterministic under test. Network access lives in jobWorkflowApi.ts.
 */

// ============================================================
// STATUSES
// ============================================================

export const WORKFLOW_STATUSES = [
  'on_hold',
  'waiting_on_parts',
  'waiting_on_customer',
  'needs_follow_up',
  'return_visit_needed',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Statuses a held job may be resumed into (matches resume_job_from_workflow). */
export const RESUME_TARGETS = ['scheduled', 'en_route', 'in_progress'] as const;
export type ResumeTarget = (typeof RESUME_TARGETS)[number];

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export interface WorkflowStatusMeta {
  label: string;
  /** One-line help shown in the dialog. */
  description: string;
  /** Tailwind classes — design-system tokens only. */
  dot: string;
  border: string;
  badge: string;
}

export const WORKFLOW_STATUS_META: Record<WorkflowStatus, WorkflowStatusMeta> = {
  on_hold: {
    label: 'On hold',
    description: 'Work is paused on purpose. The time slot and technician are released.',
    dot: 'bg-text-secondary',
    border: 'border-t-text-secondary',
    badge: 'bg-bg-tertiary text-text-secondary',
  },
  waiting_on_parts: {
    label: 'Waiting on parts',
    description: 'A part has to arrive before the job can continue.',
    dot: 'bg-orange-500',
    border: 'border-t-orange-500',
    badge: 'bg-orange-500/10 text-orange-500',
  },
  waiting_on_customer: {
    label: 'Waiting on customer',
    description: 'We need an approval, access or an answer from the customer.',
    dot: 'bg-blue-500',
    border: 'border-t-blue-500',
    badge: 'bg-blue-500/10 text-blue-500',
  },
  needs_follow_up: {
    label: 'Needs follow-up',
    description: 'Someone on the team must reach out or check back.',
    dot: 'bg-warning-500',
    border: 'border-t-warning-500',
    badge: 'bg-warning-500/10 text-warning-500',
  },
  return_visit_needed: {
    label: 'Return visit needed',
    description: 'The job isn\'t finished — a second visit has to be booked.',
    dot: 'bg-accent',
    border: 'border-t-accent',
    badge: 'bg-accent/10 text-accent',
  },
};

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = Object.fromEntries(
  WORKFLOW_STATUSES.map((s) => [s, WORKFLOW_STATUS_META[s].label]),
) as Record<WorkflowStatus, string>;

export const WORKFLOW_STATUS_DOT: Record<WorkflowStatus, string> = Object.fromEntries(
  WORKFLOW_STATUSES.map((s) => [s, WORKFLOW_STATUS_META[s].dot]),
) as Record<WorkflowStatus, string>;

export const WORKFLOW_STATUS_BADGE: Record<WorkflowStatus, string> = Object.fromEntries(
  WORKFLOW_STATUSES.map((s) => [s, WORKFLOW_STATUS_META[s].badge]),
) as Record<WorkflowStatus, string>;

/** Where a job in each workflow status may be dragged/moved to without a dialog (the way out). */
type WayOut = 'scheduled' | 'en_route' | 'in_progress' | 'completed';
const WAY_OUT: readonly WayOut[] = ['scheduled', 'en_route', 'in_progress', 'completed'];
export const WORKFLOW_STATUS_TRANSITIONS: Record<WorkflowStatus, readonly WayOut[]> = {
  on_hold: WAY_OUT,
  waiting_on_parts: WAY_OUT,
  waiting_on_customer: WAY_OUT,
  needs_follow_up: WAY_OUT,
  return_visit_needed: WAY_OUT,
};

/** Options for status filters/pickers: `{ key, label, color }` like JobsPage's ALL_STATUSES. */
export const WORKFLOW_STATUS_OPTIONS = WORKFLOW_STATUSES.map((key) => ({
  key,
  label: WORKFLOW_STATUS_META[key].label,
  color: WORKFLOW_STATUS_META[key].dot,
}));

/** Empty buckets for kanban maps keyed by status. */
export function emptyWorkflowBuckets(): Record<WorkflowStatus, never[]> {
  return Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, []])) as unknown as Record<WorkflowStatus, never[]>;
}

/** Friendly wording for customers (portal) — never exposes internal jargon. */
export const WORKFLOW_PORTAL_LABELS: Record<WorkflowStatus, string> = {
  on_hold: 'On hold',
  waiting_on_parts: 'Waiting for parts',
  waiting_on_customer: 'Waiting for your reply',
  needs_follow_up: 'We\'ll follow up with you',
  return_visit_needed: 'Return visit to be scheduled',
};

// ============================================================
// REASONS
// ============================================================

export const OTHER_REASON = 'other';

export interface ReasonOption {
  code: string;
  label: string;
}

const REASONS: Record<WorkflowStatus, readonly ReasonOption[]> = {
  on_hold: [
    { code: 'customer_request', label: 'Customer asked to pause' },
    { code: 'access_unavailable', label: 'No access to the property' },
    { code: 'weather', label: 'Weather' },
    { code: 'safety_concern', label: 'Safety concern' },
    { code: 'payment_pending', label: 'Payment pending' },
    { code: 'awaiting_approval', label: 'Waiting for internal approval' },
    { code: 'scheduling_conflict', label: 'Scheduling conflict' },
  ],
  waiting_on_parts: [
    { code: 'part_ordered', label: 'Part ordered' },
    { code: 'part_backordered', label: 'Part back-ordered' },
    { code: 'wrong_part_delivered', label: 'Wrong part delivered' },
    { code: 'supplier_delay', label: 'Supplier delay' },
    { code: 'warranty_part_pending', label: 'Warranty part pending' },
    { code: 'part_not_identified', label: 'Part not identified yet' },
  ],
  waiting_on_customer: [
    { code: 'awaiting_quote_approval', label: 'Quote approval' },
    { code: 'awaiting_access', label: 'Access to the property' },
    { code: 'awaiting_deposit', label: 'Deposit' },
    { code: 'awaiting_information', label: 'More information' },
    { code: 'awaiting_decision_maker', label: 'Decision maker' },
    { code: 'customer_unreachable', label: 'Customer unreachable' },
  ],
  needs_follow_up: [
    { code: 'callback_required', label: 'Call the customer back' },
    { code: 'quote_follow_up', label: 'Quote follow-up' },
    { code: 'quality_check', label: 'Quality check-in' },
    { code: 'invoice_follow_up', label: 'Invoice follow-up' },
    { code: 'warranty_follow_up', label: 'Warranty follow-up' },
  ],
  return_visit_needed: [
    { code: 'additional_work_found', label: 'Additional work found' },
    { code: 'parts_arrived', label: 'Parts arrived' },
    { code: 'incomplete_repair', label: 'Repair not finished' },
    { code: 'specialist_required', label: 'Specialist required' },
    { code: 'equipment_needed', label: 'Special equipment needed' },
    { code: 'failed_test', label: 'Post-repair test failed' },
  ],
};

const OTHER_OPTION: ReasonOption = { code: OTHER_REASON, label: 'Other (add a note)' };

/** Reasons for a status, with "Other" always last. */
export function reasonsFor(status: WorkflowStatus): readonly ReasonOption[] {
  return [...REASONS[status], OTHER_OPTION];
}

export function reasonLabel(status: WorkflowStatus, code: string): string {
  return reasonsFor(status).find((r) => r.code === code)?.label ?? code.replace(/_/g, ' ');
}

// ============================================================
// SLA + REMINDER POLICY (mirror of resolve_job_workflow_policy defaults)
// ============================================================

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface WorkflowPolicy {
  slaMinutes: number | null;
  remindAfterMinutes: number | null;
  remindEveryMinutes: number | null;
  maxReminders: number;
  enabled: boolean;
}

export const DEFAULT_WORKFLOW_POLICIES: Record<WorkflowStatus, WorkflowPolicy> = {
  on_hold: { slaMinutes: 4320, remindAfterMinutes: 1440, remindEveryMinutes: 1440, maxReminders: 5, enabled: true },
  waiting_on_parts: { slaMinutes: 7200, remindAfterMinutes: 1440, remindEveryMinutes: 1440, maxReminders: 7, enabled: true },
  waiting_on_customer: { slaMinutes: 2880, remindAfterMinutes: 1440, remindEveryMinutes: 1440, maxReminders: 3, enabled: true },
  needs_follow_up: { slaMinutes: 1440, remindAfterMinutes: 240, remindEveryMinutes: 480, maxReminders: 6, enabled: true },
  return_visit_needed: { slaMinutes: 2880, remindAfterMinutes: 720, remindEveryMinutes: 720, maxReminders: 6, enabled: true },
};

export function describePolicy(policy: WorkflowPolicy): string {
  const sla = policy.slaMinutes ? `Resolve within ${formatMinutes(policy.slaMinutes)}` : 'No SLA timer';
  if (!policy.enabled || !policy.remindAfterMinutes || policy.maxReminders <= 0) return `${sla} · no reminders`;
  const every = policy.remindEveryMinutes ? `, then every ${formatMinutes(policy.remindEveryMinutes)}` : '';
  return `${sla} · reminder after ${formatMinutes(policy.remindAfterMinutes)}${every}`;
}

function formatMinutes(total: number): string {
  if (total % 1440 === 0) return `${total / 1440} day${total === 1440 ? '' : 's'}`;
  if (total % 60 === 0) return `${total / 60} hour${total === 60 ? '' : 's'}`;
  return `${total} min`;
}

// ============================================================
// HOLD ROWS + SLA STATE
// ============================================================

export interface JobHold {
  id: string;
  user_id: string;
  job_id: string;
  status: WorkflowStatus;
  reason_code: string;
  reason_note: string | null;
  previous_status: string | null;
  expected_resume_at: string | null;
  started_at: string;
  sla_minutes: number | null;
  sla_due_at: string | null;
  sla_breached_at: string | null;
  reminders_sent: number;
  max_reminders: number;
  next_reminder_at: string | null;
  last_reminded_at: string | null;
  resolved_at: string | null;
  resolved_to_status: string | null;
  resolution_note: string | null;
  created_at: string;
}

export type SlaState = 'none' | 'on_track' | 'at_risk' | 'breached';

export interface SlaSnapshot {
  state: SlaState;
  /** Milliseconds until the SLA is due; negative once breached. null without an SLA. */
  remainingMs: number | null;
  /** 0..1+ share of the SLA window already used. */
  usedRatio: number | null;
  /** "2d 3h left" / "Overdue by 5h" / "No SLA". */
  label: string;
}

/** Share of the window after which a hold is flagged "at risk". */
export const AT_RISK_RATIO = 0.75;

export function computeSla(
  hold: Pick<JobHold, 'started_at' | 'sla_due_at' | 'resolved_at'>,
  now: Date = new Date(),
): SlaSnapshot {
  if (!hold.sla_due_at) return { state: 'none', remainingMs: null, usedRatio: null, label: 'No SLA' };
  const due = Date.parse(hold.sla_due_at);
  const start = Date.parse(hold.started_at);
  if (Number.isNaN(due) || Number.isNaN(start)) return { state: 'none', remainingMs: null, usedRatio: null, label: 'No SLA' };

  // A closed hold stops its clock at the moment it was resolved.
  const at = hold.resolved_at ? Date.parse(hold.resolved_at) : now.getTime();
  const remainingMs = due - at;
  const window = Math.max(due - start, 1);
  const usedRatio = (at - start) / window;

  if (remainingMs < 0) return { state: 'breached', remainingMs, usedRatio, label: `Overdue by ${formatDuration(-remainingMs)}` };
  const state: SlaState = usedRatio >= AT_RISK_RATIO ? 'at_risk' : 'on_track';
  return { state, remainingMs, usedRatio, label: `${formatDuration(remainingMs)} left` };
}

export const SLA_TONE: Record<SlaState, string> = {
  none: 'bg-bg-tertiary text-text-secondary',
  on_track: 'bg-success-500/10 text-success-500',
  at_risk: 'bg-warning-500/10 text-warning-500',
  breached: 'bg-danger/10 text-danger',
};

/** "3d 4h", "5h 10m", "12m", "<1m". Largest two units. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < MIN) return '<1m';
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / MIN);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function holdAge(hold: Pick<JobHold, 'started_at'>, now: Date = new Date()): string {
  return formatDuration(now.getTime() - Date.parse(hold.started_at));
}

export function indexHoldsByJob(holds: readonly JobHold[]): Map<string, JobHold> {
  const map = new Map<string, JobHold>();
  for (const h of holds) if (!h.resolved_at) map.set(h.job_id, h);
  return map;
}

export interface WorkflowSummary {
  total: number;
  breached: number;
  atRisk: number;
  byStatus: Record<WorkflowStatus, number>;
}

export function summarizeHolds(holds: readonly JobHold[], now: Date = new Date()): WorkflowSummary {
  const byStatus = Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, 0])) as Record<WorkflowStatus, number>;
  let breached = 0;
  let atRisk = 0;
  let total = 0;
  for (const h of holds) {
    if (h.resolved_at) continue;
    total += 1;
    byStatus[h.status] += 1;
    const sla = computeSla(h, now).state;
    if (sla === 'breached') breached += 1;
    else if (sla === 'at_risk') atRisk += 1;
  }
  return { total, breached, atRisk, byStatus };
}

/** Where "Resume" should send a job by default. */
export function suggestResumeStatus(previous: string | null | undefined): ResumeTarget {
  return previous === 'in_progress' ? 'in_progress' : 'scheduled';
}

// ============================================================
// INPUT VALIDATION (mirrors set_job_workflow_status)
// ============================================================

export const NOTE_MAX = 1000;
export const OTHER_NOTE_MIN = 3;

export interface HoldInput {
  status: WorkflowStatus | null;
  reasonCode: string;
  note: string;
  /** `datetime-local` value ("YYYY-MM-DDTHH:mm") or ISO string; empty = none. */
  expectedResumeAt: string;
}

export interface HoldPayload {
  status: WorkflowStatus;
  reasonCode: string;
  note: string | null;
  /** ISO string or null. */
  expectedResumeAt: string | null;
}

export type HoldErrors = Partial<Record<'status' | 'reason' | 'note' | 'resume', string>>;

export function validateHoldInput(input: HoldInput, now: Date = new Date()): { ok: true; value: HoldPayload } | { ok: false; errors: HoldErrors } {
  const errors: HoldErrors = {};
  const note = input.note.trim();

  if (!input.status || !isWorkflowStatus(input.status)) {
    errors.status = 'Choose a status.';
  } else if (!input.reasonCode) {
    errors.reason = 'A reason is required.';
  } else if (!reasonsFor(input.status).some((r) => r.code === input.reasonCode)) {
    errors.reason = 'Choose a valid reason for this status.';
  }

  if (input.reasonCode === OTHER_REASON && note.length < OTHER_NOTE_MIN) errors.note = 'Add a short note when the reason is "Other".';
  if (note.length > NOTE_MAX) errors.note = `Keep the note under ${NOTE_MAX} characters.`;

  let resumeIso: string | null = null;
  if (input.expectedResumeAt) {
    const t = Date.parse(input.expectedResumeAt);
    if (Number.isNaN(t)) errors.resume = 'Enter a valid date and time.';
    else if (t < now.getTime() - MIN) errors.resume = 'Pick a time in the future.';
    else resumeIso = new Date(t).toISOString();
  }

  if (Object.keys(errors).length > 0 || !input.status) return { ok: false, errors };
  return { ok: true, value: { status: input.status, reasonCode: input.reasonCode, note: note || null, expectedResumeAt: resumeIso } };
}

// ============================================================
// ERRORS
// ============================================================

/** True when Postgres refused a direct status write because no reason was recorded. */
export function isWorkflowReasonError(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.includes('JOB_WORKFLOW_REASON_REQUIRED');
}

export type WorkflowRpcStatus = 'ok' | 'unchanged' | 'invalid' | 'invalid_transition' | 'forbidden' | 'not_found' | 'slot_conflict';

export function isWorkflowRpcStatus(value: unknown): value is WorkflowRpcStatus {
  return (
    typeof value === 'string' &&
    ['ok', 'unchanged', 'invalid', 'invalid_transition', 'forbidden', 'not_found', 'slot_conflict'].includes(value)
  );
}
