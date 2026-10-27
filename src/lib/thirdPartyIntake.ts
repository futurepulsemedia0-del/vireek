/**
 * Third-party work-order intake (warranty / insurance / manufacturer / property-manager jobs):
 * types, labels and PURE business logic (SLA clock, allowed actions, filters, forms).
 * No Supabase import here on purpose, so everything is unit-testable.
 * Data access lives in thirdPartyIntakeApi.ts.
 *
 * The SLA rules mirror the database exactly (see the migration header):
 * stage by status, "at risk" = 25% or less of the stage window left,
 * "waiting on payer" pauses the clock.
 */

import { dollarsToCents, formatMoney, isoToLocalInput, localInputToIso } from '@/lib/workOrders';

export { formatMoney };

export type IntakeStatus = 'new' | 'awaiting_payer' | 'accepted' | 'declined' | 'scheduled' | 'completed' | 'cancelled';
export type AuthorizationStatus = 'not_required' | 'pending' | 'authorized' | 'denied';
export type IntakePriority = 'standard' | 'urgent' | 'emergency';
export type PayerKind = 'home_warranty' | 'insurance' | 'manufacturer' | 'property_manager' | 'other';

export interface ThirdPartyWorkOrder {
  id: string;
  user_id: string;
  payer_id: string | null;
  payer_name: string;
  received_via: 'email' | 'api';
  external_ref: string | null;
  priority: IntakePriority;
  title: string;
  description: string | null;
  service_type: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  service_address: string | null;
  policy_number: string | null;
  nte_cents: number | null;
  quoted_cents: number | null;
  status: IntakeStatus;
  needs_review: boolean;
  review_reasons: string[];
  authorization_status: AuthorizationStatus;
  authorization_ref: string | null;
  authorized_cents: number | null;
  authorized_at: string | null;
  decline_reason: string | null;
  scheduled_for: string | null;
  work_order_id: string | null;
  received_at: string;
  accept_due_at: string | null;
  schedule_due_at: string | null;
  complete_due_at: string | null;
  responded_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  paused_at: string | null;
  paused_from_status: 'new' | 'accepted' | 'scheduled' | null;
  created_at: string;
  updated_at: string;
}

export interface IntakeEvent {
  id: string;
  intake_id: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
}

