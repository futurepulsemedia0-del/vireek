import { supabase } from '@/lib/supabase';
import { calculateQuoteTotals, isOverdue, type Invoice } from '@/lib/invoices';

// ============================================================
// Types
// ============================================================

export type PaymentMethod = 'cash' | 'check' | 'card' | 'bank_transfer' | 'other';

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  other: 'Other',
};

export interface InvoicePayment {
  id: string;
  invoice_id: string;
  amount_cents: number;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  paid_at: string;
  created_by_email: string | null;
  created_at: string;
}

export interface InvoiceRefund {
  id: string;
  invoice_id: string;
  payment_id: string;
  amount_cents: number;
  reason: string;
  refunded_at: string;
  created_by_email: string | null;
  created_at: string;
}

export type ReminderKind = 'initial' | 'resend' | 'reminder';

export interface InvoiceReminder {
  id: string;
  invoice_id: string;
  kind: ReminderKind;
  channel: 'email';
  recipient: string;
  status: 'sent' | 'failed';
  error: string | null;
  sent_by_email: string | null;
  created_at: string;
}

export interface InvoiceAuditEntry {
  id: string;
  action: string;
  actor_email: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface InvoiceDetailData {
  invoice: Invoice;
  payments: InvoicePayment[];
  refunds: InvoiceRefund[];
  reminders: InvoiceReminder[];
  businessName: string | null;
}

// ============================================================
// Pure logic (unit-tested)
// ============================================================

export type PaymentState = 'void' | 'unpaid' | 'partial' | 'paid' | 'refunded';

export interface InvoiceLedger {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  balanceCents: number;
  state: PaymentState;
}

export function computeInvoiceLedger(
  invoice: Pick<Invoice, 'line_items' | 'tax_percent' | 'status'>,
  payments: Pick<InvoicePayment, 'amount_cents'>[],
  refunds: Pick<InvoiceRefund, 'amount_cents'>[],
): InvoiceLedger {
  const { subtotalCents, taxCents, totalCents } = calculateQuoteTotals(invoice.line_items ?? [], invoice.tax_percent ?? 0);
  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  const refundedCents = refunds.reduce((s, r) => s + r.amount_cents, 0);
  const netPaidCents = paidCents - refundedCents;
  const balanceCents = Math.max(0, totalCents - netPaidCents);

  let state: PaymentState;
  if (invoice.status === 'void') state = 'void';
  else if (paidCents > 0 && netPaidCents <= 0) state = 'refunded';
  else if (totalCents > 0 && netPaidCents >= totalCents) state = 'paid';
  else if (netPaidCents > 0) state = 'partial';
  else state = 'unpaid';

  return { subtotalCents, taxCents, totalCents, paidCents, refundedCents, netPaidCents, balanceCents, state };
}

/** How much of a single payment can still be refunded. */
export function refundableForPayment(
  payment: Pick<InvoicePayment, 'id' | 'amount_cents'>,
  refunds: Pick<InvoiceRefund, 'payment_id' | 'amount_cents'>[],
): number {
  const refunded = refunds.filter((r) => r.payment_id === payment.id).reduce((s, r) => s + r.amount_cents, 0);
  return Math.max(0, payment.amount_cents - refunded);
}

export type MoneyParse = { ok: true; cents: number } | { ok: false; error: string };

/**
 * Parses a user-typed dollar amount into integer cents without float math
 * ("19.99" -> 1999, "0.1" -> 10). Rejects empty, negative, zero, >2 decimals
 * and anything above `maxCents`.
 */
export function parseMoneyInput(raw: string, maxCents: number): MoneyParse {
  const value = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!value) return { ok: false, error: 'Enter an amount.' };
  if (!/^\d+(\.\d{0,2})?$/.test(value)) return { ok: false, error: 'Use a positive amount with at most 2 decimals.' };
  const [whole, frac = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
  if (cents > maxCents) return { ok: false, error: `Amount can't exceed $${(maxCents / 100).toFixed(2)}.` };
  return { ok: true, cents };
}

export type DisplayStatus = 'draft' | 'sent' | 'viewed' | 'partial' | 'paid' | 'refunded' | 'overdue' | 'void';

export function getDisplayStatus(invoice: Invoice, ledger: InvoiceLedger): DisplayStatus {
  if (invoice.status === 'void') return 'void';
  if (ledger.state === 'refunded') return 'refunded';
  if (ledger.state === 'paid') return 'paid';
  if (isOverdue(invoice)) return 'overdue';
  if (ledger.state === 'partial') return 'partial';
  return invoice.status as DisplayStatus;
}

export const DISPLAY_STATUS_STYLES: Record<DisplayStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-cta/15 text-cta',
  viewed: 'bg-warning-500/15 text-warning-500',
  partial: 'bg-warning-500/15 text-warning-500',
  paid: 'bg-success-500/15 text-success-500',
  refunded: 'bg-bg-tertiary text-text-secondary',
  overdue: 'bg-danger-500/15 text-danger-500',
  void: 'bg-bg-tertiary text-text-secondary',
};

