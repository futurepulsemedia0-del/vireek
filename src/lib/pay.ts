// src/lib/pay.ts
// Vireek Pay & Capital — types and PURE helpers (no network, no React). Unit-tested in pay.test.ts.
// Data access lives in payApi.ts. Server-side rules: supabase/functions/_shared/pay/.

export { formatCents } from '@/lib/payroll';
export { parseMoneyToCents } from '@/lib/inPersonPayments';

export type PayProduct = 'instant_payouts' | 'earned_wage_access' | 'spend_cards' | 'capital';
export type PayMode = 'sandbox' | 'live';
export type TransferKind = 'instant_payout' | 'earned_wage_advance';
export type TransferStatus = 'pending_provider' | 'processing' | 'paid' | 'failed' | 'needs_review' | 'reversed' | 'canceled';

export const PAY_PRODUCTS: PayProduct[] = ['instant_payouts', 'earned_wage_access', 'spend_cards', 'capital'];

export const PRODUCT_LABEL: Record<PayProduct, string> = {
  instant_payouts: 'Instant payouts',
  earned_wage_access: 'Earned wage access',
  spend_cards: 'Spend cards',
  capital: 'Vireek Capital',
};

export interface ProductAvailability {
  product: PayProduct;
  available: boolean;
  mode: PayMode;
  reason: string | null;
  partner_name: string | null;
}

export interface DisclosureDoc {
  key: string;
  version: number;
  title: string;
  body: string;
  content_sha256: string;
  legal_reviewed: boolean;
  accepted: boolean;
}

