import { supabase } from './supabase';
import { formatCents } from './priceBook';

// ============================================================
// TYPES — mirror the real DB schema (job_cost_entries table +
// job_profitability SQL view). Money stays in integer cents to
// match the database; formatCents() is how it's shown as dollars.
// ============================================================

export type CostCategory = 'labor' | 'material' | 'equipment' | 'subcontractor' | 'permit' | 'other';

export interface JobCostEntry {
  id: string;
  user_id: string;
  job_id: string;
  category: CostCategory;
  description: string;
  quantity: number;
  unit_cost_cents: number;
  total_cost_cents: number;
  team_member_id: string | null;
  price_book_item_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirrors the `job_profitability` SQL view — one row per job. */
export interface JobProfitability {
  job_id: string;
  user_id: string;
  customer_name: string;
  service_type: string | null;
  job_status: 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  revenue_cents: number;
  labor_cost_cents: number;
  material_cost_cents: number;
  equipment_cost_cents: number;
  subcontractor_cost_cents: number;
  permit_cost_cents: number;
  other_cost_cents: number;
  total_cost_cents: number;
  gross_profit_cents: number;
  margin_pct: number | null;
  cost_entry_count: number;
}

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  labor: 'Labor',
  material: 'Material',
  equipment: 'Equipment',
  subcontractor: 'Subcontractor',
  permit: 'Permit',
  other: 'Other',
};

/** Used for the category dot in cost-entry rows and the breakdown chart bars. */
export const COST_CATEGORY_COLORS: Record<CostCategory, string> = {
  labor: '#6366f1',
  material: '#22c55e',
  equipment: '#f59e0b',
  subcontractor: '#ec4899',
  permit: '#06b6d4',
  other: '#94a3b8',
};

export { formatCents };

// ============================================================
// MARGIN HELPERS
// ============================================================

export type MarginTier = 'unknown' | 'loss' | 'thin' | 'healthy';

export function marginTier(marginPct: number | null): MarginTier {
  if (marginPct === null) return 'unknown';
  if (marginPct < 0) return 'loss';
  if (marginPct < 20) return 'thin';
  return 'healthy';
}

const MARGIN_TIER_CLASS: Record<MarginTier, string> = {
  unknown: 'bg-bg-tertiary text-text-secondary',
  loss: 'bg-danger/10 text-danger',
  thin: 'bg-warning-500/10 text-warning-500',
  healthy: 'bg-success-500/10 text-success-500',
};

export function marginBadgeColor(marginPct: number | null): string {
  return MARGIN_TIER_CLASS[marginTier(marginPct)];
}

export function formatMargin(marginPct: number | null): string {
  if (marginPct === null) return '—';
  return `${marginPct.toFixed(1)}%`;
}

// ============================================================
// COST ENTRY FORM STATE
// ============================================================

export interface JobCostFormState {
  category: CostCategory;
  description: string;
  quantity: string;
  unit_cost: string;
  team_member_id: string;
  price_book_item_id: string;
}

export const EMPTY_JOB_COST_FORM: JobCostFormState = {
  category: 'labor',
  description: '',
  quantity: '1',
  unit_cost: '',
  team_member_id: '',
  price_book_item_id: '',
};

export function entryToForm(entry: JobCostEntry): JobCostFormState {
  return {
    category: entry.category,
    description: entry.description,
    quantity: String(entry.quantity),
    unit_cost: String(entry.unit_cost_cents / 100),
    team_member_id: entry.team_member_id ?? '',
    price_book_item_id: entry.price_book_item_id ?? '',
  };
}

export function jobCostFormToPayload(form: JobCostFormState, jobId: string, userId: string) {
  const quantity = Number(form.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Enter a valid quantity.');
  }
  const unitCostCents = Math.round(Number(form.unit_cost) * 100);
  if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
    throw new Error('Enter a valid unit cost.');
  }
  if (!form.description.trim()) {
    throw new Error('Enter a description for this cost.');
  }
  return {
    user_id: userId,
    job_id: jobId,
    category: form.category,
    description: form.description.trim(),
    quantity,
    unit_cost_cents: unitCostCents,
    team_member_id: form.team_member_id || null,
    price_book_item_id: form.price_book_item_id || null,
  };
}

