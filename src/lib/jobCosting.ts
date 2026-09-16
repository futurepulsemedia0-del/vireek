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
