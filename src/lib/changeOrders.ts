/**
 * Change Orders — pure domain logic (no I/O, no React).
 *
 * Money rules mirror supabase/migrations/20271210093000_change_orders.sql 1:1 — change one, change the other:
 *   line total = round(quantity * unit_price_cents)   (half away from zero)
 *   subtotal   = sum(line totals)
 *   tax        = round(subtotal * tax_percent / 100)  (half away from zero)
 *   total      = subtotal + tax
 */

export type ChangeOrderStatus = 'draft' | 'sent' | 'approved' | 'declined' | 'cancelled';
/** 'expired' is derived: a sent change order whose link window has passed. */
export type DisplayStatus = ChangeOrderStatus | 'expired';
export type ChangeOrderReason =
  | 'customer_request'
  | 'unforeseen_condition'
  | 'code_requirement'
  | 'design_change'
  | 'scope_correction'
  | 'other';
export type ApprovalMethod = 'online' | 'in_person' | 'phone' | 'email' | 'other';
export type EventType = 'created' | 'sent' | 'resent' | 'viewed' | 'approved' | 'declined' | 'cancelled' | 'invoiced';

export interface LineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface ChangeOrder {
  id: string;
  user_id: string;
  co_number: string | null;
  job_id: string | null;
  project_id: string | null;
  customer_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  site_address: string | null;
  title: string;
  reason: ChangeOrderReason;
  description: string;
  internal_notes: string;
  line_items: LineItem[];
  tax_percent: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  schedule_impact_days: number;
  status: ChangeOrderStatus;
  approval_token: string;
  content_hash: string | null;
  sent_at: string | null;
  expires_at: string | null;
  viewed_at: string | null;
  responded_at: string | null;
  approval_method: ApprovalMethod | null;
  approver_name: string | null;
  response_note: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  invoice_id: string | null;
  invoiced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChangeOrderEvent {
  id: string;
  change_order_id: string;
  event_type: EventType;
  actor_type: 'staff' | 'customer' | 'system';
  actor_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface PublicChangeOrder {
  number: string;
  title: string;
  reason: ChangeOrderReason;
  description: string;
  lineItems: LineItem[];
  taxPercent: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  scheduleImpactDays: number;
  status: DisplayStatus;
  sentAt: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  approverName: string | null;
  customerName: string;
  siteAddress: string | null;
  reference: string | null;
  businessName: string | null;
}

// ------------------------------------------------------------------
// Labels
// ------------------------------------------------------------------

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Awaiting approval',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const REASON_LABEL: Record<ChangeOrderReason, string> = {
  customer_request: 'Customer request',
  unforeseen_condition: 'Unforeseen condition',
  code_requirement: 'Code requirement',
  design_change: 'Design change',
  scope_correction: 'Scope correction',
  other: 'Other',
};

export const REASONS = Object.keys(REASON_LABEL) as ChangeOrderReason[];

export const METHOD_LABEL: Record<ApprovalMethod, string> = {
  online: 'Online signature',
  in_person: 'In person',
  phone: 'Phone',
  email: 'Email',
  other: 'Other',
};

export const EVENT_LABEL: Record<EventType, string> = {
  created: 'Draft created',
  sent: 'Sent to customer',
  resent: 'Sent again (new expiry)',
  viewed: 'Opened by customer',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Cancelled',
  invoiced: 'Invoice created',
};

export const MAX_LINES = 100;
export const DEFAULT_EXPIRY_DAYS = 14;

// ------------------------------------------------------------------
// Money
// ------------------------------------------------------------------

/** Rounds half away from zero (matches PostgreSQL numeric round()). */
export function roundHalfAway(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(Math.abs(n) * 1e8) / 1e8; // absorb binary float noise (e.g. 1.005 * 100)
  const out = Math.sign(n) * Math.floor(r + 0.5);
  return out === 0 ? 0 : out; // never return -0
}

export function lineTotalCents(line: Pick<LineItem, 'quantity' | 'unit_price_cents'>): number {
  return roundHalfAway(line.quantity * line.unit_price_cents);
}

export interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function computeTotals(lines: Pick<LineItem, 'quantity' | 'unit_price_cents'>[], taxPercent: number): Totals {
  const subtotalCents = lines.reduce((s, l) => s + lineTotalCents(l), 0);
  const taxCents = roundHalfAway((subtotalCents * (Number.isFinite(taxPercent) ? taxPercent : 0)) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** "12,500.50" / "$1,200" / "-45" → cents. '' → 0. Invalid → null. */
export function dollarsToCents(input: string): number | null {
  const clean = input.replace(/[$,\s]/g, '');
  if (clean === '') return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  return roundHalfAway(Number(clean) * 100);
}

export function centsToDollarsInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

// ------------------------------------------------------------------
// Status & dates
// ------------------------------------------------------------------

export function isExpired(co: Pick<ChangeOrder, 'status' | 'expires_at'>, now: Date = new Date()): boolean {
  return co.status === 'sent' && !!co.expires_at && new Date(co.expires_at).getTime() <= now.getTime();
}

export function displayStatus(co: Pick<ChangeOrder, 'status' | 'expires_at'>, now: Date = new Date()): DisplayStatus {
  return isExpired(co, now) ? 'expired' : co.status;
}

/** Whole days until `iso` (negative = past). Null for missing/invalid input. */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatScheduleImpact(days: number): string {
  if (!days) return 'No schedule change';
  const n = Math.abs(days);
  return `${days > 0 ? '+' : '−'}${n} day${n === 1 ? '' : 's'}`;
}

export function changeOrderLink(token: string, origin: string = typeof window !== 'undefined' ? window.location.origin : ''): string {
  return `${origin}/change-order/${token}`;
}

// ------------------------------------------------------------------
// Actions available per state (single source of truth for the UI)
// ------------------------------------------------------------------

export interface Actions {
  canEdit: boolean;
  canSend: boolean;
  canResend: boolean;
  canRecordDecision: boolean;
  canInvoice: boolean;
  canCancel: boolean;
  needsCancelReason: boolean;
  /** Approved credit (total < 0): lowers the revised value, is not invoiced. */
  isCredit: boolean;
}

export function actionsFor(co: ChangeOrder, now: Date = new Date()): Actions {
  const expired = isExpired(co, now);
  const draft = co.status === 'draft';
  const sentLive = co.status === 'sent' && !expired;
  const hasLines = co.line_items.length > 0;
  const invoiced = !!co.invoice_id;
  return {
    canEdit: draft,
    canSend: draft && hasLines,
    canResend: co.status === 'sent' && expired,
    canRecordDecision: (draft || co.status === 'sent') && hasLines,
    canInvoice: co.status === 'approved' && co.total_cents > 0 && !invoiced,
    canCancel: draft || sentLive || co.status === 'approved' || expired,
    needsCancelReason: co.status !== 'draft',
    isCredit: co.status === 'approved' && co.total_cents < 0,
  };
}

// ------------------------------------------------------------------
// Billing / contract impact
// ------------------------------------------------------------------

export interface Impact {
  originalCents: number | null;
  approvedCents: number;
  pendingCents: number;
  revisedCents: number | null;
  approvedCount: number;
  pendingCount: number;
  scheduleDays: number;
  invoicedCents: number;
  toInvoiceCents: number;
}

/**
 * Contract impact for one parent (job or project). `originalCents` is the contract/job value
 * before change orders, or null when unknown (then no revised total is shown).
 */
export function computeImpact(originalCents: number | null, cos: ChangeOrder[], now: Date = new Date()): Impact {
  let approved = 0, pending = 0, approvedCount = 0, pendingCount = 0, days = 0, invoiced = 0, toInvoice = 0;
  for (const co of cos) {
    if (co.status === 'approved') {
      approved += co.total_cents;
      approvedCount += 1;
      days += co.schedule_impact_days;
      if (co.invoice_id) invoiced += co.total_cents;
      else if (co.total_cents > 0) toInvoice += co.total_cents;
    } else if (co.status === 'sent' && !isExpired(co, now)) {
      pending += co.total_cents;
      pendingCount += 1;
    }
  }
  return {
    originalCents,
    approvedCents: approved,
    pendingCents: pending,
    revisedCents: originalCents === null ? null : originalCents + approved,
    approvedCount,
    pendingCount,
    scheduleDays: days,
    invoicedCents: invoiced,
    toInvoiceCents: toInvoice,
  };
}

export interface PortfolioSummary {
  awaiting: number;
  awaitingCents: number;
  approvedToInvoiceCents: number;
  approvedCents: number;
  declinedCount: number;
  drafts: number;
  expired: number;
}

export function summarize(cos: ChangeOrder[], now: Date = new Date()): PortfolioSummary {
  const s: PortfolioSummary = { awaiting: 0, awaitingCents: 0, approvedToInvoiceCents: 0, approvedCents: 0, declinedCount: 0, drafts: 0, expired: 0 };
  for (const co of cos) {
    const st = displayStatus(co, now);
    if (st === 'sent') { s.awaiting += 1; s.awaitingCents += co.total_cents; }
    else if (st === 'expired') s.expired += 1;
    else if (st === 'draft') s.drafts += 1;
    else if (st === 'declined') s.declinedCount += 1;
    else if (st === 'approved') {
      s.approvedCents += co.total_cents;
      if (!co.invoice_id && co.total_cents > 0) s.approvedToInvoiceCents += co.total_cents;
    }
  }
  return s;
}

// ------------------------------------------------------------------
// Form
// ------------------------------------------------------------------

export interface LineFormValues {
  description: string;
  quantity: string;
  unitPrice: string; // dollars
}

export interface FormValues {
  title: string;
  reason: ChangeOrderReason;
  description: string;
  internalNotes: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  siteAddress: string;
  taxPercent: string;
  scheduleDays: string;
  lines: LineFormValues[];
}

export const EMPTY_LINE: LineFormValues = { description: '', quantity: '1', unitPrice: '' };

export const EMPTY_FORM: FormValues = {
  title: '',
  reason: 'customer_request',
  description: '',
  internalNotes: '',
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  siteAddress: '',
  taxPercent: '0',
  scheduleDays: '0',
  lines: [{ ...EMPTY_LINE }],
};

export type FormErrors = Partial<Record<'title' | 'description' | 'customerName' | 'customerEmail' | 'taxPercent' | 'scheduleDays' | 'lines', string>> & {
  lineErrors?: Record<number, string>;
};

export function formFromChangeOrder(co: ChangeOrder): FormValues {
  return {
    title: co.title,
    reason: co.reason,
    description: co.description,
    internalNotes: co.internal_notes,
    customerName: co.customer_name,
    customerEmail: co.customer_email ?? '',
    customerPhone: co.customer_phone ?? '',
    siteAddress: co.site_address ?? '',
    taxPercent: String(co.tax_percent),
    scheduleDays: String(co.schedule_impact_days),
    lines: co.line_items.length
      ? co.line_items.map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: centsToDollarsInput(l.unit_price_cents) }))
      : [{ ...EMPTY_LINE }],
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A line the user never touched (blank description AND blank price) is ignored, not an error. */
function isBlankLine(l: LineFormValues): boolean {
  return l.description.trim() === '' && l.unitPrice.trim() === '';
}

export function parseLines(lines: LineFormValues[]): { items: LineItem[]; errors: Record<number, string> } {
  const items: LineItem[] = [];
  const errors: Record<number, string> = {};
  lines.forEach((l, i) => {
    if (isBlankLine(l)) return;
    const desc = l.description.trim();
    const qty = Number(l.quantity.trim());
    const unit = dollarsToCents(l.unitPrice);
    if (!desc) errors[i] = 'Add a description.';
    else if (desc.length > 200) errors[i] = 'Description is too long (200 max).';
    else if (!Number.isFinite(qty) || l.quantity.trim() === '' || qty <= 0 || qty > 100000 || Math.round(qty * 100) / 100 !== qty) {
      errors[i] = 'Quantity must be above 0, with at most 2 decimals.';
    } else if (unit === null) errors[i] = 'Enter a valid price, e.g. 125.50 (use − for a credit).';
    else if (Math.abs(unit) > 100_000_000 || Math.abs(roundHalfAway(qty * unit)) > 1_000_000_000) errors[i] = 'This amount is too large.';
    else items.push({ description: desc, quantity: qty, unit_price_cents: unit });
  });
  return { items, errors };
}

/** Amount of one form row in cents, or null while the row is incomplete/invalid. */
export function lineFormAmount(l: LineFormValues): number | null {
  const { items } = parseLines([l]);
  return items.length === 1 ? lineTotalCents(items[0]) : null;
}

export function validateForm(v: FormValues): FormErrors {
  const e: FormErrors = {};
  if (!v.title.trim()) e.title = 'Give the change order a short title.';
  else if (v.title.trim().length > 160) e.title = 'Title is too long (160 max).';
  if (v.description.length > 4000) e.description = 'Description is too long (4,000 max).';
  if (!v.customerName.trim()) e.customerName = 'Customer name is required.';
  else if (v.customerName.trim().length > 160) e.customerName = 'Name is too long (160 max).';
  if (v.customerEmail.trim() && (v.customerEmail.trim().length > 254 || !EMAIL_RE.test(v.customerEmail.trim()))) e.customerEmail = 'Enter a valid email address.';
  const tax = Number(v.taxPercent.trim() === '' ? '0' : v.taxPercent);
  if (!Number.isFinite(tax) || tax < 0 || tax > 30) e.taxPercent = 'Tax must be between 0 and 30%.';
  const days = Number(v.scheduleDays.trim() === '' ? '0' : v.scheduleDays);
  if (!Number.isInteger(days) || days < -365 || days > 365) e.scheduleDays = 'Whole days between −365 and 365.';
  const { items, errors } = parseLines(v.lines);
  if (Object.keys(errors).length) e.lineErrors = errors;
  else if (items.length === 0) e.lines = 'Add at least one priced line.';
  else if (items.length > MAX_LINES) e.lines = `Too many lines (${MAX_LINES} max).`;
  return e;
}

export function hasErrors(e: FormErrors): boolean {
  return Object.keys(e).length > 0;
}

export function formTotals(v: FormValues): Totals {
  const tax = Number(v.taxPercent.trim() === '' ? '0' : v.taxPercent);
  return computeTotals(parseLines(v.lines).items, Number.isFinite(tax) ? tax : 0);
}

export function toPayload(v: FormValues): Record<string, unknown> {
  const { items } = parseLines(v.lines);
  return {
    title: v.title.trim(),
    reason: v.reason,
    description: v.description.trim(),
    internal_notes: v.internalNotes.trim(),
    customer_name: v.customerName.trim(),
    customer_email: v.customerEmail.trim(),
    customer_phone: v.customerPhone.trim(),
    site_address: v.siteAddress.trim(),
    tax_percent: Number(v.taxPercent.trim() === '' ? '0' : v.taxPercent),
    schedule_impact_days: Number(v.scheduleDays.trim() === '' ? '0' : v.scheduleDays),
    line_items: items,
  };
}

// ------------------------------------------------------------------
// Errors (DB exception codes → friendly copy)
// ------------------------------------------------------------------

const ERROR_COPY: Record<string, string> = {
  not_authorized: 'You don’t have permission to manage change orders. Ask the account owner for the “view billing” permission.',
  not_authenticated: 'Please sign in again.',
  change_order_not_found: 'This change order no longer exists.',
  change_order_locked: 'This change order was already sent, so its content can’t be edited. Cancel it and create a new one instead.',
  change_order_closed: 'This change order is already closed.',
  change_order_already_sent: 'This change order is already out for approval.',
  change_order_expired: 'This approval link has expired. Please ask the business to send it again.',
  change_order_not_approved: 'Only approved change orders can be invoiced.',
  change_order_not_billable: 'Credits and zero-dollar change orders aren’t invoiced — they adjust the contract value instead.',
  change_order_invoiced: 'An active invoice exists for this change order. Void that invoice first.',
  already_invoiced: 'This change order already has an active invoice.',
  invalid_status_transition: 'That status change isn’t allowed.',
  no_line_items: 'Add at least one priced line first.',
  parent_required: 'Pick the job or project this change applies to.',
  job_not_found: 'That job could not be found.',
  project_not_found: 'That project could not be found.',
  project_cancelled: 'This project is cancelled, so it can’t take new change orders.',
  invalid_title: 'Give the change order a title (160 characters max).',
  invalid_reason: 'Pick a valid reason.',
  invalid_line_items: 'Check the line items: each needs a description, a quantity above 0 (2 decimals max) and a whole-cent price.',
  invalid_tax: 'Tax must be between 0 and 30%.',
  invalid_schedule: 'Schedule change must be between −365 and 365 days.',
  invalid_email: 'Enter a valid email address.',
  invalid_phone: 'That phone number is too long.',
  invalid_payload: 'Some fields have invalid values. Please review the form.',
  invalid_expiry: 'Choose between 1 and 90 days.',
  invalid_decision: 'Choose approve or decline.',
  invalid_method: 'Choose how the customer responded.',
  customer_required: 'Customer name is required.',
  name_required: 'Please type your full name to sign.',
  reason_required: 'Please give a short reason.',
  text_too_long: 'One of the texts is too long.',
};

export function changeOrderError(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : '';
  for (const key of Object.keys(ERROR_COPY)) if (message.includes(key)) return ERROR_COPY[key];
  if (/permission denied/i.test(message)) return ERROR_COPY.not_authorized;
  return fallback;
}

// ------------------------------------------------------------------
// Public payload parsing (defensive: the page must never crash on a malformed row)
// ------------------------------------------------------------------

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const STATUSES: DisplayStatus[] = ['draft', 'sent', 'approved', 'declined', 'cancelled', 'expired'];

export function parsePublicChangeOrder(raw: unknown): PublicChangeOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const status = r.status as DisplayStatus;
  if (!STATUSES.includes(status) || status === 'draft') return null;
  const lines = Array.isArray(r.line_items) ? r.line_items : [];
  return {
    number: str(r.number) ?? '',
    title: str(r.title) ?? 'Change order',
    reason: (REASONS as string[]).includes(String(r.reason)) ? (r.reason as ChangeOrderReason) : 'other',
    description: str(r.description) ?? '',
    lineItems: lines.map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      return { description: str(o.description) ?? '', quantity: num(o.quantity, 1), unit_price_cents: num(o.unit_price_cents) };
    }),
    taxPercent: num(r.tax_percent),
    subtotalCents: num(r.subtotal_cents),
    taxCents: num(r.tax_cents),
    totalCents: num(r.total_cents),
    scheduleImpactDays: num(r.schedule_impact_days),
    status,
    sentAt: str(r.sent_at),
    expiresAt: str(r.expires_at),
    respondedAt: str(r.responded_at),
    approverName: str(r.approver_name),
    customerName: str(r.customer_name) ?? '',
    siteAddress: str(r.site_address),
    reference: str(r.reference),
    businessName: str(r.business_name),
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