// ============================================================
// SUMMARY / BREAKDOWN
// ============================================================

export interface ProfitabilitySummary {
  jobCount: number;
  totalRevenueCents: number;
  totalCostCents: number;
  totalProfitCents: number;
  avgMarginPct: number | null;
}

export function summarize(rows: JobProfitability[]): ProfitabilitySummary {
  const jobCount = rows.length;
  const totalRevenueCents = rows.reduce((sum, r) => sum + r.revenue_cents, 0);
  const totalCostCents = rows.reduce((sum, r) => sum + r.total_cost_cents, 0);
  const totalProfitCents = totalRevenueCents - totalCostCents;
  const avgMarginPct =
    totalRevenueCents > 0 ? Math.round((totalProfitCents / totalRevenueCents) * 1000) / 10 : null;
  return { jobCount, totalRevenueCents, totalCostCents, totalProfitCents, avgMarginPct };
}

export interface CategoryBreakdownItem {
  category: CostCategory;
  totalCents: number;
}

/**
 * Built straight from the view's per-category columns — no extra
 * fetch needed, and it naturally follows whatever rows are passed
 * in (e.g. the currently filtered job list).
 */
export function buildCategoryBreakdown(rows: JobProfitability[]): CategoryBreakdownItem[] {
  const totals: Record<CostCategory, number> = {
    labor: 0,
    material: 0,
    equipment: 0,
    subcontractor: 0,
    permit: 0,
    other: 0,
  };
  rows.forEach((r) => {
    totals.labor += r.labor_cost_cents;
    totals.material += r.material_cost_cents;
    totals.equipment += r.equipment_cost_cents;
    totals.subcontractor += r.subcontractor_cost_cents;
    totals.permit += r.permit_cost_cents;
    totals.other += r.other_cost_cents;
  });
  return (Object.keys(totals) as CostCategory[])
    .map((category) => ({ category, totalCents: totals[category] }))
    .filter((b) => b.totalCents > 0)
    .sort((a, b) => b.totalCents - a.totalCents);
}

// ============================================================
// DATA ACCESS — centralized here instead of scattered supabase
// calls in the page component.
// ============================================================

export async function fetchProfitabilityRows(): Promise<JobProfitability[]> {
  const { data, error } = await supabase
    .from('job_profitability')
    .select('*')
    .order('scheduled_datetime', { ascending: false });
  if (error) throw error;
  return (data as JobProfitability[]) || [];
}

export async function fetchCostEntries(jobId: string): Promise<JobCostEntry[]> {
  const { data, error } = await supabase
    .from('job_cost_entries')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as JobCostEntry[]) || [];
}

export async function saveCostEntry(
  form: JobCostFormState,
  jobId: string,
  userId: string,
  existingId?: string,
): Promise<void> {
  const payload = jobCostFormToPayload(form, jobId, userId);
  const query = existingId
    ? supabase.from('job_cost_entries').update(payload).eq('id', existingId)
    : supabase.from('job_cost_entries').insert(payload);
  const { error } = await query;
  if (error) throw error;
}

export async function deleteCostEntry(id: string): Promise<void> {
  const { error } = await supabase.from('job_cost_entries').delete().eq('id', id);
  if (error) throw error;
}
// ============================================================
// VENDOR BILLS (Accounts Payable) — linked to job_cost_entries so
// every bill automatically counts toward the job's real profit.
// ============================================================

export type VendorBillStatus = 'unpaid' | 'paid' | 'overdue';