export const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  partial: 'Partially paid',
  paid: 'Paid',
  refunded: 'Refunded',
  overdue: 'Overdue',
  void: 'Void',
};

export type TimelineKind = 'created' | 'sent' | 'viewed' | 'payment' | 'refund' | 'reminder' | 'paid' | 'void';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  at: string;
  title: string;
  detail?: string;
  amountCents?: number;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

/** Merges every dated thing that happened to an invoice into one newest-first feed. */
export function buildTimeline(
  invoice: Invoice,
  payments: InvoicePayment[],
  refunds: InvoiceRefund[],
  reminders: InvoiceReminder[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [{ id: 'created', kind: 'created', at: invoice.created_at, title: 'Invoice created', tone: 'neutral' }];
  if (invoice.sent_at) events.push({ id: 'sent', kind: 'sent', at: invoice.sent_at, title: 'Marked as sent', tone: 'neutral' });
  if (invoice.viewed_at) events.push({ id: 'viewed', kind: 'viewed', at: invoice.viewed_at, title: 'Viewed by customer', tone: 'warning' });
  for (const p of payments) {
    events.push({
      id: `pay-${p.id}`,
      kind: 'payment',
      at: p.paid_at,
      title: `Payment received · ${PAYMENT_METHOD_LABELS[p.method] ?? p.method}`,
      detail: [p.reference, p.note].filter(Boolean).join(' · ') || undefined,
      amountCents: p.amount_cents,
      tone: 'success',
    });
  }
  for (const r of refunds) {
    events.push({ id: `ref-${r.id}`, kind: 'refund', at: r.refunded_at, title: 'Refund recorded', detail: r.reason, amountCents: r.amount_cents, tone: 'danger' });
  }
  for (const r of reminders) {
    const label = r.kind === 'reminder' ? 'Reminder' : r.kind === 'resend' ? 'Invoice re-sent' : 'Invoice emailed';
    events.push({
      id: `rem-${r.id}`,
      kind: 'reminder',
      at: r.created_at,
      title: r.status === 'sent' ? `${label} to ${r.recipient}` : `${label} failed (${r.recipient})`,
      detail: r.status === 'failed' ? (r.error ?? undefined) : undefined,
      tone: r.status === 'sent' ? 'neutral' : 'danger',
    });
  }
  if (invoice.status === 'void') events.push({ id: 'void', kind: 'void', at: invoice.updated_at, title: 'Invoice voided', tone: 'danger' });
  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

const AUDIT_LABELS: Record<string, string> = {
  invoice_sent: 'Invoice emailed',
  invoice_resent: 'Invoice re-sent',
  invoice_reminder_sent: 'Reminder emailed',
  invoice_payment_recorded: 'Payment recorded',
  invoice_refund_recorded: 'Refund recorded',
  invoice_voided: 'Invoice voided',
};

export function auditActionLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Milliseconds until another reminder may be sent (0 = allowed now). Mirrors the edge function. */
export function reminderCooldownMs(reminders: Pick<InvoiceReminder, 'kind' | 'status' | 'created_at'>[], now = Date.now()): number {
  const last = reminders
    .filter((r) => r.kind === 'reminder' && r.status === 'sent')
    .map((r) => new Date(r.created_at).getTime())
    .sort((a, b) => b - a)[0];
  if (last === undefined) return 0;
  return Math.max(0, last + REMINDER_COOLDOWN_MS - now);
}

// ============================================================
// Data access (all reads scoped to the account owner)
// ============================================================

export async function fetchInvoiceDetail(ownerId: string, invoiceId: string): Promise<InvoiceDetailData | null> {
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!invoice) return null;

  const [payments, refunds, reminders, profile] = await Promise.all([
    supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).eq('user_id', ownerId).order('paid_at', { ascending: false }),
    supabase.from('invoice_refunds').select('*').eq('invoice_id', invoiceId).eq('user_id', ownerId).order('refunded_at', { ascending: false }),
    supabase.from('invoice_reminders').select('*').eq('invoice_id', invoiceId).eq('user_id', ownerId).order('created_at', { ascending: false }),
    supabase.from('profiles').select('company_name').eq('id', ownerId).maybeSingle(),
  ]);
  if (payments.error) throw payments.error;
  if (refunds.error) throw refunds.error;
  if (reminders.error) throw reminders.error;

  return {
    invoice: invoice as Invoice,
    payments: (payments.data ?? []) as InvoicePayment[],
    refunds: (refunds.data ?? []) as InvoiceRefund[],
    reminders: (reminders.data ?? []) as InvoiceReminder[],
    businessName: (profile.data as { company_name: string | null } | null)?.company_name ?? null,
  };
}

