// Pure refund types + helpers (no Supabase import) so they stay trivially testable.

export const REASON_CODES = [
  'duplicate_charge',
  'service_not_completed',
  'quality_issue',
  'pricing_adjustment',
  'customer_cancelled',
  'goodwill',
  'fraudulent',
  'other',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_META: Record<ReasonCode, { label: string; hint: string }> = {
  duplicate_charge: { label: 'Duplicate charge', hint: 'The customer was charged twice for the same work.' },
  service_not_completed: { label: 'Service not completed', hint: 'The work was cancelled or never finished.' },
  quality_issue: { label: 'Quality issue', hint: 'The customer was unhappy with the work.' },
  pricing_adjustment: { label: 'Pricing adjustment', hint: 'The final price was lower than what was charged.' },
  customer_cancelled: { label: 'Customer cancelled', hint: 'The customer cancelled after paying.' },
  goodwill: { label: 'Goodwill', hint: 'A courtesy refund to protect the relationship.' },
  fraudulent: { label: 'Fraudulent charge', hint: 'The payment was unauthorized or disputed as fraud.' },
  other: { label: 'Other', hint: 'Explain the reason in the note.' },
};

export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';
export type AccountingStatus = 'pending' | 'posted' | 'reversed' | 'failed';
export type NoticeStatus = 'not_sent' | 'sent' | 'failed' | 'skipped';

export interface Refund {
  id: string;
  user_id: string;
  payment_request_id: string;
  job_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  amount_cents: number;
  currency: string;
  reason_code: ReasonCode;
  reason_note: string | null;
  status: RefundStatus;
  stripe_refund_id: string | null;
  failure_reason: string | null;
  notify_customer: boolean;
  notice_status: NoticeStatus;
  notice_sent_at: string | null;
  credit_memo_number: string | null;
  journal_entry_id: string | null;
  accounting_status: AccountingStatus;
  accounting_error: string | null;
  created_by_email: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RefundablePayment {
  payment_request_id: string;
  job_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  amount_cents: number;
  currency: string;
  paid_at: string | null;
  refunded_cents: number;
  refundable_cents: number;
  in_flight_count: number;
}

export const REFUND_STATUS_META: Record<RefundStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' }> = {
  pending: { label: 'Processing', tone: 'accent' },
  succeeded: { label: 'Refunded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/** Strict "25", "25.5", "$1,250.00" → cents. Anything ambiguous or non-positive → null. */
export function dollarsToCents(input: string): number | null {
  const v = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function validateRefundAmount(cents: number | null, refundableCents: number, currency = 'usd'): string | null {
  if (cents === null) return 'Enter an amount like 25.00';
  if (cents > refundableCents) return `Maximum refundable is ${formatMoney(refundableCents, currency)}`;
  return null;
}

export function refundStateOf(p: Pick<RefundablePayment, 'amount_cents' | 'refunded_cents'>): 'none' | 'partial' | 'full' {
  if (p.refunded_cents <= 0) return 'none';
  return p.refunded_cents >= p.amount_cents ? 'full' : 'partial';
}

const STUCK_AFTER_MS = 2 * 60_000;

/** True when a human should look at the row: books not posted, notice failed, or Stripe call never confirmed. */
export function needsAttention(r: Refund, now = Date.now()): boolean {
  if (r.status === 'failed' || r.status === 'canceled') return r.accounting_status === 'failed';
  if (r.accounting_status === 'failed') return true;
  if (r.notify_customer && r.notice_status === 'failed') return true;
  return r.status === 'pending' && !r.stripe_refund_id && now - Date.parse(r.created_at) > STUCK_AFTER_MS;
}

export function summarizeRefunds(refunds: Refund[], now = Date.now()) {
  const since = now - 30 * 86_400_000;
  let refundedCents = 0;
  let count = 0;
  let processing = 0;
  let attention = 0;
  for (const r of refunds) {
    if (r.status === 'pending') processing += 1;
    if (needsAttention(r, now)) attention += 1;
    if ((r.status === 'succeeded' || r.status === 'pending') && Date.parse(r.created_at) >= since) {
      refundedCents += r.amount_cents;
      count += 1;
    }
  }
  return { refundedCents, count, processing, attention };
}