export interface VendorBill {
  id: string;
  user_id: string;
  job_id: string;
  cost_entry_id: string | null;
  vendor_name: string;
  bill_number: string | null;
  category: CostCategory;
  amount_cents: number;
  bill_date: string;
  due_date: string | null;
  status: VendorBillStatus;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorBillFormState {
  vendor_name: string;
  bill_number: string;
  category: CostCategory;
  amount: string;
  bill_date: string;
  due_date: string;
  notes: string;
}

export const EMPTY_VENDOR_BILL_FORM: VendorBillFormState = {
  vendor_name: '',
  bill_number: '',
  category: 'material',
  amount: '',
  bill_date: new Date().toISOString().slice(0, 10),
  due_date: '',
  notes: '',
};

export function vendorBillToForm(bill: VendorBill): VendorBillFormState {
  return {
    vendor_name: bill.vendor_name,
    bill_number: bill.bill_number ?? '',
    category: bill.category,
    amount: String(bill.amount_cents / 100),
    bill_date: bill.bill_date,
    due_date: bill.due_date ?? '',
    notes: bill.notes ?? '',
  };
}

function vendorBillFormToPayload(form: VendorBillFormState, jobId: string, userId: string) {
  const amountCents = Math.round(Number(form.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('Enter a valid bill amount.');
  }
  if (!form.vendor_name.trim()) {
    throw new Error('Enter the vendor name.');
  }
  return {
    user_id: userId,
    job_id: jobId,
    vendor_name: form.vendor_name.trim(),
    bill_number: form.bill_number.trim() || null,
    category: form.category,
    amount_cents: amountCents,
    bill_date: form.bill_date || new Date().toISOString().slice(0, 10),
    due_date: form.due_date || null,
    notes: form.notes.trim() || null,
  };
}

export const VENDOR_BILL_STATUS_LABELS: Record<VendorBillStatus, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  overdue: 'Overdue',
};

export const VENDOR_BILL_STATUS_CLASS: Record<VendorBillStatus, string> = {
  unpaid: 'bg-warning-500/10 text-warning-500',
  paid: 'bg-success-500/10 text-success-500',
  overdue: 'bg-danger/10 text-danger',
};

export function unpaidVendorBillsTotalCents(bills: VendorBill[]): number {
  return bills.filter((b) => b.status !== 'paid').reduce((sum, b) => sum + b.amount_cents, 0);
}

export async function fetchVendorBills(jobId: string): Promise<VendorBill[]> {
  const { data, error } = await supabase
    .from('vendor_bills')
    .select('*')
    .eq('job_id', jobId)
    .order('bill_date', { ascending: false });
  if (error) throw error;
  return (data as VendorBill[]) || [];
}

/**
 * Saves the vendor bill AND keeps a linked job_cost_entries row in
 * sync — this is what makes the bill actually count toward the
 * job's total cost / margin in the profitability view above.
 */
export async function saveVendorBill(
  form: VendorBillFormState,
  jobId: string,
  userId: string,
  existingId?: string,
  existingCostEntryId?: string | null,
): Promise<void> {
  const payload = vendorBillFormToPayload(form, jobId, userId);
  const costEntryPayload = {
    user_id: userId,
    job_id: jobId,
    category: form.category,
    description: `Vendor bill — ${form.vendor_name.trim()}${form.bill_number.trim() ? ` (#${form.bill_number.trim()})` : ''}`,
    quantity: 1,
    unit_cost_cents: payload.amount_cents,
    team_member_id: null,
    price_book_item_id: null,
  };

  let costEntryId = existingCostEntryId ?? null;

  if (costEntryId) {
    const { error: costErr } = await supabase.from('job_cost_entries').update(costEntryPayload).eq('id', costEntryId);
    if (costErr) throw costErr;
  } else {
    const { data: costEntry, error: costErr } = await supabase
      .from('job_cost_entries')
      .insert(costEntryPayload)
      .select('id')
      .single();
    if (costErr) throw costErr;
    costEntryId = costEntry.id as string;
  }

  const finalPayload = { ...payload, cost_entry_id: costEntryId };
  const query = existingId
    ? supabase.from('vendor_bills').update(finalPayload).eq('id', existingId)
    : supabase.from('vendor_bills').insert(finalPayload);
  const { error } = await query;
  if (error) throw error;
}

export async function markVendorBillPaid(id: string): Promise<void> {
  const { error } = await supabase
    .from('vendor_bills')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Deletes the bill and its linked job_cost_entries row together. */
export async function deleteVendorBill(id: string, costEntryId?: string | null): Promise<void> {
  const { error } = await supabase.from('vendor_bills').delete().eq('id', id);
  if (error) throw error;
  if (costEntryId) {
    await supabase.from('job_cost_entries').delete().eq('id', costEntryId);
  }
}
