/**
 * Commercial pack — Supabase API + hooks.
 * Reads go through RLS (account-scoped, pack-gated, site-restricted); every write goes through a
 * SECURITY DEFINER RPC that re-checks entitlement, permission and tenancy. Verdict / clock math is
 * the pure code in src/lib/commercial/*.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { checkVisitCoverage, type CoverageContract, type CoveredAsset, type CoverageVerdict, type EntitlementState, type VisitKind } from '@/lib/commercial/coverage';
import type { TimerState } from '@/lib/commercial/slaClock';

export interface TimerRow {
  id: string;
  job_id: string;
  contract_id: string;
  site_id: string | null;
  started_at: string;
  state: TimerState;
  due_at: string | null;
  pct_elapsed: number | null;
  policy: { kind: 'response' | 'resolution'; priority: 'standard' | 'urgent' | 'emergency'; target_minutes: number } | null;
}
export interface ApprovalRow {
  id: string;
  work_order_id: string;
  amount_cents: number;
  required_steps: Array<'manager' | 'owner'>;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  work_order: { work_order_number: string | null; po_number: string | null; title: string; not_to_exceed_cents: number | null } | null;
}
export interface StatementRow {
  id: string;
  customer_id: string;
  period_start: string;
  period_end: string;
  total_cents: number;
  due_on: string;
  status: 'draft' | 'issued';
}
export interface PmDueRow {
  id: string;
  contract_id: string;
  name: string;
  site_id: string | null;
  equipment_id: string | null;
  next_due_date: string;
  days_until: number;
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function loadTimers(): Promise<TimerRow[]> {
  return check(
    await supabase
      .from('commercial_sla_timers')
      .select('id, job_id, contract_id, site_id, started_at, state, due_at, pct_elapsed, policy:commercial_sla_policies(kind, priority, target_minutes)')
      .is('stopped_at', null)
      .order('started_at', { ascending: false })
      .limit(500),
  ) as unknown as TimerRow[];
}

export async function timerAction(timerId: string, action: 'pause' | 'resume' | 'stop', reason?: string): Promise<void> {
  check(await supabase.rpc('commercial_timer_transition', { p_timer_id: timerId, p_action: action, p_reason: reason ?? null }));
}

export async function loadApprovals(): Promise<ApprovalRow[]> {
  return check(
    await supabase
      .from('commercial_approval_requests')
      .select('id, work_order_id, amount_cents, required_steps, status, created_at, work_order:work_orders(work_order_number, po_number, title, not_to_exceed_cents)')
      .order('created_at', { ascending: false })
      .limit(200),
  ) as unknown as ApprovalRow[];
}
export async function requestApproval(workOrderId: string, amountCents: number): Promise<string> {
  return check(await supabase.rpc('commercial_request_approval', { p_work_order_id: workOrderId, p_amount_cents: amountCents })) as string;
}
export async function decideApproval(requestId: string, decision: 'approve' | 'reject', comment?: string): Promise<string> {
  return check(await supabase.rpc('commercial_decide_approval', { p_request_id: requestId, p_decision: decision, p_comment: comment ?? null })) as string;
}

export async function loadStatements(): Promise<StatementRow[]> {
  return check(await supabase.from('commercial_statements').select('id, customer_id, period_start, period_end, total_cents, due_on, status').order('period_start', { ascending: false }).limit(200)) as StatementRow[];
}
export async function generateStatements(customerId: string, start: string, end: string) {
  return check(await supabase.rpc('commercial_generate_statements', { p_customer_id: customerId, p_period_start: start, p_period_end: end })) as { statements_created: number; invoices_attached: number; invoices_skipped: number };
}
export async function issueStatement(id: string): Promise<void> {
  check(await supabase.rpc('commercial_issue_statement', { p_statement_id: id }));
}

export async function loadPmDue(withinDays = 30): Promise<PmDueRow[]> {
  return check(await supabase.rpc('commercial_pm_due', { p_within_days: withinDays, p_limit: 200 })) as PmDueRow[];
}

/** "Is this visit covered?" — inputs from the database, verdict from the pure, tested function. */
export async function checkCoverage(contractId: string, q: { onDate: string; siteId?: string | null; equipmentId?: string | null; kind: VisitKind; quantity?: number }): Promise<CoverageVerdict> {
  const inputs = check(await supabase.rpc('commercial_coverage_inputs', { p_contract_id: contractId, p_on_date: q.onDate })) as {
    contract: CoverageContract;
    assets: CoveredAsset[];
    entitlements: EntitlementState[];
  };
  return checkVisitCoverage(inputs.contract, inputs.assets, inputs.entitlements, q);
}

export interface LoadState<T> { data: T | null; loading: boolean; error: string | null; reload: () => void }

/** Loads once, exposes loading / error / reload. Errors are shown by the caller (no raw DB text). */
export function useCommercialData<T>(loader: () => Promise<T>, deps: unknown[] = []): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableLoader = useCallback(loader, deps);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    stableLoader()
      .then((d) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'load_failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [stableLoader, tick]);
  return { data, loading, error, reload: () => setTick((n) => n + 1) };
}
