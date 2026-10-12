/**
 * Commercial work orders: types, labels and PURE business logic.
 * No Supabase import here on purpose, so everything is unit-testable.
 * Data access lives in workOrdersApi.ts.
 */

export type WorkOrderStatus = 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
export type VisitStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_access';
export type BillingStatus = 'unbilled' | 'ready_to_bill' | 'invoiced' | 'paid' | 'void';

export interface WorkOrder {
  id: string;
  user_id: string;
  customer_id: string | null;
  work_order_number: string | null;
  po_number: string | null;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  approval_status: ApprovalStatus;
  approver_name: string | null;
  approved_at: string | null;
  approval_notes: string | null;
  site_name: string | null;
  site_address: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  site_contact_email: string | null;
  not_to_exceed_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkOrderVisit {
  id: string;
  user_id: string;
  work_order_id: string;
  visit_number: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
  assigned_technician_id: string | null;
  status: VisitStatus;
  completed_at: string | null;
  notes: string | null;
  billing_status: BillingStatus;
  billable_amount_cents: number | null;
  invoice_reference: string | null;
  billed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Labels, options, colours (existing design tokens only)
// ------------------------------------------------------------

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const APPROVAL_LABELS: Record<ApprovalStatus, string> = {
  not_required: 'No approval needed',
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_access: 'No access',
};

export const BILLING_LABELS: Record<BillingStatus, string> = {
  unbilled: 'Unbilled',
  ready_to_bill: 'Ready to bill',
  invoiced: 'Invoiced',
  paid: 'Paid',
  void: 'Void',
};

const NEUTRAL = 'bg-bg-tertiary text-text-secondary';
const ACCENT = 'bg-accent/10 text-accent';
const SUCCESS = 'bg-success-500/10 text-success-500';
const WARNING = 'bg-warning-500/10 text-warning-500';
const DANGER = 'bg-danger/10 text-danger';

export const WORK_ORDER_STATUS_COLORS: Record<WorkOrderStatus, string> = {
  draft: NEUTRAL,
  scheduled: ACCENT,
  in_progress: ACCENT,
  completed: SUCCESS,
  cancelled: NEUTRAL,
};

export const APPROVAL_COLORS: Record<ApprovalStatus, string> = {
  not_required: NEUTRAL,
  pending: WARNING,
  approved: SUCCESS,
  rejected: DANGER,
};

export const VISIT_STATUS_COLORS: Record<VisitStatus, string> = {
  scheduled: ACCENT,
  in_progress: ACCENT,
  completed: SUCCESS,
  cancelled: NEUTRAL,
  no_access: WARNING,
};

export const BILLING_COLORS: Record<BillingStatus, string> = {
  unbilled: NEUTRAL,
  ready_to_bill: WARNING,
  invoiced: ACCENT,
  paid: SUCCESS,
  void: NEUTRAL,
};

export const WORK_ORDER_STATUS_OPTIONS = (Object.keys(WORK_ORDER_STATUS_LABELS) as WorkOrderStatus[]).map(
  (value) => ({ value, label: WORK_ORDER_STATUS_LABELS[value] }),
);
export const APPROVAL_OPTIONS = (Object.keys(APPROVAL_LABELS) as ApprovalStatus[]).map((value) => ({
  value,
  label: APPROVAL_LABELS[value],
}));

// ------------------------------------------------------------
// Money + dates
// ------------------------------------------------------------

const MAX_CENTS = 2_147_483_647; // Postgres integer

/** "1,234.50" / "$99" -> cents. Empty -> null. Invalid -> NaN. */
export function dollarsToCents(input: string): number | null {
  const raw = input.trim().replace(/[$,\s]/g, '');
  if (!raw) return null;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) return Number.NaN;
  const cents = Math.round(Number(raw) * 100);
  return cents > MAX_CENTS ? Number.NaN : cents;
}

export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

/** <input type="datetime-local"> value -> ISO string (local time interpreted by the browser). */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatVisitWindow(start: string | null, end: string | null): string {
  if (!start) return 'Not scheduled';
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return 'Not scheduled';
  const date = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const e = end ? new Date(end) : null;
  return e && !Number.isNaN(e.getTime()) ? `${date}, ${time(s)} – ${time(e)}` : `${date}, ${time(s)}`;
}

// ------------------------------------------------------------
// Rules
// ------------------------------------------------------------

/** Work may start only once the customer approved (or approval is not needed). */
export function canStartWork(approval: ApprovalStatus): boolean {
  return approval === 'approved' || approval === 'not_required';
}

export interface VisitMove {
  to: VisitStatus;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
}

export function allowedVisitMoves(visit: Pick<WorkOrderVisit, 'status' | 'billing_status'>, approval: ApprovalStatus): VisitMove[] {
  const billed = visit.billing_status === 'invoiced' || visit.billing_status === 'paid';
  if (billed) return [];
  const start = canStartWork(approval);
  switch (visit.status) {
    case 'scheduled':
      return [
        ...(start ? [{ to: 'in_progress', label: 'Start', tone: 'primary' } as VisitMove] : []),
        { to: 'no_access', label: 'No access', tone: 'neutral' },
        { to: 'cancelled', label: 'Cancel', tone: 'danger' },
      ];
    case 'in_progress':
      return [
        { to: 'completed', label: 'Complete', tone: 'primary' },
        { to: 'no_access', label: 'No access', tone: 'neutral' },
        { to: 'cancelled', label: 'Cancel', tone: 'danger' },
      ];
    case 'no_access':
    case 'cancelled':
      return [{ to: 'scheduled', label: 'Reschedule', tone: 'neutral' }];
    case 'completed':
      return [];
  }
}

export interface BillingMove {
  to: BillingStatus;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
}

export function allowedBillingMoves(
  visit: Pick<WorkOrderVisit, 'status' | 'billing_status' | 'billable_amount_cents'>,
): BillingMove[] {
  switch (visit.billing_status) {
    case 'unbilled':
      return visit.status === 'completed' && visit.billable_amount_cents !== null
        ? [{ to: 'ready_to_bill', label: 'Ready to bill', tone: 'primary' }]
        : [];
    case 'ready_to_bill':
      return [
        { to: 'invoiced', label: 'Mark invoiced', tone: 'primary' },
        { to: 'unbilled', label: 'Undo', tone: 'neutral' },
      ];
    case 'invoiced':
      return [
        { to: 'paid', label: 'Mark paid', tone: 'primary' },
        { to: 'void', label: 'Void', tone: 'danger' },
      ];
    case 'paid':
      return [];
    case 'void':
      return [{ to: 'unbilled', label: 'Reopen', tone: 'neutral' }];
  }
}

export interface WorkOrderSummary {
  visitCount: number;
  liveVisitCount: number;
  completedCount: number;
  nextVisitAt: string | null;
  /** Billable amount on live (non-void, non-cancelled) visits */
  committedCents: number;
  unbilledCents: number;
  readyCents: number;
  invoicedCents: number;
  paidCents: number;
  remainingCents: number | null;
  overNte: boolean;
}

export function summarizeWorkOrder(
  workOrder: Pick<WorkOrder, 'not_to_exceed_cents'>,
  visits: WorkOrderVisit[],
  now: number = Date.now(),
): WorkOrderSummary {
  let committed = 0;
  let unbilled = 0;
  let ready = 0;
  let invoiced = 0;
  let paid = 0;
  let completed = 0;
  let live = 0;
  let next: number | null = null;

  for (const v of visits) {
    const isLive = v.status !== 'cancelled' && v.billing_status !== 'void';
    if (v.status === 'completed') completed += 1;
    if (v.status !== 'cancelled') live += 1;
    if (v.status === 'scheduled' && v.scheduled_start) {
      const t = Date.parse(v.scheduled_start);
      if (Number.isFinite(t) && t >= now && (next === null || t < next)) next = t;
    }
    if (!isLive) continue;
    const amount = v.billable_amount_cents ?? 0;
    committed += amount;
    if (v.billing_status === 'unbilled') unbilled += amount;
    else if (v.billing_status === 'ready_to_bill') ready += amount;
    else if (v.billing_status === 'invoiced') invoiced += amount;
    else if (v.billing_status === 'paid') paid += amount;
  }

  const nte = workOrder.not_to_exceed_cents;
  return {
    visitCount: visits.length,
    liveVisitCount: live,
    completedCount: completed,
    nextVisitAt: next === null ? null : new Date(next).toISOString(),
    committedCents: committed,
    unbilledCents: unbilled,
    readyCents: ready,
    invoicedCents: invoiced,
    paidCents: paid,
    remainingCents: nte === null ? null : nte - committed,
    overNte: nte !== null && committed > nte,
  };
}

// ------------------------------------------------------------
// Forms
// ------------------------------------------------------------

export interface WorkOrderFormValues {
  customer_id: string;
  work_order_number: string;
  po_number: string;
  title: string;
  description: string;
  approval_status: ApprovalStatus;
  not_to_exceed: string;
  site_name: string;
  site_address: string;
  site_contact_name: string;
  site_contact_phone: string;
  site_contact_email: string;
}

export const EMPTY_WORK_ORDER_FORM: WorkOrderFormValues = {
  customer_id: '',
  work_order_number: '',
  po_number: '',
  title: '',
  description: '',
  approval_status: 'pending',
  not_to_exceed: '',
  site_name: '',
  site_address: '',
  site_contact_name: '',
  site_contact_phone: '',
  site_contact_email: '',
};

export function workOrderToForm(w: WorkOrder): WorkOrderFormValues {
  return {
    customer_id: w.customer_id ?? '',
    work_order_number: w.work_order_number ?? '',
    po_number: w.po_number ?? '',
    title: w.title,
    description: w.description ?? '',
    approval_status: w.approval_status,
    not_to_exceed: centsToDollarsInput(w.not_to_exceed_cents),
    site_name: w.site_name ?? '',
    site_address: w.site_address ?? '',
    site_contact_name: w.site_contact_name ?? '',
    site_contact_phone: w.site_contact_phone ?? '',
    site_contact_email: w.site_contact_email ?? '',
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\-.\s\dxX]{7,25}$/;

export type FormErrors<T> = Partial<Record<keyof T, string>>;

export function validateWorkOrderForm(v: WorkOrderFormValues): FormErrors<WorkOrderFormValues> {
  const errors: FormErrors<WorkOrderFormValues> = {};
  const title = v.title.trim();
  if (!title) errors.title = 'Give this work order a title.';
  else if (title.length > 200) errors.title = 'Keep the title under 200 characters.';

  if (v.work_order_number.trim() && v.work_order_number.trim().length > 40) {
    errors.work_order_number = 'Keep the number under 40 characters.';
  }
  if (v.po_number.trim().length > 60) errors.po_number = 'Keep the PO number under 60 characters.';

  const nte = dollarsToCents(v.not_to_exceed);
  if (Number.isNaN(nte)) errors.not_to_exceed = 'Enter a dollar amount like 2500 or 2500.50.';

  if (v.site_contact_email.trim() && !EMAIL_RE.test(v.site_contact_email.trim())) {
    errors.site_contact_email = 'Enter a valid email address.';
  }
  if (v.site_contact_phone.trim() && !PHONE_RE.test(v.site_contact_phone.trim())) {
    errors.site_contact_phone = 'Enter a valid phone number.';
  }
  if (v.description.length > 5000) errors.description = 'Keep the description under 5,000 characters.';
  return errors;
}

const nullable = (s: string): string | null => (s.trim() ? s.trim() : null);

/** Caller must have run validateWorkOrderForm first. */
export function toWorkOrderPayload(v: WorkOrderFormValues) {
  const nte = dollarsToCents(v.not_to_exceed);
  return {
    customer_id: v.customer_id || null,
    work_order_number: nullable(v.work_order_number),
    po_number: nullable(v.po_number),
    title: v.title.trim(),
    description: nullable(v.description),
    approval_status: v.approval_status,
    not_to_exceed_cents: nte === null || Number.isNaN(nte) ? null : nte,
    site_name: nullable(v.site_name),
    site_address: nullable(v.site_address),
    site_contact_name: nullable(v.site_contact_name),
    site_contact_phone: nullable(v.site_contact_phone),
    site_contact_email: nullable(v.site_contact_email),
  };
}

export interface VisitFormValues {
  scheduled_start: string;
  scheduled_end: string;
  assigned_technician_id: string;
  billable_amount: string;
  invoice_reference: string;
  notes: string;
}

export const EMPTY_VISIT_FORM: VisitFormValues = {
  scheduled_start: '',
  scheduled_end: '',
  assigned_technician_id: '',
  billable_amount: '',
  invoice_reference: '',
  notes: '',
};

export function visitToForm(v: WorkOrderVisit): VisitFormValues {
  return {
    scheduled_start: isoToLocalInput(v.scheduled_start),
    scheduled_end: isoToLocalInput(v.scheduled_end),
    assigned_technician_id: v.assigned_technician_id ?? '',
    billable_amount: centsToDollarsInput(v.billable_amount_cents),
    invoice_reference: v.invoice_reference ?? '',
    notes: v.notes ?? '',
  };
}

export function validateVisitForm(v: VisitFormValues): FormErrors<VisitFormValues> {
  const errors: FormErrors<VisitFormValues> = {};
  const start = v.scheduled_start ? new Date(v.scheduled_start).getTime() : null;
  const end = v.scheduled_end ? new Date(v.scheduled_end).getTime() : null;
  if (!v.scheduled_start) errors.scheduled_start = 'Pick a start time.';
  else if (start === null || Number.isNaN(start)) errors.scheduled_start = 'Pick a valid start time.';
  if (v.scheduled_end) {
    if (end === null || Number.isNaN(end)) errors.scheduled_end = 'Pick a valid end time.';
    else if (start !== null && !Number.isNaN(start) && end <= start) {
      errors.scheduled_end = 'End must be after the start.';
    }
  }
  if (Number.isNaN(dollarsToCents(v.billable_amount))) {
    errors.billable_amount = 'Enter a dollar amount like 450 or 450.00.';
  }
  if (v.notes.length > 5000) errors.notes = 'Keep notes under 5,000 characters.';
  return errors;
}

export function toVisitPayload(v: VisitFormValues) {
  const amount = dollarsToCents(v.billable_amount);
  return {
    scheduled_start: localInputToIso(v.scheduled_start),
    scheduled_end: localInputToIso(v.scheduled_end),
    assigned_technician_id: v.assigned_technician_id || null,
    billable_amount_cents: amount === null || Number.isNaN(amount) ? null : amount,
    invoice_reference: nullable(v.invoice_reference),
    notes: nullable(v.notes),
  };
}

// ------------------------------------------------------------
// Filtering
// ------------------------------------------------------------

export type StatusFilter = 'open' | 'needs_approval' | 'ready_to_bill' | 'all';

export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'needs_approval', label: 'Needs approval' },
  { key: 'ready_to_bill', label: 'Ready to bill' },
  { key: 'all', label: 'All' },
];

