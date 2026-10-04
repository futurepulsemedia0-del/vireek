import { supabase } from '@/lib/supabase';

export type BankMatchType = 'ar_invoice' | 'ar_payment' | 'ap_bill' | 'ap_bill_payment' | 'expense' | 'income' | 'transfer';
export type BankMatchStatus = 'unmatched' | 'suggested' | 'reconciled' | 'ignored';

export interface BankConnection {
  id: string;
  institution_name: string;
  status: 'active' | 'login_required' | 'error' | 'disconnected';
  last_synced_at: string | null;
  last_error: string | null;
}
export interface BankAccount {
  id: string;
  connection_id: string;
  name: string;
  mask: string | null;
  account_type: string;
  subtype: string | null;
  current_balance_cents: number | null;
  available_balance_cents: number | null;
  is_active: boolean;
}
export interface BankMatchRef { id: string; amount_cents: number; label: string }
export interface BankTxn {
  id: string;
  account_id: string;
  posted_date: string;
  amount_cents: number;
  description: string;
  merchant_name: string | null;
  category_code: string | null;
  category_label: string | null;
  category_source: 'rule' | 'ai' | 'user' | null;
  match_status: BankMatchStatus;
  match_type: BankMatchType | null;
  match_refs: BankMatchRef[];
  match_confidence: number | null;
  match_reason: string | null;
  needs_review: boolean;
}

export const HIGH_CONFIDENCE = 0.9;

export const EXPENSE_CATEGORIES = [
  { code: '5000', name: 'Cost of Goods Sold - Parts' },
  { code: '5100', name: 'Subcontractor Cost' },
  { code: '6000', name: 'Payroll Expense' },
  { code: '6100', name: 'Vehicle and Fuel Expense' },
  { code: '6200', name: 'Marketing and Advertising' },
  { code: '6300', name: 'Software and Subscriptions' },
  { code: '6400', name: 'Rent and Utilities' },
  { code: '6500', name: 'Insurance' },
  { code: '6900', name: 'General and Administrative' },
];
export const INCOME_CATEGORIES = [
  { code: '4000', name: 'Service Revenue' },
  { code: '4100', name: 'Parts and Materials Revenue' },
  { code: '4900', name: 'Other Income' },
];

export const MATCH_LABEL: Record<BankMatchType, string> = {
  ar_invoice: 'Invoice payment',
  ar_payment: 'Already-booked payment',
  ap_bill: 'Bill payment',
  ap_bill_payment: 'Already-booked bill payment',
  expense: 'Expense',
  income: 'Other income',
  transfer: 'Transfer',
};

export function money(cents: number, digits = 0): string {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Calls the bank-intelligence edge function and surfaces the server's own error message. */
export async function bankApi<T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('bank-intelligence', {
    body: { action, ...payload },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) {
    let message = 'Something went wrong. Please try again.';
    try {
      const ctx = (error as { context?: Response }).context;
      const body = ctx ? await ctx.json() : null;
      if (body?.error) message = String(body.error);
    } catch { /* keep default */ }
    throw new Error(message);
  }
  return data as T;
}

export async function applyReconciliation(txnId: string, categoryCode?: string): Promise<void> {
  const { error } = await supabase.rpc('bank_apply_reconciliation', { p_txn_id: txnId, p_category_code: categoryCode ?? null });
  if (error) throw new Error(error.message);
}
export async function setIgnored(txnId: string, ignore: boolean): Promise<void> {
  const { error } = await supabase.rpc('bank_ignore_transaction', { p_txn_id: txnId, p_ignore: ignore });
  if (error) throw new Error(error.message);
}

export interface BankSummary {
  inflow: number;
  matchedInflow: number;
  matchedDocs: number;
  unmatchedInflow: number;
  unmatchedCount: number;
  operatingOut: number;
  total: number;
  reconciled: number;
  suggested: number;
  highConfidence: number;
}

/** Last-N-days picture of money in/out. Transfers and ignored lines are excluded. */
export function summarizeBank(rows: BankTxn[], days = 30): BankSummary {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const s: BankSummary = { inflow: 0, matchedInflow: 0, matchedDocs: 0, unmatchedInflow: 0, unmatchedCount: 0, operatingOut: 0, total: 0, reconciled: 0, suggested: 0, highConfidence: 0 };
  for (const t of rows) {
    if (t.posted_date < cutoff || t.match_status === 'ignored' || t.match_type === 'transfer') continue;
    s.total++;
    if (t.match_status === 'reconciled') s.reconciled++;
    if (t.match_status === 'suggested') {
      s.suggested++;
      if ((t.match_confidence ?? 0) >= HIGH_CONFIDENCE) s.highConfidence++;
    }
    if (t.amount_cents > 0) {
      s.inflow += t.amount_cents;
      if (t.match_type === 'ar_invoice' || t.match_type === 'ar_payment') { s.matchedInflow += t.amount_cents; s.matchedDocs += t.match_refs.length; }
      else if (t.match_status !== 'reconciled' || !t.match_type) { s.unmatchedInflow += t.amount_cents; s.unmatchedCount++; }
    } else if (t.match_type === 'expense' || t.match_type === 'ap_bill' || t.match_type === 'ap_bill_payment') {
      s.operatingOut += -t.amount_cents;
    }
  }
  return s;
}

export function headline(s: BankSummary): string {
  if (!s.total) return 'No bank activity in the last 30 days yet.';
  const parts = [`${money(s.inflow)} came in.`];
  if (s.matchedInflow) parts.push(`${money(s.matchedInflow)} matches ${s.matchedDocs} invoice${s.matchedDocs === 1 ? '' : 's'}.`);
  if (s.unmatchedInflow) parts.push(`${money(s.unmatchedInflow)} is unmatched.`);
  if (s.operatingOut) parts.push(`${money(s.operatingOut)} went to operating costs.`);
  return parts.join(' ');
}

// ---------- Plaid Link (loaded on demand so the CSP only needs cdn.plaid.com) ----------
interface PlaidHandler { open(): void; destroy(): void }
interface PlaidMetadata { institution?: { name?: string; institution_id?: string } | null }
interface PlaidConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: PlaidMetadata) => void;
  onExit: (err: { display_message?: string; error_message?: string } | null) => void;
}
declare global {
  interface Window { Plaid?: { create(config: PlaidConfig): PlaidHandler } }
}

let plaidScript: Promise<NonNullable<Window['Plaid']>> | null = null;
export function loadPlaidLink(): Promise<NonNullable<Window['Plaid']>> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  plaidScript ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    el.async = true;
    el.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Bank connection widget failed to load.')));
    el.onerror = () => { plaidScript = null; reject(new Error('Could not load the bank connection widget.')); };
    document.head.appendChild(el);
  });
  return plaidScript;
}

export async function openPlaidLink(opts: {
  linkToken: string;
  onSuccess: (publicToken: string, institution: { name: string; id: string | null }) => void | Promise<void>;
  onExit?: (message: string | null) => void;
}): Promise<void> {
  const Plaid = await loadPlaidLink();
  const handler = Plaid.create({
    token: opts.linkToken,
    onSuccess: (publicToken, meta) => { handler.destroy(); void opts.onSuccess(publicToken, { name: meta.institution?.name ?? 'Bank', id: meta.institution?.institution_id ?? null }); },
    onExit: (err) => { opts.onExit?.(err ? err.display_message || err.error_message || 'Connection was interrupted.' : null); handler.destroy(); },
  });
  handler.open();
}
