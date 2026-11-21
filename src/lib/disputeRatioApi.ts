/**
 * Dispute-ratio monitoring — API layer. Tenant reads go through dispute_ratio_monthly_v (RLS applies);
 * platform reads/writes go through staff-checked RPCs.
 */
import { supabase } from '@/lib/supabase';
import type { PlatformMonthRow, TenantMonthRow } from '@/lib/disputeRatio';

const TENANT_COLS = 'user_id, month, disputes_count, txn_count, ratio_pct, level, warning_pct, critical_pct, min_transactions';

/** Last `months` months for one tenant (defence-in-depth `.eq('user_id', ownerId)` on top of RLS). */
export async function fetchTenantDisputeRatio(ownerId: string, months = 6): Promise<TenantMonthRow[]> {
  const { data, error } = await supabase
    .from('dispute_ratio_monthly_v')
    .select(TENANT_COLS)
    .eq('user_id', ownerId)
    .order('month', { ascending: false })
    .limit(Math.min(Math.max(months, 1), 24));
  if (error) throw error;
  return (data ?? []) as TenantMonthRow[];
}

export async function fetchPlatformDisputeRatio(months = 12): Promise<PlatformMonthRow[]> {
  const { data, error } = await supabase.rpc('dispute_ratio_platform_monthly', { p_months: months });
  if (error) throw error;
  return (data ?? []) as PlatformMonthRow[];
}

export async function saveThresholds(input: {
  scope: 'tenant_default' | 'platform';
  warning: number;
  critical: number;
  minTransactions: number;
  verified: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('set_dispute_ratio_thresholds', {
    p_scope: input.scope,
    p_warning_pct: input.warning,
    p_critical_pct: input.critical,
    p_min_transactions: input.minTransactions,
    p_verified: input.verified,
  });
  if (error) throw error;
}
