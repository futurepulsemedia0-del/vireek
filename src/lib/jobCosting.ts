import { formatCents } from './priceBook';

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

export { formatCents };

export function marginBadgeColor(marginPct: number | null): string {
  if (marginPct === null) return 'bg-bg-tertiary text-text-secondary';
  if (marginPct < 0) return 'bg-danger/10 text-danger';
  if (marginPct < 20) return 'bg-warning-500/10 text-warning-500';
  return 'bg-success-500/10 text-success-500';
}

export function formatMargin(marginPct: number | null): string {
  if (marginPct === null) return '—';
  return `${marginPct.toFixed(1)}%`;
}

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
