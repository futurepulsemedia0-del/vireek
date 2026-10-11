import { supabase } from '@/lib/supabase';

export type ManualMethod = 'cash' | 'check';
export type PaymentMethodKind = ManualMethod | 'card_present';
export type PaymentRowStatus = 'pending' | 'succeeded' | 'failed' | 'voided';
export type DepositStatus = 'not_applicable' | 'undeposited' | 'deposited';

export const MAX_PAYMENT_CENTS = 100_000_000;
export const MIN_CARD_CENTS = 50;

export interface JobPayment {
  id: string;
  method: PaymentMethodKind;
  status: PaymentRowStatus;
  amount_cents: number;
  tendered_cents: number | null;
  received_at: string;
  note: string | null;
  check_number: string | null;
  check_bank: string | null;
  check_payer_name: string | null;
  card_brand: string | null;
  card_last4: string | null;
  deposit_status: DepositStatus;
  failure_message: string | null;
}

export interface JobPaymentSummary {
  invoice_cents: number;
  paid_cents: number;
  balance_cents: number;
  currency: string;
  card_ready: boolean;
  payments: JobPayment[];
  error?: 'not_found' | 'forbidden';
}

export interface UndepositedPayment {
  id: string;
  job_id: string;
  customer_name: string;
  method: ManualMethod;
  amount_cents: number;
  received_at: string;
  check_number: string | null;
  check_bank: string | null;
}

export interface DepositBatch {
  id: string;
  deposited_at: string;
  bank_reference: string | null;
  deposit_slip_number: string | null;
  notes: string | null;
  cash_cents: number;
  check_cents: number;
  payment_count: number;
  created_at: string;
}

export interface DepositOverview {
  undeposited: UndepositedPayment[];
  batches: DepositBatch[];
  error?: string;
}

/* ------------------------------ pure helpers ------------------------------ */

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

/** "1,234.50" / "$20" / "20.5" -> cents. Returns null for anything ambiguous or invalid. */
export function parseMoneyToCents(input: string): number | null {
  let s = input.trim().replace(/[$\s]/g, '');
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return null; // "12,50" is ambiguous -> reject
    s = s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_PAYMENT_CENTS ? cents : null;
}

export function validateCheckNumber(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim().toUpperCase();
  if (!value) return { ok: false, error: 'Enter the check number.' };
  if (!/^[A-Z0-9-]{1,20}$/.test(value)) return { ok: false, error: 'Check number can only use letters, digits and dashes (max 20).' };
  return { ok: true, value };
}

export function computeCashChange(tenderedCents: number, balanceCents: number) {
  return { appliedCents: Math.min(tenderedCents, balanceCents), changeCents: Math.max(tenderedCents - balanceCents, 0) };
}

export function summarizeSelection(items: Array<{ method: ManualMethod; amount_cents: number }>) {
  let cashCents = 0, checkCents = 0, cashCount = 0, checkCount = 0;
  for (const it of items) {
    if (it.method === 'cash') { cashCents += it.amount_cents; cashCount++; } else { checkCents += it.amount_cents; checkCount++; }
  }
  return { cashCents, checkCents, cashCount, checkCount, totalCents: cashCents + checkCents, count: items.length };
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: 'Please sign in again.',
  forbidden: "You can't take payments for this job.",
  not_found: 'This job or payment was not found.',
  invalid_method: 'Unsupported payment method.',
  invalid_amount: 'Enter a valid amount.',
  exceeds_balance: 'That is more than the balance due.',
  no_invoice_amount: 'Set an invoice amount on this job before taking payment.',
  invalid_check_number: 'Enter a valid check number (letters, digits, dashes).',
  duplicate_check_number: 'This check number was already recorded for this job.',
  postdated_check: 'This check is post-dated and cannot be accepted yet.',
  tendered_less_than_amount: 'Cash received is less than the amount being applied.',
  reason_required: 'Please give a reason.',
  use_stripe_refund: 'Card payments must be refunded from Stripe.',
  not_voidable: 'This payment can no longer be voided.',
  already_deposited: 'This payment is already deposited.',
  no_payments: 'Select at least one payment.',
  too_many_payments: 'Too many payments selected (max 200).',
  invalid_deposit_date: 'Deposit date cannot be in the future.',
  invalid_selection: 'Some selected payments are no longer available. Refresh and try again.',
  payment_in_progress: 'A card payment is still in progress for this job.',
  stripe_not_ready: 'Stripe is not fully set up for card payments yet.',
  terminal_setup: 'Tap to Pay setup is incomplete.',
};

