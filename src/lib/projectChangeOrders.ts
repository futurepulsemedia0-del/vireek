// Change Orders — pure types, calculations, validation and the status machine.
//
// No Supabase import on purpose: everything here is deterministic and unit
// tested (projectChangeOrders.test.ts). Database access lives in projectChangeOrdersApi.ts.
// The totals and the status machine mirror the database triggers in
// supabase/migrations/20280105000000_install_change_orders.sql — keep them in sync.

import {
  addDaysIso,
  daysBetween,
  formatDate,
  formatMoney,
  liveInvoice,
  revisedContractCents,
  type InstallProject,
  type InvoiceLite,
  type ProjectStatus,
} from '@/lib/installProjects';

export type ChangeOrderStatus = 'draft' | 'sent' | 'approved' | 'rejected' | 'voided';
export type ChangeOrderReason =
  | 'customer_request'
  | 'unforeseen_condition'
  | 'code_requirement'
  | 'design_change'
  | 'owner_supplied'
  | 'other';

export interface ChangeOrderLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface ChangeOrder {
  id: string;
  user_id: string;
  project_id: string;
  seq: number;
  co_number: string | null;
  title: string;
  reason: ChangeOrderReason;
  description: string | null;
  line_items: ChangeOrderLineItem[];
  markup_percent: number;
  subtotal_cents: number;
  markup_cents: number;
  cost_delta_cents: number;
  estimated_cost_cents: number;
  schedule_delta_days: number;
  status: ChangeOrderStatus;
  signature_request_id: string | null;
  sent_at: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
  invoice_id: string | null;
  invoiced_gross_cents: number | null;
  invoiced_at: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------------
// Labels & limits (limits mirror the database CHECKs / trigger)
// ------------------------------------------------------------------

export const CHANGE_ORDER_STATUS_LABEL: Record<ChangeOrderStatus, string> = {
  draft: 'Draft',
  sent: 'Awaiting signature',
  approved: 'Approved',
  rejected: 'Rejected',
  voided: 'Withdrawn',
};

export const CHANGE_ORDER_REASON_LABEL: Record<ChangeOrderReason, string> = {
  customer_request: 'Customer request',
  unforeseen_condition: 'Unforeseen condition',
  code_requirement: 'Code / permit requirement',
  design_change: 'Design change',
  owner_supplied: 'Owner-supplied materials',
  other: 'Other',
};

export const MAX_CHANGE_ORDER_LINES = 100;
export const MAX_LINE_QUANTITY = 10_000;
export const MAX_UNIT_PRICE_CENTS = 100_000_000;
export const MAX_ESTIMATED_COST_CENTS = 100_000_000_000;
export const MAX_SCHEDULE_DAYS = 365;
export const MAX_MARKUP_PERCENT = 100;

// ------------------------------------------------------------------
// Totals — exact integer math, half-away-from-zero like Postgres round()
// ------------------------------------------------------------------

function divRoundHalfAway(num: number, den: number): number {
  const abs = Math.abs(num);
  const rem = abs % den;
  const q = (abs - rem) / den + (rem * 2 >= den ? 1 : 0);
  return num < 0 && q !== 0 ? -q : q;
}

/** quantity (max 2 decimals) × unit price, rounded to whole cents. */
export function lineTotalCents(item: Pick<ChangeOrderLineItem, 'quantity' | 'unit_price_cents'>): number {
  const hundredths = Math.round(item.quantity * 100);
  return divRoundHalfAway(hundredths * item.unit_price_cents, 100);
}

/** subtotal × percent (max 2 decimals), rounded to whole cents. */
export function markupCentsFor(subtotalCents: number, percent: number): number {
  const basis = Math.round(percent * 100);
  const abs = Math.abs(subtotalCents);
  const rem = abs % 10_000;
  const whole = (abs - rem) / 10_000;
  const m = whole * basis + divRoundHalfAway(rem * basis, 10_000);
  return subtotalCents < 0 && m !== 0 ? -m : m;
}

export interface ChangeOrderTotals {
  lineCents: number[];
  subtotalCents: number;
  markupCents: number;
  totalCents: number;
}

export function changeOrderTotals(items: Pick<ChangeOrderLineItem, 'quantity' | 'unit_price_cents'>[], markupPercent: number): ChangeOrderTotals {
  const lineCents = items.map(lineTotalCents);
  const subtotalCents = lineCents.reduce((s, c) => s + c, 0);
  const markupCents = markupCentsFor(subtotalCents, markupPercent);
  return { lineCents, subtotalCents, markupCents, totalCents: subtotalCents + markupCents };
}

/** "+$1,200.00" / "-$300.00" / "$0.00". */
export function signedMoney(cents: number): string {
  return cents > 0 ? `+${formatMoney(cents)}` : formatMoney(cents);
}

export function signedDays(days: number): string {
  if (days === 0) return 'No schedule change';
  const abs = Math.abs(days);
  return `${days > 0 ? '+' : '−'}${abs} day${abs === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------
// Status machine (mirrors install_change_orders_guard)
// ------------------------------------------------------------------

export const CHANGE_ORDER_TRANSITIONS: Record<ChangeOrderStatus, ChangeOrderStatus[]> = {
  draft: ['sent', 'voided'],
  sent: ['approved', 'rejected', 'voided', 'draft'],
  approved: [],
  rejected: ['draft'],
  voided: [],
};

export function canTransition(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return CHANGE_ORDER_TRANSITIONS[from].includes(to);
}

export function isEditable(status: ChangeOrderStatus): boolean {
  return status === 'draft';
}

export function isFinalStatus(status: ChangeOrderStatus): boolean {
  return CHANGE_ORDER_TRANSITIONS[status].length === 0;
}

/** A change order must change something before it can go to the customer. */
export function isSendable(co: Pick<ChangeOrder, 'status' | 'cost_delta_cents' | 'schedule_delta_days'>): boolean {
  return co.status === 'draft' && (co.cost_delta_cents !== 0 || co.schedule_delta_days !== 0);
}

export type ChangeOrderAction = 'edit' | 'send' | 'void' | 'reopen' | 'delete' | 'invoice';

export function availableActions(
  co: Pick<ChangeOrder, 'status' | 'cost_delta_cents' | 'schedule_delta_days'>,
  projectStatus: ProjectStatus,
  hasLiveInvoice: boolean,
): ChangeOrderAction[] {
  const open = projectStatus !== 'cancelled';
  switch (co.status) {
    case 'draft':
      return [
        'edit',
        ...(open && isSendable(co) ? (['send'] as const) : []),
        'void',
        'delete',
      ];
    case 'sent':
      return ['reopen', 'void'];
    case 'rejected':
      return open ? ['reopen'] : [];
    case 'approved':
      return open && co.cost_delta_cents !== 0 && !hasLiveInvoice ? ['invoice'] : [];
    default:
      return [];
  }
}

// ------------------------------------------------------------------
// Project impact
// ------------------------------------------------------------------

export interface ChangeImpact {
  contractBeforeCents: number;
  contractAfterCents: number;
  targetEndBefore: string | null;
  targetEndAfter: string | null;
  /** Set when approving would move the target end before the project start. */
  problem: 'schedule_before_start' | null;
}

/** What approving this change order will do to the project (mirrors _co_apply_approval). */
export function approvalImpact(
  project: Pick<InstallProject, 'contract_value_cents' | 'approved_change_cents' | 'start_date' | 'target_end_date'>,
  co: Pick<ChangeOrder, 'cost_delta_cents' | 'schedule_delta_days'>,
): ChangeImpact {
  const contractBeforeCents = revisedContractCents(project);
  const before = project.target_end_date;
  const after = before && co.schedule_delta_days !== 0 ? addDaysIso(before, co.schedule_delta_days) : before;
  const problem = after && project.start_date && after < project.start_date ? 'schedule_before_start' : null;
  return {
    contractBeforeCents,
    contractAfterCents: contractBeforeCents + co.cost_delta_cents,
    targetEndBefore: before,
    targetEndAfter: after,
    problem,
  };
}

export interface ApprovedTotals {
  count: number;
  priceCents: number;
  internalCostCents: number;
  scheduleDays: number;
}

export function approvedChangeTotals(changeOrders: Pick<ChangeOrder, 'status' | 'cost_delta_cents' | 'estimated_cost_cents' | 'schedule_delta_days'>[]): ApprovedTotals {
  const t: ApprovedTotals = { count: 0, priceCents: 0, internalCostCents: 0, scheduleDays: 0 };
  for (const co of changeOrders) {
    if (co.status !== 'approved') continue;
    t.count += 1;
    t.priceCents += co.cost_delta_cents;
    t.internalCostCents += co.estimated_cost_cents;
    t.scheduleDays += co.schedule_delta_days;
  }
  return t;
}

/** Value of change orders sent to the customer and still awaiting a decision. */
export function pendingChangeCents(changeOrders: Pick<ChangeOrder, 'status' | 'cost_delta_cents'>[]): number {
  return changeOrders.filter((c) => c.status === 'sent').reduce((s, c) => s + c.cost_delta_cents, 0);
}

export type ChangeOrderBillingState = 'not_applicable' | 'not_invoiced' | 'invoiced' | 'overdue' | 'paid';

export const CHANGE_ORDER_BILLING_LABEL: Record<ChangeOrderBillingState, string> = {
  not_applicable: '',
  not_invoiced: 'Not invoiced',
  invoiced: 'Invoiced',
  overdue: 'Overdue',
  paid: 'Paid',
};

export function changeOrderBillingState(
  co: Pick<ChangeOrder, 'status' | 'cost_delta_cents' | 'invoice_id'>,
  invoices: Record<string, InvoiceLite>,
  today: string,
): ChangeOrderBillingState {
  if (co.status !== 'approved' || co.cost_delta_cents === 0) return 'not_applicable';
  const inv = liveInvoice({ invoice_id: co.invoice_id }, invoices);
  if (!inv) return 'not_invoiced';
  if (inv.status === 'paid') return 'paid';
  if (inv.due_date && inv.due_date < today) return 'overdue';
  return 'invoiced';
}

// ------------------------------------------------------------------
// Form
// ------------------------------------------------------------------

export interface ChangeOrderLineForm {
  description: string;
  quantity: string;
  unitPrice: string;
}

export interface ChangeOrderFormValues {
  title: string;
  reason: ChangeOrderReason;
  description: string;
  lines: ChangeOrderLineForm[];
  markupPercent: string;
  scheduleDays: string;
  estimatedCost: string;
}

export const emptyLine = (): ChangeOrderLineForm => ({ description: '', quantity: '1', unitPrice: '' });

export const EMPTY_CHANGE_ORDER_FORM: ChangeOrderFormValues = {
  title: '',
  reason: 'customer_request',
  description: '',
  lines: [emptyLine()],
  markupPercent: '0',
  scheduleDays: '0',
  estimatedCost: '',
};

/** "12.50", "-300", "$1,200" → cents (negative allowed for credits). Invalid → null. */
export function signedDollarsToCents(input: string): number | null {
  const clean = input.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return Number.isFinite(cents) ? (Object.is(cents, -0) ? 0 : cents) : null;
}

export function parseQuantity(input: string): number | null {
  const clean = input.replace(/\s/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  return n > 0 && n <= MAX_LINE_QUANTITY ? n : null;
}

function isBlankLine(l: ChangeOrderLineForm): boolean {
  return !l.description.trim() && !l.unitPrice.trim() && (l.quantity.trim() === '' || l.quantity.trim() === '1');
}

export interface ChangeOrderFormErrors {
  title?: string;
  description?: string;
  markupPercent?: string;
  scheduleDays?: string;
  estimatedCost?: string;
  /** Whole-form problem, e.g. too many lines. */
  form?: string;
  /** Keyed by index in `lines`. */
  lines: Record<number, string>;
}

export function hasFormErrors(e: ChangeOrderFormErrors): boolean {
  return Boolean(e.title || e.description || e.markupPercent || e.scheduleDays || e.estimatedCost || e.form || Object.keys(e.lines).length > 0);
}

export function validateChangeOrderForm(v: ChangeOrderFormValues): ChangeOrderFormErrors {
  const e: ChangeOrderFormErrors = { lines: {} };
  if (!v.title.trim()) e.title = 'Give the change order a title.';
  else if (v.title.trim().length > 160) e.title = 'Keep the title under 160 characters.';
  if (v.description.length > 4000) e.description = 'Keep the description under 4,000 characters.';

  const filled = v.lines.map((l, i) => ({ l, i })).filter(({ l }) => !isBlankLine(l));
  if (filled.length > MAX_CHANGE_ORDER_LINES) e.form = `A change order can have at most ${MAX_CHANGE_ORDER_LINES} line items.`;
  for (const { l, i } of filled) {
    const desc = l.description.trim();
    if (!desc) e.lines[i] = 'Describe this line.';
    else if (desc.length > 200) e.lines[i] = 'Keep the line description under 200 characters.';
    else if (parseQuantity(l.quantity) === null) e.lines[i] = `Quantity must be between 0.01 and ${MAX_LINE_QUANTITY.toLocaleString('en-US')} (up to 2 decimals).`;
    else {
      const unit = signedDollarsToCents(l.unitPrice);
      if (unit === null) e.lines[i] = 'Enter a dollar amount, e.g. 450 or -120.50 for a credit.';
      else if (Math.abs(unit) > MAX_UNIT_PRICE_CENTS) e.lines[i] = 'That unit price is too large.';
    }
  }

  const markup = v.markupPercent.trim() === '' ? '0' : v.markupPercent.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(markup) || Number(markup) > MAX_MARKUP_PERCENT) {
    e.markupPercent = `Markup must be between 0 and ${MAX_MARKUP_PERCENT}% (up to 2 decimals).`;
  }

  const days = v.scheduleDays.trim() === '' ? '0' : v.scheduleDays.trim();
  if (!/^-?\d+$/.test(days) || Math.abs(Number(days)) > MAX_SCHEDULE_DAYS) {
    e.scheduleDays = `Enter whole days between −${MAX_SCHEDULE_DAYS} and ${MAX_SCHEDULE_DAYS}.`;
  }

  if (v.estimatedCost.trim() !== '') {
    const cost = signedDollarsToCents(v.estimatedCost);
    if (cost === null || cost < 0 || cost > MAX_ESTIMATED_COST_CENTS) e.estimatedCost = 'Enter your estimated cost as a positive dollar amount.';
  }
  return e;
}

export interface ChangeOrderPayload {
  title: string;
  reason: ChangeOrderReason;
  description: string | null;
  line_items: ChangeOrderLineItem[];
  markup_percent: number;
  schedule_delta_days: number;
  estimated_cost_cents: number;
}

/** Call only when validateChangeOrderForm() returned no errors. */
export function toChangeOrderPayload(v: ChangeOrderFormValues): ChangeOrderPayload {
  const line_items: ChangeOrderLineItem[] = v.lines
    .filter((l) => !isBlankLine(l))
    .map((l) => ({
      description: l.description.trim(),
      quantity: parseQuantity(l.quantity) ?? 1,
      unit_price_cents: signedDollarsToCents(l.unitPrice) ?? 0,
    }));
  return {
    title: v.title.trim(),
    reason: v.reason,
    description: v.description.trim() || null,
    line_items,
    markup_percent: Number(v.markupPercent.trim() === '' ? '0' : v.markupPercent.trim()),
    schedule_delta_days: Number(v.scheduleDays.trim() === '' ? '0' : v.scheduleDays.trim()),
    estimated_cost_cents: v.estimatedCost.trim() === '' ? 0 : signedDollarsToCents(v.estimatedCost) ?? 0,
  };
}

function centsToInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function formFromChangeOrder(co: ChangeOrder): ChangeOrderFormValues {
  return {
    title: co.title,
    reason: co.reason,
    description: co.description ?? '',
    lines: co.line_items.length
      ? co.line_items.map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: centsToInput(l.unit_price_cents) }))
      : [emptyLine()],
    markupPercent: String(co.markup_percent),
    scheduleDays: String(co.schedule_delta_days),
    estimatedCost: co.estimated_cost_cents > 0 ? centsToInput(co.estimated_cost_cents) : '',
  };
}

// ------------------------------------------------------------------
// Customer-facing summary (shown on the public /sign page, max 2,000 chars)
// ------------------------------------------------------------------

const SUMMARY_LIMIT = 2000;

export function buildSignatureSummary(
  project: Pick<InstallProject, 'project_number' | 'name' | 'contract_value_cents' | 'approved_change_cents' | 'start_date' | 'target_end_date'>,
  co: Pick<ChangeOrder, 'co_number' | 'title' | 'reason' | 'description' | 'line_items' | 'markup_percent' | 'cost_delta_cents' | 'schedule_delta_days'>,
): string {
  const totals = changeOrderTotals(co.line_items, co.markup_percent);
  const impact = approvalImpact(project, co);
  const render = (shown: number): string => {
    const head = [
      `${co.co_number ?? 'Change order'} — ${co.title}`,
      `Project: ${project.project_number ? `${project.project_number} · ` : ''}${project.name}`,
      `Reason: ${CHANGE_ORDER_REASON_LABEL[co.reason]}`,
    ];
    const desc = co.description?.trim();
    if (desc) head.push('', desc.length > 400 ? `${desc.slice(0, 399)}…` : desc);
    const lines: string[] = [];
    if (co.line_items.length > 0) {
      lines.push('', 'Items:');
      co.line_items.slice(0, shown).forEach((l, i) => {
        lines.push(`• ${l.description} — ${l.quantity} × ${formatMoney(l.unit_price_cents)} = ${formatMoney(totals.lineCents[i])}`);
      });
      if (co.line_items.length > shown) lines.push(`• …and ${co.line_items.length - shown} more item${co.line_items.length - shown === 1 ? '' : 's'}`);
      if (co.markup_percent > 0) lines.push(`Subtotal ${formatMoney(totals.subtotalCents)} · Markup (${co.markup_percent}%) ${formatMoney(totals.markupCents)}`);
    }
    const tail = ['', `Total change: ${signedMoney(co.cost_delta_cents)}${co.cost_delta_cents < 0 ? ' (credit)' : ''}`];
    tail.push(
      co.schedule_delta_days === 0
        ? 'Schedule impact: none'
        : `Schedule impact: ${signedDays(co.schedule_delta_days)}${impact.targetEndAfter ? ` (new target end ${formatDate(impact.targetEndAfter)})` : ''}`,
    );
    tail.push(`Contract total: ${formatMoney(impact.contractBeforeCents)} → ${formatMoney(impact.contractAfterCents)}`);
    return [...head, ...lines, ...tail].join('\n');
  };

  let shown = co.line_items.length;
  let text = render(shown);
  while (text.length > SUMMARY_LIMIT && shown > 0) {
    shown -= 1;
    text = render(shown);
  }
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text;
}

/** Days from `fromIso` to `toIso`, used by the list to show how long a request has waited. */
export function daysWaiting(sentAt: string | null, today: string): number | null {
  if (!sentAt) return null;
  return Math.max(0, daysBetween(sentAt.slice(0, 10), today));
}