export interface Payer {
  id: string;
  user_id: string;
  name: string;
  kind: PayerKind;
  enabled: boolean;
  email_tag: string | null;
  sender_domains: string[];
  accept_within_minutes: number;
  schedule_within_hours: number;
  complete_within_hours: number;
  default_nte_cents: number | null;
  require_authorization: boolean;
  intake_token: string;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Labels + colours (existing design tokens only)
// ------------------------------------------------------------
const NEUTRAL = 'bg-bg-tertiary text-text-secondary';
const ACCENT = 'bg-accent/10 text-accent';
const SUCCESS = 'bg-success-500/10 text-success-500';
const WARNING = 'bg-warning-500/10 text-warning-500';
const DANGER = 'bg-danger/10 text-danger';

export const STATUS_LABELS: Record<IntakeStatus, string> = {
  new: 'New',
  awaiting_payer: 'Waiting on payer',
  accepted: 'Accepted',
  declined: 'Declined',
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const STATUS_COLORS: Record<IntakeStatus, string> = {
  new: ACCENT,
  awaiting_payer: WARNING,
  accepted: ACCENT,
  declined: NEUTRAL,
  scheduled: ACCENT,
  completed: SUCCESS,
  cancelled: NEUTRAL,
};

export const AUTH_LABELS: Record<AuthorizationStatus, string> = {
  not_required: 'No authorization needed',
  pending: 'Awaiting authorization',
  authorized: 'Authorized',
  denied: 'Authorization denied',
};
export const AUTH_COLORS: Record<AuthorizationStatus, string> = {
  not_required: NEUTRAL,
  pending: WARNING,
  authorized: SUCCESS,
  denied: DANGER,
};

export const PRIORITY_LABELS: Record<IntakePriority, string> = { standard: 'Standard', urgent: 'Urgent', emergency: 'Emergency' };
export const PRIORITY_COLORS: Record<IntakePriority, string> = { standard: NEUTRAL, urgent: WARNING, emergency: DANGER };

export const PAYER_KIND_LABELS: Record<PayerKind, string> = {
  home_warranty: 'Home warranty',
  insurance: 'Insurance',
  manufacturer: 'Manufacturer',
  property_manager: 'Property manager',
  other: 'Other',
};
export const PAYER_KIND_OPTIONS = (Object.keys(PAYER_KIND_LABELS) as PayerKind[]).map((value) => ({ value, label: PAYER_KIND_LABELS[value] }));

export const EVENT_LABELS: Record<string, string> = {
  received: 'Received',
  accept: 'Accepted',
  decline: 'Declined',
  request_info: 'Waiting on payer',
  resume: 'Resumed',
  quote: 'Quote recorded',
  authorize: 'Authorization recorded',
  deny_authorization: 'Authorization denied',
  schedule: 'Scheduled',
  complete: 'Completed',
  cancel: 'Cancelled',
  edit: 'Details edited',
  sla_risk: 'SLA at risk',
  sla_breach: 'SLA missed',
};

export const isTerminal = (s: IntakeStatus) => s === 'declined' || s === 'cancelled' || s === 'completed';

// ------------------------------------------------------------
// SLA clock
// ------------------------------------------------------------
export type SlaStage = 'accept' | 'schedule' | 'complete';
export type SlaState = 'ok' | 'at_risk' | 'breached' | 'paused' | 'closed';

export const SLA_STAGE_LABELS: Record<SlaStage, string> = { accept: 'Respond', schedule: 'Schedule', complete: 'Complete' };
export const AT_RISK_FRACTION = 0.25;

export interface SlaInfo {
  stage: SlaStage | null;
  state: SlaState;
  dueAt: string | null;
  remainingMs: number | null;
  label: string;
}

type SlaRow = Pick<
  ThirdPartyWorkOrder,
  'status' | 'received_at' | 'accepted_at' | 'accept_due_at' | 'schedule_due_at' | 'complete_due_at' | 'paused_at' | 'paused_from_status'
>;

export const SLA_STATE_COLORS: Record<SlaState, string> = {
  ok: SUCCESS,
  at_risk: WARNING,
  breached: DANGER,
  paused: NEUTRAL,
  closed: NEUTRAL,
};

export function formatDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 60_000);
  if (total < 1) return '<1m';
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  if (h < 48) return total % 60 ? `${h}h ${total % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const STAGE_BY_STATUS: Partial<Record<IntakeStatus, SlaStage>> = { new: 'accept', accepted: 'schedule', scheduled: 'complete' };

export function computeSla(row: SlaRow, nowMs: number): SlaInfo {
  if (isTerminal(row.status)) return { stage: null, state: 'closed', dueAt: null, remainingMs: null, label: 'Closed' };

  const paused = row.status === 'awaiting_payer';
  const stage = paused ? STAGE_BY_STATUS[row.paused_from_status ?? 'new'] ?? 'accept' : STAGE_BY_STATUS[row.status] ?? 'accept';
  const dueAt = stage === 'accept' ? row.accept_due_at : stage === 'schedule' ? row.schedule_due_at : row.complete_due_at;
  const startAt = stage === 'accept' ? row.received_at : row.accepted_at ?? row.received_at;

  if (paused) return { stage, state: 'paused', dueAt, remainingMs: null, label: 'Clock paused' };
  const dueMs = dueAt ? Date.parse(dueAt) : NaN;
  if (!Number.isFinite(dueMs)) return { stage, state: 'ok', dueAt: null, remainingMs: null, label: 'No deadline' };

  const remaining = dueMs - nowMs;
  const window = dueMs - Date.parse(startAt);
  if (remaining < 0) return { stage, state: 'breached', dueAt, remainingMs: remaining, label: `Overdue by ${formatDuration(remaining)}` };
  const atRisk = Number.isFinite(window) && window > 0 && remaining <= window * AT_RISK_FRACTION;
  return { stage, state: atRisk ? 'at_risk' : 'ok', dueAt, remainingMs: remaining, label: `${formatDuration(remaining)} left` };
}

/** true / false once the partner has been answered; null while still waiting. */
export function answeredOnTime(row: Pick<ThirdPartyWorkOrder, 'responded_at' | 'accept_due_at'>): boolean | null {
  if (!row.responded_at || !row.accept_due_at) return null;
  return Date.parse(row.responded_at) <= Date.parse(row.accept_due_at);
}

// ------------------------------------------------------------
// Actions (approval steps)
// ------------------------------------------------------------
export type IntakeAction =
  | 'accept' | 'decline' | 'request_info' | 'resume' | 'quote'
  | 'authorize' | 'deny_authorization' | 'schedule' | 'complete' | 'cancel' | 'edit';

export interface ActionMeta {
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
  title: string;
  description: string;
  note: 'required' | 'optional' | 'none';
  noteLabel: string;
  amount?: 'required' | 'optional';
  reference?: boolean;
  when?: boolean;
  confirmLabel: string;
}

export const ACTION_META: Record<IntakeAction, ActionMeta> = {
  accept: {
    label: 'Accept job', tone: 'primary', title: 'Accept this job',
    description: 'Creates the work order (PO and not-to-exceed carried over) and stops the response clock.',
    note: 'optional', noteLabel: 'Note to your team (optional)', confirmLabel: 'Accept job',
  },
  decline: {
    label: 'Decline', tone: 'danger', title: 'Decline this job',
    description: 'The partner should be told why. The reason is saved with the request.',
    note: 'required', noteLabel: 'Reason', confirmLabel: 'Decline job',
  },
  request_info: {
    label: 'Waiting on payer', tone: 'secondary', title: 'Mark as waiting on the payer',
    description: 'Pauses the SLA clock until the payer answers. Resuming adds the waiting time back to every deadline.',
    note: 'optional', noteLabel: 'What are you waiting for? (optional)', confirmLabel: 'Pause clock',
  },
  resume: {
    label: 'Payer replied', tone: 'primary', title: 'Resume this request',
    description: 'Restarts the SLA clock from where it stopped.',
    note: 'optional', noteLabel: 'Note (optional)', confirmLabel: 'Resume',
  },
  quote: {
    label: 'Record quote', tone: 'secondary', title: 'Record the quote you sent',
    description: 'Keeps the quoted amount next to the payer’s not-to-exceed.',
    note: 'optional', noteLabel: 'Note (optional)', amount: 'required', confirmLabel: 'Save quote',
  },
  authorize: {
    label: 'Record authorization', tone: 'primary', title: 'Record payer authorization',
    description: 'Unlocks scheduling and completion. The authorized amount becomes the work order’s not-to-exceed cap.',
    note: 'optional', noteLabel: 'Note (optional)', amount: 'optional', reference: true, confirmLabel: 'Record authorization',
  },
  deny_authorization: {
    label: 'Payer denied', tone: 'danger', title: 'Record that the payer denied authorization',
    description: 'Work stays blocked. You can still decline or cancel the job, or record a later approval.',
    note: 'optional', noteLabel: 'Note (optional)', confirmLabel: 'Record denial',
  },
  schedule: {
    label: 'Schedule', tone: 'primary', title: 'Schedule the visit',
    description: 'Creates (or moves) the first visit on the work order.',
    note: 'optional', noteLabel: 'Note (optional)', when: true, confirmLabel: 'Save schedule',
  },
  complete: {
    label: 'Mark complete', tone: 'primary', title: 'Mark this job complete',
    description: 'Closes the request and the linked work order. Billing continues on the Work Orders page.',
    note: 'optional', noteLabel: 'Completion note (optional)', confirmLabel: 'Mark complete',
  },
  cancel: {
    label: 'Cancel job', tone: 'danger', title: 'Cancel this job',
    description: 'Cancels the request and its work order. This cannot be undone.',
    note: 'optional', noteLabel: 'Reason (optional)', confirmLabel: 'Cancel job',
  },
  edit: {
    label: 'Edit details', tone: 'secondary', title: 'Edit request details',
    description: 'Fix anything the email or API missed. Linked work order details are updated too.',
    note: 'none', noteLabel: '', confirmLabel: 'Save changes',
  },
};

export function canSchedule(row: Pick<ThirdPartyWorkOrder, 'authorization_status'>): boolean {
  return row.authorization_status === 'authorized' || row.authorization_status === 'not_required';
}

/** Actions valid for this row, most useful first (the first one is the recommended next step). */
export function availableActions(row: Pick<ThirdPartyWorkOrder, 'status' | 'authorization_status'>): IntakeAction[] {
  if (isTerminal(row.status)) return [];
  const a: IntakeAction[] = [];
  const authPending = row.authorization_status === 'pending';
  const authDenied = row.authorization_status === 'denied';

  switch (row.status) {
    case 'new':
      a.push('accept', 'request_info', 'decline');
      break;
    case 'awaiting_payer':
      a.push('resume', 'decline');
      break;
    case 'accepted':
      if (canSchedule(row)) a.push('schedule', 'complete');
      break;
    case 'scheduled':
      a.push('complete', 'schedule');
      break;
  }
  if (authPending || authDenied) a.push('authorize');
  if (authPending) a.push('quote', 'deny_authorization');
  if (row.status === 'accepted' || row.status === 'scheduled') a.push('request_info');
  a.push('edit');
  if (row.status !== 'new') a.push('cancel');
  return a;
}

export interface ActionInput {
  note: string;
  amount: string;
  reference: string;
  when: string;
}
export const EMPTY_ACTION_INPUT: ActionInput = { note: '', amount: '', reference: '', when: '' };
export type ActionErrors = Partial<Record<keyof ActionInput, string>>;

export function validateActionInput(action: IntakeAction, input: ActionInput): ActionErrors {
  const meta = ACTION_META[action];
  const errors: ActionErrors = {};
  if (meta.note === 'required' && input.note.trim().length < 3) errors.note = 'Please give a short reason (3+ characters).';
  if (input.note.length > 2000) errors.note = 'Keep this under 2,000 characters.';
  if (meta.amount) {
    const cents = dollarsToCents(input.amount);
    if (Number.isNaN(cents)) errors.amount = 'Enter a dollar amount like 450 or 450.50.';
    else if (cents === null && meta.amount === 'required') errors.amount = 'Enter the amount.';
  }
  if (meta.reference && input.reference.trim().length > 120) errors.reference = 'Keep this under 120 characters.';
  if (meta.when) {
    const iso = localInputToIso(input.when);
    if (!iso) errors.when = 'Choose a date and time.';
  }
  return errors;
}

export interface ActRpcArgs {
  p_note: string | null;
  p_amount_cents: number | null;
  p_reference: string | null;
  p_when: string | null;
}

export function toActArgs(action: IntakeAction, input: ActionInput): ActRpcArgs {
  const meta = ACTION_META[action];
  const cents = meta.amount ? dollarsToCents(input.amount) : null;
  return {
    p_note: input.note.trim() || null,
    p_amount_cents: cents !== null && !Number.isNaN(cents) ? cents : null,
    p_reference: meta.reference ? input.reference.trim() || null : null,
    p_when: meta.when ? localInputToIso(input.when) : null,
  };
}

// ------------------------------------------------------------
// Edit form
// ------------------------------------------------------------
export interface EditFormValues {
  title: string;
  external_ref: string;
  service_type: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  service_address: string;
  policy_number: string;
  nte: string;
}

export const intakeToEditForm = (r: ThirdPartyWorkOrder): EditFormValues => ({
  title: r.title,
  external_ref: r.external_ref ?? '',
  service_type: r.service_type ?? '',
  customer_name: r.customer_name ?? '',
  customer_phone: r.customer_phone ?? '',
  customer_email: r.customer_email ?? '',
  service_address: r.service_address ?? '',
  policy_number: r.policy_number ?? '',
  nte: r.nte_cents === null ? '' : (r.nte_cents / 100).toFixed(2),
});

export function validateEditForm(v: EditFormValues): Partial<Record<keyof EditFormValues, string>> {
  const e: Partial<Record<keyof EditFormValues, string>> = {};
  if (!v.title.trim()) e.title = 'A title is required.';
  else if (v.title.trim().length > 200) e.title = 'Keep the title under 200 characters.';
  if (v.customer_email.trim() && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.customer_email.trim())) e.customer_email = 'Enter a valid email address.';
  if (v.customer_phone.trim() && v.customer_phone.replace(/\D/g, '').length < 7) e.customer_phone = 'Enter a valid phone number.';
  if (Number.isNaN(dollarsToCents(v.nte))) e.nte = 'Enter a dollar amount like 450 or 450.50.';
  return e;
}

export function toEditFields(v: EditFormValues): Record<string, string> {
  const cents = dollarsToCents(v.nte);
  return {
    title: v.title.trim(),
    external_ref: v.external_ref.trim(),
    service_type: v.service_type.trim(),
    customer_name: v.customer_name.trim(),
    customer_phone: v.customer_phone.trim(),
    customer_email: v.customer_email.trim().toLowerCase(),
    service_address: v.service_address.trim(),
    policy_number: v.policy_number.trim(),
    nte_cents: cents === null || Number.isNaN(cents) ? '' : String(cents),
  };
}

// ------------------------------------------------------------
// Filters, sorting, summary
// ------------------------------------------------------------
export type IntakeFilter = 'attention' | 'open' | 'waiting' | 'closed' | 'all';

export const INTAKE_FILTERS: { key: IntakeFilter; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'open', label: 'Open' },
  { key: 'waiting', label: 'Waiting on payer' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

export function needsAttention(row: ThirdPartyWorkOrder, nowMs: number): boolean {
  if (isTerminal(row.status)) return false;
  const sla = computeSla(row, nowMs);
  return row.status === 'new' || row.needs_review || sla.state === 'at_risk' || sla.state === 'breached';
}

const isWaiting = (r: ThirdPartyWorkOrder) =>
  !isTerminal(r.status) && (r.status === 'awaiting_payer' || (r.status !== 'new' && r.authorization_status === 'pending'));

export function filterIntakes(rows: ThirdPartyWorkOrder[], filter: IntakeFilter, query: string, nowMs: number): ThirdPartyWorkOrder[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    const passes =
      filter === 'all' ? true
        : filter === 'open' ? !isTerminal(r.status)
          : filter === 'closed' ? isTerminal(r.status)
            : filter === 'waiting' ? isWaiting(r)
              : needsAttention(r, nowMs);
    if (!passes) return false;
    if (!q) return true;
    return [r.title, r.payer_name, r.external_ref, r.customer_name, r.customer_phone, r.service_address, r.policy_number]
      .some((v) => (v ?? '').toLowerCase().includes(q));
  });
}

const STATE_RANK: Record<SlaState, number> = { breached: 0, at_risk: 1, ok: 2, paused: 3, closed: 4 };

/** Open requests first (most urgent clock on top), then closed ones, newest first. */
export function sortIntakes(rows: ThirdPartyWorkOrder[], nowMs: number): ThirdPartyWorkOrder[] {
  const keyed = rows.map((r) => ({ r, sla: computeSla(r, nowMs) }));
  keyed.sort((a, b) => {
    const rank = STATE_RANK[a.sla.state] - STATE_RANK[b.sla.state];
    if (rank !== 0) return rank;
    if (a.sla.state === 'closed') return Date.parse(b.r.received_at) - Date.parse(a.r.received_at);
    const ad = a.sla.dueAt ? Date.parse(a.sla.dueAt) : Infinity;
    const bd = b.sla.dueAt ? Date.parse(b.sla.dueAt) : Infinity;
    return ad - bd;
  });
  return keyed.map((k) => k.r);
}

export interface IntakeSummary {
  needsResponse: number;
  atRisk: number;
  breached: number;
  awaitingAuthorization: number;
  onTimePct: number | null;
  openValueCents: number;
}

export function summarizeIntakes(rows: ThirdPartyWorkOrder[], nowMs: number): IntakeSummary {
  let needsResponse = 0, atRisk = 0, breached = 0, awaitingAuthorization = 0, openValueCents = 0, answered = 0, onTime = 0;
  for (const r of rows) {
    const verdict = answeredOnTime(r);
    if (verdict !== null) {
      answered += 1;
      if (verdict) onTime += 1;
    }
    if (isTerminal(r.status)) continue;
    if (r.status === 'new') needsResponse += 1;
    if (r.authorization_status === 'pending') awaitingAuthorization += 1;
    openValueCents += r.authorized_cents ?? r.nte_cents ?? 0;
    const sla = computeSla(r, nowMs);
    if (sla.state === 'at_risk') atRisk += 1;
    if (sla.state === 'breached') breached += 1;
  }
  return { needsResponse, atRisk, breached, awaitingAuthorization, onTimePct: answered ? Math.round((onTime / answered) * 100) : null, openValueCents };
}

// ------------------------------------------------------------
// Partners (payers) form + connection helpers
// ------------------------------------------------------------
export interface PayerFormValues {
  name: string;
  kind: PayerKind;
  enabled: boolean;
  emailTag: string;
  senderDomains: string;
  acceptMinutes: string;
  scheduleHours: string;
  completeHours: string;
  defaultNte: string;
  requireAuthorization: boolean;
}

export const EMPTY_PAYER_FORM: PayerFormValues = {
  name: '', kind: 'home_warranty', enabled: true, emailTag: '', senderDomains: '',
  acceptMinutes: '120', scheduleHours: '24', completeHours: '72', defaultNte: '', requireAuthorization: true,
};

export const payerToForm = (p: Payer): PayerFormValues => ({
  name: p.name,
  kind: p.kind,
  enabled: p.enabled,
  emailTag: p.email_tag ?? '',
  senderDomains: p.sender_domains.join(', '),
  acceptMinutes: String(p.accept_within_minutes),
  scheduleHours: String(p.schedule_within_hours),
  completeHours: String(p.complete_within_hours),
  defaultNte: p.default_nte_cents === null ? '' : (p.default_nte_cents / 100).toFixed(2),
  requireAuthorization: p.require_authorization,
});

export function normalizeEmailTag(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}

export function normalizeDomains(input: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const part of input.split(/[\s,;]+/).filter(Boolean)) {
    const d = part.toLowerCase().replace(/^https?:\/\//, '').replace(/^.*@/, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d)) {
      if (!domains.includes(d)) domains.push(d);
    } else invalid.push(part);
  }
  return { domains, invalid };
}

export type PayerFormErrors = Partial<Record<keyof PayerFormValues, string>>;

const intIn = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

export function validatePayerForm(v: PayerFormValues): PayerFormErrors {
  const e: PayerFormErrors = {};
  if (!v.name.trim()) e.name = 'Enter the partner’s name.';
  else if (v.name.trim().length > 120) e.name = 'Keep the name under 120 characters.';
  if (v.emailTag.trim() && !/^[a-z0-9]{2,24}$/.test(normalizeEmailTag(v.emailTag))) e.emailTag = 'Use 2–24 letters or numbers.';
  const { domains, invalid } = normalizeDomains(v.senderDomains);
  if (invalid.length) e.senderDomains = `Not a valid domain: ${invalid.slice(0, 2).join(', ')}`;
  else if (domains.length > 20) e.senderDomains = 'Add at most 20 domains.';
  if (!intIn(v.acceptMinutes, 5, 10080)) e.acceptMinutes = 'Between 5 minutes and 7 days (10,080).';
  if (!intIn(v.scheduleHours, 1, 720)) e.scheduleHours = 'Between 1 and 720 hours.';
  if (!intIn(v.completeHours, 1, 2160)) e.completeHours = 'Between 1 and 2,160 hours.';
  if (!e.scheduleHours && !e.completeHours && Number(v.scheduleHours) > Number(v.completeHours)) {
    e.scheduleHours = 'Scheduling can’t be later than completion.';
  }
  if (Number.isNaN(dollarsToCents(v.defaultNte))) e.defaultNte = 'Enter a dollar amount like 450 or 450.50.';
  return e;
}

export function toPayerPayload(v: PayerFormValues) {
  const cents = dollarsToCents(v.defaultNte);
  return {
    name: v.name.trim(),
    kind: v.kind,
    enabled: v.enabled,
    email_tag: normalizeEmailTag(v.emailTag) || null,
    sender_domains: normalizeDomains(v.senderDomains).domains,
    accept_within_minutes: Number(v.acceptMinutes),
    schedule_within_hours: Number(v.scheduleHours),
    complete_within_hours: Number(v.completeHours),
    default_nte_cents: cents === null || Number.isNaN(cents) ? null : cents,
    require_authorization: v.requireAuthorization,
  };
}

export function buildIntakeUrl(supabaseUrl: string | undefined): string {
  return `${(supabaseUrl ?? '').replace(/\/+$/, '')}/functions/v1/third-party-intake`;
}

export function buildIntakeEmailAlias(inboundToken: string | null | undefined, domain: string | undefined, tag: string | null): string | null {
  if (!inboundToken || !domain) return null;
  return tag ? `${inboundToken}+${tag}@${domain}` : `${inboundToken}@${domain}`;
}

export function buildCurlExample(url: string, token: string): string {
  return [
    `curl -X POST '${url}' \\`,
    `  -H 'X-Vireek-Token: ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"claim_number":"CLM-1001","summary":"Refrigerator not cooling","priority":"urgent",`,
    `       "customer":{"name":"Ana Lopez","phone":"555-010-2030"},`,
    `       "address":"12 Oak St, Austin TX","nte":450}'`,
  ].join('\n');
}

// ------------------------------------------------------------
// Misc
// ------------------------------------------------------------
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export { isoToLocalInput };

export function describeIntakeError(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.code === '42501') return 'You do not have permission to do that.';
  if (error.code === 'P0002') return 'That request no longer exists. Refresh the page.';
  if (error.code === '23505') return 'A partner with that name or email tag already exists.';
  if ((error.code === '23514' || error.code === '22023') && error.message) return error.message;
  return 'We could not save that. Please try again.';
}
