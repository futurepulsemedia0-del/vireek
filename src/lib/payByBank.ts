/**
 * Pay by Bank — client layer. RLS scopes reads to the account owner; the explicit `.eq('user_id', ownerId)` is
 * defence-in-depth (accountOwnerId scoping). Every write goes through RPCs / edge functions.
 * Server logic: supabase/functions/_shared/bankPayments/*, migration 20271115000000_pay_by_bank.sql.
 */
import { supabase } from '@/lib/supabase';

export type AttemptStatus = 'verification_required' | 'processing' | 'succeeded' | 'failed' | 'returned' | 'disputed' | 'canceled';
export type AccountingStatus = 'pending' | 'posted' | 'unlinked' | 'reversed' | 'failed' | 'skipped';
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BankSettingsRow {
  user_id: string;
  enabled: boolean;
  routing_mode: 'offer' | 'prefer';
  min_amount_cents: number;
  max_amount_cents: number;
  provisional_membership_access: boolean;
  provisional_limit_cents: number;
  rtp_enabled: boolean;
  fednow_enabled: boolean;
  capability_status: 'unknown' | 'inactive' | 'pending' | 'active';
  capability_checked_at: string | null;
}

export interface AttemptRow {
  id: string;
  customer_name: string | null;
  rail: 'ach_debit' | 'instant_bank' | 'rtp' | 'fednow';
  amount_cents: number;
  fee_estimate_cents: number;
  card_fee_estimate_cents: number;
  status: AttemptStatus;
  verification_method: 'instant' | 'microdeposits' | null;
  failure_code: string | null;
  failure_message: string | null;
  return_code: string | null;
  retryable: boolean | null;
  bank_name: string | null;
  account_last4: string | null;
  expected_settlement_date: string | null;
  settled_at: string | null;
  accounting_status: AccountingStatus;
  accounting_error: string | null;
  payment_request_id: string | null;
  installment_id: string | null;
  membership_id: string | null;
  created_at: string;
}

export interface Suggestion { customer_name: string; payments: number; card_volume_cents: number; potential_savings_cents: number; reason: string }

export interface BankStats {
  days: number;
  bank_collected_cents: number;
  in_flight_cents: number;
  in_flight_count: number;
  succeeded_count: number;
  failed_count: number;
  returned_count: number;
  success_rate: number | null;
  fees_saved_cents: number;
  avg_settle_days: number | null;
  needs_review_count: number;
  card_volume_cents: number;
  potential_savings_cents: number;
  suggestions: Suggestion[];
}

export interface LinkableInvoice { id: string; invoice_number: string; balance_cents: number; due_date: string; status: string }

export type SettingsPatch = Partial<Pick<BankSettingsRow,
  'enabled' | 'routing_mode' | 'min_amount_cents' | 'max_amount_cents' | 'provisional_membership_access' | 'provisional_limit_cents'>>;

