import { supabase } from '@/lib/supabase';
import type { WipCostEntry } from '@/lib/projectWip';

// WIP report data layer. Reads are scoped to the account owner
// (`user_id = ownerId`) on top of RLS, exactly like installProjectsApi.ts.

const PAGE = 1000;
const JOB_CHUNK = 100;

export interface WipSourceData {
  costEntries: WipCostEntry[];
  /** Approved expense allocations on the linked jobs, in cents. */
  expenseCents: number;
  /** false when the expense view is missing or unreadable (report shows a warning). */
  expensesAvailable: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Job-cost entries + approved expenses for the jobs linked to one project. */
export async function fetchWipSourceData(ownerId: string, jobIds: string[]): Promise<WipSourceData> {
  const ids = [...new Set(jobIds.filter(Boolean))];
  if (ids.length === 0) return { costEntries: [], expenseCents: 0, expensesAvailable: true };

  const costEntries: WipCostEntry[] = [];
  for (const part of chunk(ids, JOB_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('job_cost_entries')
        .select('job_id, category, total_cost_cents')
        .eq('user_id', ownerId)
        .in('job_id', part)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error('Could not load job costs.');
      const rows = (data ?? []) as WipCostEntry[];
      costEntries.push(...rows);
      if (rows.length < PAGE) break;
    }
  }

  // Approved expenses are optional: an older database may not have the view yet.
  let expenseCents = 0;
  let expensesAvailable = true;
  try {
    for (const part of chunk(ids, JOB_CHUNK)) {
      const { data, error } = await supabase.from('expense_job_costs').select('job_id, cost_cents').eq('user_id', ownerId).in('job_id', part);
      if (error) {
        expensesAvailable = false;
        break;
      }
      for (const row of (data ?? []) as { cost_cents: number | string | null }[]) {
        const n = Number(row.cost_cents);
        if (Number.isFinite(n)) expenseCents += Math.round(n);
      }
    }
  } catch {
    expensesAvailable = false;
  }
  if (!expensesAvailable) expenseCents = 0;

  return { costEntries, expenseCents, expensesAvailable };
}