export function describePaymentError(code: string | undefined, fallback = 'Something went wrong. Please try again.'): string {
  return (code && ERROR_MESSAGES[code]) || fallback;
}

/* ------------------------------ RPC wrappers ------------------------------ */

export async function fetchJobPaymentSummary(jobId: string): Promise<JobPaymentSummary> {
  const { data, error } = await supabase.rpc('get_job_payment_summary', { p_job_id: jobId });
  if (error) throw error;
  const res = data as JobPaymentSummary;
  if (res.error) throw new Error(describePaymentError(res.error));
  return res;
}

export interface ManualPaymentInput {
  jobId: string;
  method: ManualMethod;
  amountCents: number;
  clientRequestId: string;
  tenderedCents?: number;
  checkNumber?: string;
  checkBank?: string;
  checkPayer?: string;
  checkDate?: string;
  note?: string;
}

export interface ManualPaymentResult {
  success: boolean;
  error?: string;
  payment_id?: string;
  balance_cents?: number;
  duplicate?: boolean;
  invoice_gate_blocked?: boolean;
  invoice_gate_message?: string | null;
  warning?: string | null;
}

export async function recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentResult> {
  const { data, error } = await supabase.rpc('record_manual_payment', {
    p_job_id: input.jobId,
    p_method: input.method,
    p_amount_cents: input.amountCents,
    p_check_number: input.checkNumber ?? null,
    p_check_bank: input.checkBank ?? null,
    p_check_payer: input.checkPayer ?? null,
    p_tendered_cents: input.tenderedCents ?? null,
    p_note: input.note ?? null,
    p_client_request_id: input.clientRequestId,
    p_check_date: input.checkDate ?? null,
  });
  if (error) throw error;
  return data as ManualPaymentResult;
}

export async function voidJobPayment(paymentId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('void_job_payment', { p_payment_id: paymentId, p_reason: reason });
  if (error) throw error;
  return data as { success: boolean; error?: string };
}

export async function fetchDepositOverview(): Promise<DepositOverview> {
  const { data, error } = await supabase.rpc('get_deposit_overview');
  if (error) throw error;
  const res = data as DepositOverview;
  if (res.error) throw new Error(describePaymentError(res.error));
  return res;
}

export async function createDepositBatch(input: {
  paymentIds: string[];
  depositedAt: string;
  bankReference?: string;
  slipNumber?: string;
  notes?: string;
}): Promise<{ success: boolean; error?: string; batch_id?: string; cash_cents?: number; check_cents?: number; payment_count?: number }> {
  const { data, error } = await supabase.rpc('create_deposit_batch', {
    p_payment_ids: input.paymentIds,
    p_deposited_at: input.depositedAt,
    p_bank_reference: input.bankReference ?? null,
    p_slip_number: input.slipNumber ?? null,
    p_notes: input.notes ?? null,
  });
  if (error) throw error;
  return data as { success: boolean; error?: string; batch_id?: string; cash_cents?: number; check_cents?: number; payment_count?: number };
}

/* --------------------------- Terminal edge function --------------------------- */

export class PaymentError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function invokeTerminal<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('terminal-payments', { body: { action, ...body } });
  if (error) {
    let payload: { error?: string; code?: string } | null = null;
    try { payload = await (error as { context?: Response }).context?.json(); } catch { /* not JSON */ }
    throw new PaymentError(payload?.error || describePaymentError(payload?.code), payload?.code);
  }
  if (data?.error) throw new PaymentError(data.error, data.code);
  return data as T;
}

export interface CardIntent { job_payment_id: string; client_secret: string; payment_intent_id: string; amount_cents: number; location_id: string }
export interface CardFinalizeResult { status: PaymentRowStatus | 'mismatch'; balance_cents: number | null; invoice_gate_blocked?: boolean; invoice_gate_message?: string | null }

export const createCardIntent = (i: { jobId: string; amountCents: number; clientRequestId: string }) =>
  invokeTerminal<CardIntent>('create_intent', { job_id: i.jobId, amount_cents: i.amountCents, client_request_id: i.clientRequestId });
export const finalizeCardPayment = (jobPaymentId: string) => invokeTerminal<CardFinalizeResult>('finalize', { job_payment_id: jobPaymentId });
export const cancelCardPayment = (jobPaymentId: string) => invokeTerminal<{ status: string }>('cancel', { job_payment_id: jobPaymentId });
export const fetchConnectionToken = () => invokeTerminal<{ secret: string; location_id: string; is_test: boolean }>('connection_token', {});