export function filterWorkOrders(
  workOrders: WorkOrder[],
  visitsByOrder: Record<string, WorkOrderVisit[]>,
  filter: StatusFilter,
  query: string,
  customerNames: Record<string, string> = {},
): WorkOrder[] {
  const q = query.trim().toLowerCase();
  return workOrders.filter((w) => {
    if (filter === 'open' && (w.status === 'completed' || w.status === 'cancelled')) return false;
    if (filter === 'needs_approval' && w.approval_status !== 'pending') return false;
    if (filter === 'ready_to_bill') {
      const visits = visitsByOrder[w.id] ?? [];
      if (!visits.some((v) => v.billing_status === 'ready_to_bill')) return false;
    }
    if (!q) return true;
    const haystack = [
      w.work_order_number,
      w.po_number,
      w.title,
      w.site_name,
      w.site_address,
      w.site_contact_name,
      w.customer_id ? customerNames[w.customer_id] : null,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function groupVisitsByOrder(visits: WorkOrderVisit[]): Record<string, WorkOrderVisit[]> {
  const out: Record<string, WorkOrderVisit[]> = {};
  for (const v of visits) (out[v.work_order_id] ??= []).push(v);
  for (const list of Object.values(out)) list.sort((a, b) => a.visit_number - b.visit_number);
  return out;
}

/** Maps Postgres / PostgREST errors to a sentence a dispatcher can act on. */
export function describeSaveError(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.code === '23505') return 'That work order number is already in use. Pick another or leave it blank.';
  if (error.code === '42501') return 'You do not have permission to do that.';
  if (error.code === '23514' && error.message) return error.message;
  return 'We could not save that. Please try again.';
}