export async function fetchInvoiceAuditTrail(invoiceId: string): Promise<InvoiceAuditEntry[]> {
  const { data, error } = await supabase.rpc('get_invoice_audit_trail', { p_invoice_id: invoiceId });
  if (error) throw error;
  return (data ?? []) as InvoiceAuditEntry[];
}

export async function recordInvoicePayment(input: {
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  reference?: string;
  note?: string;
  paidAt?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('record_invoice_payment', {
    p_invoice_id: input.invoiceId,
    p_amount_cents: input.amountCents,
    p_method: input.method,
    p_reference: input.reference?.trim() || null,
    p_paid_at: input.paidAt ?? null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw error;
}

/**
 * "Mark paid" for the invoices list: records ONE payment for the exact
 * remaining balance, so the ledger (payments table) and invoice status never
 * disagree. No-op when nothing is owed.
 */
export async function markInvoiceFullyPaid(invoiceId: string, method: PaymentMethod = 'other'): Promise<void> {
  const { data: invoice, error } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
  if (error) throw error;
  if (!invoice) throw new Error('Invoice not found.');
  const [payments, refunds] = await Promise.all([
    supabase.from('invoice_payments').select('amount_cents').eq('invoice_id', invoiceId),
    supabase.from('invoice_refunds').select('amount_cents').eq('invoice_id', invoiceId),
  ]);
  if (payments.error) throw payments.error;
  if (refunds.error) throw refunds.error;
  const ledger = computeInvoiceLedger(invoice as Invoice, (payments.data ?? []) as InvoicePayment[], (refunds.data ?? []) as InvoiceRefund[]);
  if (ledger.balanceCents <= 0) return;
  await recordInvoicePayment({ invoiceId, amountCents: ledger.balanceCents, method });
}

export async function recordInvoiceRefund(input: {
  invoiceId: string;
  paymentId: string;
  amountCents: number;
  reason: string;
}): Promise<void> {
  const { error } = await supabase.rpc('record_invoice_refund', {
    p_invoice_id: input.invoiceId,
    p_payment_id: input.paymentId,
    p_amount_cents: input.amountCents,
    p_reason: input.reason.trim(),
  });
  if (error) throw error;
}

export async function voidInvoice(invoiceId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_invoice', { p_invoice_id: invoiceId, p_reason: reason.trim() });
  if (error) throw error;
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new Error(body.error);
    } catch {
      /* body was not JSON */
    }
    return new Error('Could not send the email. Please try again.');
  }
  return new Error('Could not reach the server. Check your connection and try again.');
}

export async function sendInvoiceEmail(invoiceId: string, kind: ReminderKind): Promise<{ recipient: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('invoice-email', {
    body: { invoice_id: invoiceId, kind },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readFunctionError(error);
  const payload = data as { ok?: boolean; recipient?: string; error?: string } | null;
  if (!payload?.ok) throw new Error(payload?.error ?? 'Could not send the email.');
  return { recipient: payload.recipient ?? '' };
}

/** The error message from a Supabase RPC/PostgREST failure, safe to show in a toast. */
export function rpcErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' && m ? m : fallback;
}
