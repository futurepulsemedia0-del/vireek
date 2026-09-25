import { supabase } from '@/lib/supabase';
import type { FragilityReport, RawBusinessData, RawFixedExpense, RawJob, RawOutcome, RawPurchase } from '@/lib/fragilityScore';

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

export interface FragilitySettings {
  backupCapacityPct: number | null;
  manualWorkPct: number | null;
}

export async function fetchFragilitySettings(ownerId: string): Promise<FragilitySettings> {
  const { data, error } = await supabase
    .from('fragility_settings')
    .select('backup_capacity_pct, manual_work_pct')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { backup_capacity_pct: number | string | null; manual_work_pct: number | string | null } | null;
  return {
    backupCapacityPct: row?.backup_capacity_pct != null ? Number(row.backup_capacity_pct) : null,
    manualWorkPct: row?.manual_work_pct != null ? Number(row.manual_work_pct) : null,
  };
}

export async function saveFragilitySettings(ownerId: string, s: FragilitySettings): Promise<void> {
  const { error } = await supabase.from('fragility_settings').upsert(
    {
      user_id: ownerId,
      backup_capacity_pct: s.backupCapacityPct,
      manual_work_pct: s.manualWorkPct,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

/** Gathers the raw rows behind every measurable dimension. Read-only. */
export async function fetchRawBusinessData(ownerId: string, settings: FragilitySettings): Promise<RawBusinessData> {
  const [jobs, purchases, outcomes, integrations, cash, expenses] = await Promise.all([
    supabase
      .from('jobs')
      .select('assigned_technician_id, customer_id, invoice_amount')
      .eq('user_id', ownerId)
      .eq('job_status', 'completed')
      .gte('completed_at', daysAgo(90))
      .limit(5000),
    supabase
      .from('purchase_orders')
      .select('vendor_id, total_cents')
      .eq('user_id', ownerId)
      .neq('status', 'cancelled')
      .gte('created_at', daysAgo(180))
      .limit(5000),
    supabase
      .from('job_outcomes')
      .select('technician_id, caused_callback, is_rework')
      .eq('user_id', ownerId)
      .gte('recorded_at', daysAgo(180))
      .limit(5000),
    supabase.from('integrations').select('status').eq('user_id', ownerId),
    supabase.from('cash_flow_settings').select('starting_cash_balance').eq('user_id', ownerId).maybeSingle(),
    supabase
      .from('cash_flow_fixed_expenses')
      .select('amount, frequency, active')
      .eq('user_id', ownerId)
      .eq('active', true),
  ]);

  for (const result of [jobs, purchases, outcomes, integrations, cash, expenses]) {
    if (result.error) throw result.error;
  }

  const jobRows = (jobs.data ?? []) as {
    assigned_technician_id: string | null;
    customer_id: string | null;
    invoice_amount: number | string | null;
  }[];
  const purchaseRows = (purchases.data ?? []) as { vendor_id: string; total_cents: number | string }[];
  const cashRow = cash.data as { starting_cash_balance: number | string } | null;
  const expenseRows = (expenses.data ?? []) as {
    amount: number | string;
    frequency: RawFixedExpense['frequency'];
    active: boolean;
  }[];

  return {
    completedJobs: jobRows.map((j): RawJob => ({
      technician_id: j.assigned_technician_id,
      customer_id: j.customer_id,
      revenue: Number(j.invoice_amount ?? 0),
    })),
    purchases: purchaseRows.map((p): RawPurchase => ({ vendor_id: p.vendor_id, total_cents: Number(p.total_cents) })),
    outcomes: (outcomes.data ?? []) as RawOutcome[],
    integrationStatuses: ((integrations.data ?? []) as { status: string }[]).map((r) => r.status),
    cashBalance: cashRow ? Number(cashRow.starting_cash_balance) : null,
    fixedExpenses: expenseRows.map((e): RawFixedExpense => ({
      amount: Number(e.amount),
      frequency: e.frequency,
      active: e.active,
    })),
    backupCapacityPct: settings.backupCapacityPct,
    manualWorkPct: settings.manualWorkPct,
  };
}

/** Append-only history so the owner can see whether fragility is rising or falling. */
export async function saveFragilitySnapshot(ownerId: string, report: FragilityReport): Promise<void> {
  if (report.score === null || report.band === null) return;
  const { error } = await supabase.from('fragility_snapshots').insert({
    user_id: ownerId,
    score: report.score,
    band: report.band,
    scalability: report.scalability,
    coverage: report.coverage,
    components: report.components,
  });
  if (error) throw error;
}

export async function fetchLatestFragilityScore(ownerId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('fragility_snapshots')
    .select('score')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as { score: number | string } | null;
  return row ? Number(row.score) : null;
}