const rpcError = (error: { message?: string } | null, fallback: string) => new Error(error?.message || fallback);

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function fetchBankSettings(ownerId: string): Promise<BankSettingsRow | null> {
  const { data, error } = await supabase.from('bank_payment_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as BankSettingsRow | null;
}

export async function fetchBankAttempts(ownerId: string, limit = 200): Promise<AttemptRow[]> {
  const { data, error } = await supabase
    .from('bank_payment_attempts')
    .select('id, customer_name, rail, amount_cents, fee_estimate_cents, card_fee_estimate_cents, status, verification_method, failure_code, failure_message, return_code, retryable, bank_name, account_last4, expected_settlement_date, settled_at, accounting_status, accounting_error, payment_request_id, installment_id, membership_id, created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AttemptRow[];
}

export async function fetchBankStats(days = 90): Promise<BankStats> {
  const { data, error } = await supabase.rpc('get_bank_payment_stats', { p_days: days });
  if (error) throw error;
  return data as BankStats;
}

export async function saveBankSettings(patch: SettingsPatch): Promise<BankSettingsRow> {
  const { data, error } = await supabase.rpc('set_bank_payment_settings', { p: patch });
  if (error) throw rpcError(error, 'Could not save the settings.');
  return data as BankSettingsRow;
}

export async function fetchLinkableInvoices(minBalanceCents: number): Promise<LinkableInvoice[]> {
  const { data, error } = await supabase.rpc('list_linkable_invoices', { p_min_balance_cents: minBalanceCents });
  if (error) throw rpcError(error, 'Could not load invoices.');
  return (data ?? []) as LinkableInvoice[];
}

export async function linkAttemptToInvoice(attemptId: string, invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('bank_attempt_link_invoice', { p_attempt_id: attemptId, p_invoice_id: invoiceId });
  if (error) throw rpcError(error, 'Could not link the payment.');
}

export async function dismissAttempt(attemptId: string): Promise<void> {
  const { error } = await supabase.rpc('bank_attempt_dismiss', { p_attempt_id: attemptId });
  if (error) throw rpcError(error, 'Could not dismiss the payment.');
}

export async function refreshBankCapability(enable: boolean): Promise<BankSettingsRow['capability_status']> {
  const { data, error } = await supabase.functions.invoke('pay-by-bank-actions', { body: { action: enable ? 'enable_capability' : 'capability_status' } });
  if (error) throw new Error(await functionErrorMessage(error, 'Something went wrong. Please try again.'));
  return (data?.capability_status ?? 'unknown') as BankSettingsRow['capability_status'];
}

// ---------------------------------------------------------------- presentation helpers (pure, tested)

export const ATTEMPT_STATUS_META: Record<AttemptStatus, { label: string; tone: Tone }> = {
  verification_required: { label: 'Verify bank', tone: 'warning' },
  processing: { label: 'In transit', tone: 'accent' },
  succeeded: { label: 'Settled', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  returned: { label: 'Returned', tone: 'danger' },
  disputed: { label: 'Disputed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const ACCOUNTING_META: Record<AccountingStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Posting…', tone: 'neutral' },
  posted: { label: 'In ledger', tone: 'success' },
  unlinked: { label: 'Needs invoice', tone: 'warning' },
  reversed: { label: 'Reversed', tone: 'neutral' },
  failed: { label: 'Posting failed', tone: 'danger' },
  skipped: { label: 'Not applicable', tone: 'neutral' },
};

export type AttemptTab = 'all' | 'in_flight' | 'attention' | 'problems' | 'review';
export const ATTEMPT_TABS: { key: AttemptTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in_flight', label: 'In transit' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'problems', label: 'Failed & returned' },
  { key: 'review', label: 'Ledger review' },
];

export const needsLedgerReview = (a: Pick<AttemptRow, 'status' | 'accounting_status'>) =>
  (a.status === 'succeeded' && (a.accounting_status === 'unlinked' || a.accounting_status === 'failed')) ||
  ((a.status === 'returned' || a.status === 'disputed') && a.accounting_status === 'failed');

export function matchesAttemptTab(a: AttemptRow, tab: AttemptTab): boolean {
  switch (tab) {
    case 'in_flight': return a.status === 'processing' || a.status === 'verification_required';
    case 'attention': return a.status === 'verification_required' || a.status === 'failed' || a.status === 'returned' || a.status === 'disputed' || needsLedgerReview(a);
    case 'problems': return a.status === 'failed' || a.status === 'returned' || a.status === 'disputed';
    case 'review': return needsLedgerReview(a);
    default: return true;
  }
}

export const formatCents = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const RAIL_LABEL: Record<AttemptRow['rail'], string> = { ach_debit: 'ACH debit', instant_bank: 'Instant bank', rtp: 'RTP', fednow: 'FedNow' };

const FAILURE_COPY: Record<string, string> = {
  insufficient_funds: 'Insufficient funds',
  account_closed: 'Account closed',
  no_account: 'Account not found',
  invalid_account_number: 'Invalid account number',
  bank_account_restricted: 'Account restricted',
  debit_not_authorized: 'Debits not authorized',
};

/** One-line reason for a failed / returned payment (never shows raw provider text for known codes). */
export function describeProblem(a: Pick<AttemptRow, 'status' | 'failure_code' | 'failure_message' | 'return_code'>): string | null {
  if (a.status === 'failed') return (a.failure_code && FAILURE_COPY[a.failure_code]) || a.failure_message || 'The bank payment failed';
  if (a.status === 'returned' || a.status === 'disputed') {
    const r = a.return_code ? (FAILURE_COPY[a.return_code] ?? a.return_code.replace(/_/g, ' ')) : 'returned by the bank';
    return a.status === 'disputed' ? `Customer dispute: ${r}` : `Bank return: ${r}`;
  }
  return null;
}

/** "Expected Oct 30" / "Settled Oct 28" for the table. Dates are plain YYYY-MM-DD (no timezone shifting). */
export function describeSettlement(a: Pick<AttemptRow, 'status' | 'expected_settlement_date' | 'settled_at' | 'verification_method'>): string {
  const fmt = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (a.status === 'succeeded' && a.settled_at) return `Settled ${fmt(a.settled_at)}`;
  if (a.status === 'verification_required') return 'Waiting for the customer to verify the account';
  if (a.status === 'processing') return a.expected_settlement_date ? `Expected ${fmt(a.expected_settlement_date)}` : 'Expected in 1–4 business days';
  return '—';
}
