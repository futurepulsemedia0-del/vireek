import { supabase } from '@/lib/supabase';

/**
 * Accounting / General Ledger — dashboard client library.
 *
 * Thin wrapper over the tables/RPCs in
 * supabase/migrations/20261203000001_accounting_general_ledger.sql.
 * All writes go through SECURITY DEFINER RPCs (post_journal_entry and
 * the AR/AP helpers built on top of it) so every posted entry is
 * guaranteed to balance and closed periods can't be edited.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface ChartOfAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  normal_balance: 'debit' | 'credit';
  is_system: boolean;
  is_active: boolean;
}

export interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  memo: string | null;
  source_type: string;
  source_id: string | null;
  status: 'posted' | 'void';
  created_at: string;
}

export interface ArInvoice {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  job_id: string | null;
  status: 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void';
  issue_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
}

export interface ApBill {
  id: string;
  bill_number: string;
  vendor_id: string | null;
  purchase_order_id: string | null;
  status: 'draft' | 'approved' | 'partially_paid' | 'paid' | 'void';
  bill_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
}

export interface TrialBalanceRow {
  account_code: string;
  account_name: string;
  type: AccountType;
  debit_cents: number;
  credit_cents: number;
}

export interface ProfitAndLossRow {
  account_code: string;
  account_name: string;
  type: AccountType;
  amount_cents: number;
}

export interface BalanceSheetRow {
  account_code: string;
  account_name: string;
  type: AccountType;
  balance_cents: number;
}

export interface AgingRow {
  due_date: string;
  days_overdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
  balance_cents: number;
  invoice_id?: string;
  invoice_number?: string;
  customer_name?: string;
  bill_id?: string;
  bill_number?: string;
  vendor_name?: string;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '$0.00';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function ensureChartOfAccounts(): Promise<void> {
  const { error } = await supabase.rpc('ensure_default_chart_of_accounts');
  if (error) throw error;
}

export async function fetchChartOfAccounts(): Promise<ChartOfAccount[]> {
  const { data, error } = await supabase.from('chart_of_accounts').select('*').eq('is_active', true).order('code');
  if (error) throw error;
  return (data as ChartOfAccount[]) ?? [];
}

export async function fetchJournalEntries(limit = 50): Promise<JournalEntry[]> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .order('entry_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as JournalEntry[]) ?? [];
}

export async function fetchArInvoices(): Promise<ArInvoice[]> {
  const { data, error } = await supabase.from('ar_invoices').select('*').order('issue_date', { ascending: false });
  if (error) throw error;
  return (data as ArInvoice[]) ?? [];
}

export async function fetchApBills(): Promise<ApBill[]> {
  const { data, error } = await supabase.from('ap_bills').select('*').order('bill_date', { ascending: false });
  if (error) throw error;
  return (data as ApBill[]) ?? [];
}

export async function createArInvoice(params: {
  customerId: string | null;
  jobId: string | null;
  quoteId: string | null;
  dueDate: string;
  taxCents: number;
  lines: { description: string; amountCents: number; revenueAccountId?: string }[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_ar_invoice', {
    p_customer_id: params.customerId,
    p_job_id: params.jobId,
    p_quote_id: params.quoteId,
    p_due_date: params.dueDate,
    p_tax_cents: params.taxCents,
    p_lines: params.lines.map((l) => ({
      description: l.description,
      amount_cents: l.amountCents,
      revenue_account_id: l.revenueAccountId ?? null,
    })),
  });
  if (error) throw error;
  return data as string;
}

export async function recordArPayment(params: {
  invoiceId: string;
  amountCents: number;
  paymentMethod: string;
  depositAccountId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_ar_payment', {
    p_invoice_id: params.invoiceId,
    p_amount_cents: params.amountCents,
    p_payment_method: params.paymentMethod,
    p_deposit_account_id: params.depositAccountId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function createApBill(params: {
  vendorId: string | null;
  purchaseOrderId: string | null;
  dueDate: string;
  taxCents: number;
  lines: { description: string; amountCents: number; expenseAccountId?: string }[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_ap_bill', {
    p_vendor_id: params.vendorId,
    p_purchase_order_id: params.purchaseOrderId,
    p_due_date: params.dueDate,
    p_tax_cents: params.taxCents,
    p_lines: params.lines.map((l) => ({
      description: l.description,
      amount_cents: l.amountCents,
      expense_account_id: l.expenseAccountId ?? null,
    })),
  });
  if (error) throw error;
  return data as string;
}

export async function recordApBillPayment(params: {
  billId: string;
  amountCents: number;
  paymentMethod: string;
  sourceAccountId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_ap_bill_payment', {
    p_bill_id: params.billId,
    p_amount_cents: params.amountCents,
    p_payment_method: params.paymentMethod,
    p_source_account_id: params.sourceAccountId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchTrialBalance(asOf?: string): Promise<TrialBalanceRow[]> {
  const { data, error } = await supabase.rpc('get_trial_balance', { p_as_of: asOf ?? new Date().toISOString().slice(0, 10) });
  if (error) throw error;
  return (data as TrialBalanceRow[]) ?? [];
}

export async function fetchProfitAndLoss(start: string, end: string): Promise<ProfitAndLossRow[]> {
  const { data, error } = await supabase.rpc('get_profit_and_loss', { p_start: start, p_end: end });
  if (error) throw error;
  return (data as ProfitAndLossRow[]) ?? [];
}

export async function fetchBalanceSheet(asOf?: string): Promise<BalanceSheetRow[]> {
  const { data, error } = await supabase.rpc('get_balance_sheet', { p_as_of: asOf ?? new Date().toISOString().slice(0, 10) });
  if (error) throw error;
  return (data as BalanceSheetRow[]) ?? [];
}

export async function fetchArAging(): Promise<AgingRow[]> {
  const { data, error } = await supabase.rpc('get_ar_aging');
  if (error) throw error;
  return (data as AgingRow[]) ?? [];
}

export async function fetchApAging(): Promise<AgingRow[]> {
  const { data, error } = await supabase.rpc('get_ap_aging');
  if (error) throw error;
  return (data as AgingRow[]) ?? [];
}
