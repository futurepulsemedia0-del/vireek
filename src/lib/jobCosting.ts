import { supabase, Job } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type CostCategory = 'labor' | 'materials' | 'subcontractor' | 'permits' | 'equipment' | 'other';

export const CATEGORY_LABELS: Record<CostCategory, string> = {
  labor: 'Labor',
  materials: 'Materials',
  subcontractor: 'Subcontractor',
  permits: 'Permits & Fees',
  equipment: 'Equipment',
  other: 'Other',
};

export const CATEGORY_COLORS: Record<CostCategory, string> = {
  labor: 'rgb(37 99 235)',
  materials: 'rgb(245 158 11)',
  subcontractor: 'rgb(168 85 247)',
  permits: 'rgb(20 184 166)',
  equipment: 'rgb(236 72 153)',
  other: 'rgb(148 163 184)',
};

export interface JobCostEntry {
  id: string;
  job_id: string;
  category: CostCategory;
  description: string;
  amount: number; // dollars — matches the convention of job.invoice_amount
  created_at: string;
}

export interface JobCostEntryInput {
  category: CostCategory;
  description: string;
  amount: number;
}

export interface JobProfitability {
  job: Job;
  costEntries: JobCostEntry[];
  revenue: number;
  totalCost: number;
  profit: number;
  marginPct: number | null; // null when there's no invoiced revenue yet
}

export interface CategoryBreakdown {
  category: CostCategory;
  total: number;
}

export type MarginTier = 'healthy' | 'thin' | 'loss' | 'unknown';

// ============================================================
// FORMATTERS & CALCULATIONS
// ============================================================

export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function computeProfitability(job: Job, costEntries: JobCostEntry[]): JobProfitability {
  const revenue = job.invoice_amount ?? 0;
  const totalCost = costEntries.reduce((sum, c) => sum + c.amount, 0);
  const profit = revenue - totalCost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : null;
  return { job, costEntries, revenue, totalCost, profit, marginPct };
}

export function marginTier(marginPct: number | null): MarginTier {
  if (marginPct === null) return 'unknown';
  if (marginPct >= 30) return 'healthy';
  if (marginPct >= 10) return 'thin';
  return 'loss';
}

export function buildCategoryBreakdown(entries: JobCostEntry[]): CategoryBreakdown[] {
  const totals = new Map<CostCategory, number>();
  entries.forEach((e) => totals.set(e.category, (totals.get(e.category) ?? 0) + e.amount));
  return (Object.keys(CATEGORY_LABELS) as CostCategory[])
    .map((category) => ({ category, total: totals.get(category) ?? 0 }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
}

// ============================================================
// DATA ACCESS
// Reads from the existing `jobs` table and a new `job_cost_entries`
// table — see the accompanying SQL migration.
// ============================================================

export async function fetchJobsForCosting(): Promise<Job[]> {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Job[]) ?? [];
}

export async function fetchCostEntries(): Promise<JobCostEntry[]> {
  const { data, error } = await supabase.from('job_cost_entries').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as JobCostEntry[]) ?? [];
}

export async function addCostEntry(jobId: string, input: JobCostEntryInput): Promise<JobCostEntry> {
  const { data, error } = await supabase
    .from('job_cost_entries')
    .insert({ job_id: jobId, category: input.category, description: input.description, amount: input.amount })
    .select()
    .single();
  if (error) throw error;
  return data as JobCostEntry;
}

export async function updateCostEntry(id: string, input: JobCostEntryInput): Promise<JobCostEntry> {
  const { data, error } = await supabase
    .from('job_cost_entries')
    .update({ category: input.category, description: input.description, amount: input.amount })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as JobCostEntry;
}

export async function deleteCostEntry(id: string): Promise<void> {
  const { error } = await supabase.from('job_cost_entries').delete().eq('id', id);
  if (error) throw error;
}