export interface TransferRow {
  id: string;
  kind: TransferKind;
  status: TransferStatus;
  amount_cents: number;
  fee_cents: number;
  receive_cents: number;
  sandbox: boolean;
  holder_name: string | null;
  failure_code: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface EwaQuote {
  kind: 'earned_wage_advance';
  mode: PayMode;
  sandbox: boolean;
  partner_name: string | null;
  accruedGrossCents: number;
  accruedNetEstimateCents: number;
  ceilingCents: number;
  outstandingAdvanceCents: number;
  availableCents: number;
  reasons: string[];
  fee_schedule: { fee_bps: number; min_fee_cents: number; max_fee_cents: number };
  disclosure: { key: string; accepted: boolean };
  payout_account: { last4: string | null; account_type: string } | null;
}

export interface InstantItemQuote {
  item_id: string;
  pay_date: string;
  net_pay_cents: number;
  quote: { ok: true; amountCents: number; feeCents: number; receiveCents: number } | { ok: false; code: string };
}
export interface InstantQuote {
  kind: 'instant_payout';
  mode: PayMode;
  sandbox: boolean;
  partner_name: string | null;
  items: InstantItemQuote[];
  disclosure: { key: string; accepted: boolean };
  payout_account: { last4: string | null; account_type: string } | null;
}

export interface SpendCard {
  id: string;
  team_member_id: string | null;
  holder_name: string;
  card_type: 'virtual' | 'physical';
  brand: string | null;
  last4: string | null;
  status: 'pending' | 'active' | 'frozen' | 'canceled';
  per_txn_limit_cents: number;
  daily_limit_cents: number;
  monthly_limit_cents: number;
  allowed_mcc: string[] | null;
  blocked_mcc: string[];
  receipt_required_over_cents: number;
  sandbox: boolean;
}

export interface CardTransaction {
  id: string;
  user_id: string;
  card_id: string;
  status: 'approved' | 'declined' | 'settled' | 'reversed';
  decline_code: string | null;
  amount_cents: number;
  merchant_name: string | null;
  mcc: string | null;
  memo: string | null;
  receipt_path: string | null;
  sandbox: boolean;
  created_at: string;
}

export interface CapitalApplication {
  id: string;
  status: string;
  sandbox: boolean;
  requested_amount_cents: number | null;
  created_at: string;
  decline_reasons: string[] | null;
}

export interface CapitalOffer {
  id: string;
  application_id: string;
  status: 'open' | 'accepted' | 'expired' | 'withdrawn';
  sandbox: boolean;
  offered_amount_cents: number;
  total_repayment_cents: number;
  finance_charge_cents: number;
  term_days: number;
  estimated_apr_bps: number;
  repayment_description: string;
  terms_url: string | null;
  expires_at: string;
}

export interface PrescreenReceivable { invoiceId: string; amountCents: number; dueDate: string | null; issuedAt: string; customerRef: string }
export interface PrescreenResponse {
  application: { id: string; status: string };
  sandbox: boolean;
  outcome: 'eligible_to_apply' | 'not_yet_eligible';
  reasons: { code: string; text: string }[];
  eligibleReceivables: PrescreenReceivable[];
  eligibleReceivablesCents: number;
  profile: { monthsOfHistory: number; trailing12mCents: number; trailing3mCents: number; paidInvoiceCount12m: number; avgDaysToPay: number | null; onTimeRate: number | null };
  notice: string;
}

export interface SettlementRow {
  item_id: string;
  employee_id: string;
  employee_name: string;
  net_pay_cents: number;
  instant_paid_cents: number;
  outstanding_advance_cents: number;
  recommended_recovery_cents: number;
  disbursement_due_cents: number;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const UNAVAILABLE_COPY: Record<string, string> = {
  killed: 'This feature has been paused by Vireek. Nothing is being sent.',
  platform_disabled: 'This feature is not available yet.',
  tenant_frozen: 'This feature is paused for your account. Contact support.',
  disclosures_not_reviewed: 'This feature is being prepared and is not available yet.',
  unknown_product: 'This feature is not available.',
  no_tenant: 'Sign in to use this feature.',
};

export function describeUnavailable(reason: string | null | undefined): string {
  return UNAVAILABLE_COPY[reason ?? ''] ?? 'This feature is not available right now.';
}

const ERROR_COPY: Record<string, string> = {
  unavailable: 'This feature is not available right now.',
  provider_not_configured: 'The payment partner is not connected yet, so nothing was sent.',
  not_a_technician: 'Only technicians can use this.',
  no_pay_profile: 'Your employer has not set up your pay profile yet.',
  disclosure_required: 'Please read and accept the terms first.',
  no_payout_account: 'Link a payout account first.',
  account_not_instant_eligible: 'Your linked account cannot receive instant payouts.',
  invalid_amount: 'Enter a valid amount.',
  below_minimum: 'That amount is below the minimum.',
  exceeds_available: 'That is more than you can take right now.',
  fee_exceeds_amount: 'The fee would be more than the amount.',
  daily_cap_reached: 'The daily limit has been reached. Try again tomorrow.',
  item_not_eligible: 'That paycheck is not eligible for an instant payout.',
  item_already_requested: 'An instant payout for that paycheck is already in progress.',
  idempotency_key_reused: 'That request was already used. Please try again.',
  forbidden: 'Only an owner or admin can do this.',
  not_eligible: 'Your account does not meet the pre-screen criteria yet.',
  receivable_not_eligible: 'One of the selected invoices no longer qualifies.',
  receivable_already_pledged: 'One of the selected invoices is already in another application.',
  amount_exceeds_pledged_receivables: 'The amount is more than the selected invoices total.',
  mode_mismatch: 'This item was created in a different mode.',
  not_supported_in_mode: 'That action is only available in sandbox mode.',
  invalid_state: 'That action is not available in the current state.',
  offer_not_available: 'That offer is no longer available.',
  limits_not_ascending: 'Limits must go per-purchase ≤ daily ≤ monthly.',
  limits_must_be_positive_integers: 'Limits must be positive amounts.',
  per_txn_above_platform_cap: 'The per-purchase limit is above the platform maximum.',
  invalid_mcc: 'Merchant category codes must be 4 digits.',
  holder_not_found: 'That team member was not found.',
};

export function describePayError(code: string | null | undefined, fallback = 'Something went wrong. Nothing was sent.'): string {
  return (code && ERROR_COPY[code]) || fallback;
}

export const DECLINE_COPY: Record<string, string> = {
  card_not_active: 'Card not active',
  invalid_amount: 'Invalid amount',
  unsupported_currency: 'Unsupported currency',
  platform_cap_exceeded: 'Above platform maximum',
  mcc_blocked: 'Merchant category blocked',
  mcc_not_allowed: 'Merchant category not allowed',
  mcc_unknown: 'Merchant category unknown',
  per_transaction_limit: 'Over per-purchase limit',
  daily_limit: 'Over daily limit',
  monthly_limit: 'Over monthly limit',
};

export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

export function transferStatusInfo(s: TransferStatus): { label: string; tone: Tone } {
  switch (s) {
    case 'paid': return { label: 'Paid', tone: 'success' };
    case 'processing':
    case 'pending_provider': return { label: 'Sending', tone: 'warning' };
    case 'needs_review': return { label: 'Under review', tone: 'warning' };
    case 'failed': return { label: 'Failed', tone: 'danger' };
    case 'reversed': return { label: 'Reversed', tone: 'danger' };
    default: return { label: 'Canceled', tone: 'neutral' };
  }
}

export const transferKindLabel = (k: TransferKind): string => (k === 'instant_payout' ? 'Instant payout' : 'Earned wage advance');

// ---------------------------------------------------------------------------
// Formatting + small pure helpers
// ---------------------------------------------------------------------------

/** 2400 → "24.00%". */
export const aprLabel = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

export const termLabel = (days: number): string =>
  days % 30 === 0 && days >= 60 ? `${days / 30} months` : days === 1 ? '1 day' : `${days} days`;

/** Fee as a customer-friendly sentence for the quote screen. */
export function feeSentence(amountCents: number, feeCents: number, fmt: (c: number) => string): string {
  return feeCents === 0 ? 'No fee.' : `Fee ${fmt(feeCents)} — you receive ${fmt(amountCents - feeCents)}.`;
}

/** Outstanding advances are repaid from the next paycheck: how much of it would remain? */
export const takeHomeAfterRecovery = (netPayCents: number, recoveryCents: number): number => Math.max(0, netPayCents - Math.max(0, recoveryCents));

export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export const isSandbox = (rows: { sandbox: boolean }[]): boolean => rows.some((r) => r.sandbox);

/** Parses "5251, 5072 ,x" → { valid: ['5251','5072'], invalid: ['x'] } (4-digit MCCs). */
export function parseMccList(input: string): { valid: string[]; invalid: string[] } {
  const parts = input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const valid = [...new Set(parts.filter((p) => /^[0-9]{4}$/.test(p)))];
  return { valid, invalid: parts.filter((p) => !/^[0-9]{4}$/.test(p)) };
}

/** Receipt still missing for a settled/approved purchase above the card's threshold? */
export const needsReceipt = (t: Pick<CardTransaction, 'amount_cents' | 'receipt_path' | 'status'>, thresholdCents: number): boolean =>
  (t.status === 'approved' || t.status === 'settled') && t.amount_cents > thresholdCents && !t.receipt_path;

export const offerIsExpired = (o: Pick<CapitalOffer, 'expires_at' | 'status'>, now = Date.now()): boolean =>
  o.status !== 'open' || Date.parse(o.expires_at) <= now;

/** Total cost summary every offer card must show. */
export function offerCostRows(o: CapitalOffer, fmt: (c: number) => string): { label: string; value: string }[] {
  return [
    { label: 'Amount you receive', value: fmt(o.offered_amount_cents) },
    { label: 'Total you repay', value: fmt(o.total_repayment_cents) },
    { label: 'Finance charge', value: fmt(o.finance_charge_cents) },
    { label: 'Term', value: termLabel(o.term_days) },
    { label: 'Estimated APR', value: aprLabel(o.estimated_apr_bps) },
  ];
}

/** Fields the admin form may patch; mirrors staff_pay_update_control(). */
export interface ControlRow {
  product: PayProduct;
  enabled: boolean;
  mode: PayMode;
  partner_name: string | null;
  partner_agreement_ref: string | null;
  live_approved_at: string | null;
  killed_at: string | null;
  kill_reason: string | null;
  fee_bps: number;
  min_fee_cents: number;
  max_fee_cents: number;
  max_single_cents: number;
  max_daily_tenant_cents: number;
  max_pct_of_accrued: number;
  updated_at: string;
}

export type ControlState = { label: string; tone: Tone };
export function describeControl(c: Pick<ControlRow, 'enabled' | 'mode' | 'killed_at'>): ControlState {
  if (c.killed_at) return { label: 'KILLED', tone: 'danger' };
  if (!c.enabled) return { label: 'Off', tone: 'neutral' };
  return c.mode === 'live' ? { label: 'LIVE', tone: 'success' } : { label: 'Sandbox', tone: 'warning' };
}

/** Client-side guard before calling staff_pay_update_control (the server re-checks everything). */
export function validateControlPatch(c: ControlRow, patch: Partial<ControlRow>, reason: string): string | null {
  if (reason.trim().length < 8) return 'Write a reason of at least 8 characters.';
  const mode = patch.mode ?? c.mode;
  const ref = patch.partner_agreement_ref !== undefined ? patch.partner_agreement_ref : c.partner_agreement_ref;
  if (mode === 'live' && !(ref && ref.trim().length >= 3)) return 'Live mode needs a partner agreement reference.';
  const min = patch.min_fee_cents ?? c.min_fee_cents;
  const max = patch.max_fee_cents ?? c.max_fee_cents;
  if (max < min) return 'Maximum fee cannot be below the minimum fee.';
  const bps = patch.fee_bps ?? c.fee_bps;
  if (bps < 0 || bps > 2500) return 'Fee must be between 0 and 25%.';
  return null;
}
