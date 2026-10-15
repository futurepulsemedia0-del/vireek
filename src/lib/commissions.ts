import { supabase } from '@/lib/supabase';
import { fetchEmployees, type Employee } from '@/lib/payroll';
import type {
  CommissionTier,
  GenerationCounts,
  OverrideType,
  StatementAction,
  StatementStatus,
  TierMode,
  TierPeriod,
} from '@/lib/commissionEngine';

/**
 * Commissions — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20270402000000_commissions.sql.
 * Reads are explicitly scoped to the account owner (defence in depth on top
 * of RLS); every write goes through a SECURITY DEFINER RPC that re-checks
 * access, so the UI permission gate is a convenience, not the security
 * boundary.
 */

export interface CommissionPlan {
  id: string;
  name: string;
  description: string | null;
  tier_mode: TierMode;
  tier_period: TierPeriod;
  is_default: boolean;
  active: boolean;
  tiers: CommissionTier[];
}

export type CommissionEmployee = Employee & { commission_plan_id: string | null };

export type RecordKind = 'earned' | 'adjustment' | 'clawback';
export type RecordStatus = 'pending' | 'approved' | 'paid';
export type CalcSource = 'manual' | 'plan' | 'override_rate' | 'override_flat' | 'employee_rate';

export interface CommissionRecordRow {
  id: string;
  employee_id: string;
  job_id: string | null;
  basis_amount_cents: number;
  commission_rate_percent: number;
  commission_cents: number;
  status: RecordStatus;
  kind: RecordKind;
  calc_source: CalcSource;
  statement_id: string | null;
  earned_date: string;
  memo: string | null;
  calc_detail: { segments?: { min_cents: number; rate_percent: number; amount_cents: number; commission_cents: number }[]; reason?: string } | null;
}

export interface JobOverride {
  id: string;
  job_id: string;
  employee_id: string | null;
  override_type: OverrideType;
  rate_percent: number | null;
  flat_cents: number | null;
  reason: string;
  created_at: string;
}

export interface JobSummary {
  id: string;
  customer_name: string;
  service_type: string | null;
  completed_at: string | null;
  invoice_amount: number | null;
  assigned_technician_id: string | null;
}

export interface CommissionStatement {
  id: string;
  employee_id: string;
  period_start: string;
  period_end: string;
  status: StatementStatus;
  record_count: number;
  earned_cents: number;
  adjustment_cents: number;
  net_cents: number;
  submitted_by: string | null;
  review_note: string | null;
  void_reason: string | null;
  exported_at: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  created_at: string;
}

export interface CommissionOverviewRow {
  employee_id: string;
  full_name: string;
  jobs_count: number;
  earned_cents: number;
  adjustment_cents: number;
  pending_cents: number;
  approved_cents: number;
  paid_cents: number;
}

export const RECORDS_PAGE_LIMIT = 1000;

/** Supabase errors are plain objects, not Error instances. */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || fallback;
  }
  return fallback;
}

function fail(error: { message: string } | null): void {
  if (error) throw error;
}

// ---------- reads ----------

export async function fetchCommissionEmployees(): Promise<CommissionEmployee[]> {
  return (await fetchEmployees()) as CommissionEmployee[];
}

export async function fetchCommissionPlans(ownerId: string): Promise<CommissionPlan[]> {
  const [plansRes, tiersRes] = await Promise.all([
    supabase.from('commission_plans').select('id,name,description,tier_mode,tier_period,is_default,active').eq('user_id', ownerId).order('created_at'),
    supabase.from('commission_plan_tiers').select('plan_id,min_cents,rate_percent').eq('user_id', ownerId).order('min_cents'),
  ]);
  fail(plansRes.error);
  fail(tiersRes.error);
  const byPlan = new Map<string, CommissionTier[]>();
  for (const t of (tiersRes.data ?? []) as { plan_id: string; min_cents: number; rate_percent: number }[]) {
    const list = byPlan.get(t.plan_id) ?? [];
    list.push({ min_cents: Number(t.min_cents), rate_percent: Number(t.rate_percent) });
    byPlan.set(t.plan_id, list);
  }
  return ((plansRes.data ?? []) as Omit<CommissionPlan, 'tiers'>[]).map((p) => ({ ...p, tiers: byPlan.get(p.id) ?? [] }));
}

export async function fetchCommissionRecords(ownerId: string, start: string, end: string): Promise<CommissionRecordRow[]> {
  const { data, error } = await supabase
    .from('commission_records')
    .select('id,employee_id,job_id,basis_amount_cents,commission_rate_percent,commission_cents,status,kind,calc_source,statement_id,earned_date,memo,calc_detail')
    .eq('user_id', ownerId)
    .gte('earned_date', start)
    .lte('earned_date', end)
    .order('earned_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(RECORDS_PAGE_LIMIT);
  fail(error);
  return ((data ?? []) as CommissionRecordRow[]).map((r) => ({
    ...r,
    commission_rate_percent: Number(r.commission_rate_percent),
  }));
}

export async function fetchJobOverrides(ownerId: string): Promise<JobOverride[]> {
  const { data, error } = await supabase
    .from('commission_job_overrides')
    .select('id,job_id,employee_id,override_type,rate_percent,flat_cents,reason,created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  fail(error);
  return (data ?? []) as JobOverride[];
}

export async function fetchJobsByIds(ownerId: string, ids: string[]): Promise<JobSummary[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  // Chunked: a single .in() with hundreds of uuids would exceed URL limits.
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));
  const results = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from('jobs')
        .select('id,customer_name,service_type,completed_at,invoice_amount,assigned_technician_id')
        .eq('user_id', ownerId)
        .in('id', chunk),
    ),
  );
  const out: JobSummary[] = [];
  for (const r of results) {
    fail(r.error);
    out.push(...((r.data ?? []) as JobSummary[]));
  }
  return out;
}

export async function fetchCompletedJobs(ownerId: string): Promise<JobSummary[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id,customer_name,service_type,completed_at,invoice_amount,assigned_technician_id')
    .eq('user_id', ownerId)
    .eq('job_status', 'completed')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(150);
  fail(error);
  return (data ?? []) as JobSummary[];
}

export async function fetchCommissionStatements(ownerId: string): Promise<CommissionStatement[]> {
  const { data, error } = await supabase
    .from('commission_statements')
    .select('id,employee_id,period_start,period_end,status,record_count,earned_cents,adjustment_cents,net_cents,submitted_by,review_note,void_reason,exported_at,paid_at,payment_reference,created_at')
    .eq('user_id', ownerId)
    .order('period_end', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);
  fail(error);
  return ((data ?? []) as CommissionStatement[]).map((s) => ({
    ...s,
    earned_cents: Number(s.earned_cents),
    adjustment_cents: Number(s.adjustment_cents),
    net_cents: Number(s.net_cents),
  }));
}

export async function fetchStatementRecords(ownerId: string, statementId: string): Promise<CommissionRecordRow[]> {
  const { data, error } = await supabase
    .from('commission_records')
    .select('id,employee_id,job_id,basis_amount_cents,commission_rate_percent,commission_cents,status,kind,calc_source,statement_id,earned_date,memo,calc_detail')
    .eq('user_id', ownerId)
    .eq('statement_id', statementId)
    .order('earned_date');
  fail(error);
  return ((data ?? []) as CommissionRecordRow[]).map((r) => ({ ...r, commission_rate_percent: Number(r.commission_rate_percent) }));
}

export async function fetchCommissionOverview(start: string, end: string): Promise<CommissionOverviewRow[]> {
  const { data, error } = await supabase.rpc('get_commission_overview', { p_start: start, p_end: end });
  fail(error);
  return ((data ?? []) as CommissionOverviewRow[]).map((r) => ({
    ...r,
    jobs_count: Number(r.jobs_count),
    earned_cents: Number(r.earned_cents),
    adjustment_cents: Number(r.adjustment_cents),
    pending_cents: Number(r.pending_cents),
    approved_cents: Number(r.approved_cents),
    paid_cents: Number(r.paid_cents),
  }));
}

// ---------- writes (all via RPC) ----------

export async function saveCommissionPlan(plan: {
  id: string | null;
  name: string;
  description: string;
  tierMode: TierMode;
  tierPeriod: TierPeriod;
  isDefault: boolean;
  active: boolean;
  tiers: CommissionTier[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('save_commission_plan', {
    p_plan_id: plan.id,
    p_name: plan.name,
    p_description: plan.description,
    p_tier_mode: plan.tierMode,
    p_tier_period: plan.tierPeriod,
    p_is_default: plan.isDefault,
    p_active: plan.active,
    p_tiers: plan.tiers,
  });
  fail(error);
  return data as string;
}

export async function assignEmployeePlan(employeeId: string, planId: string | null): Promise<void> {
  const { error } = await supabase.rpc('assign_employee_commission_plan', { p_employee_id: employeeId, p_plan_id: planId });
  fail(error);
}

export async function generateCommissionRecords(start: string, end: string): Promise<GenerationCounts> {
  const { data, error } = await supabase.rpc('generate_commission_records', { p_period_start: start, p_period_end: end });
  fail(error);
  return (data ?? {}) as GenerationCounts;
}

export async function setJobOverride(o: {
  jobId: string;
  employeeId: string | null;
  type: OverrideType;
  ratePercent: number | null;
  flatCents: number | null;
  reason: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('set_commission_job_override', {
    p_job_id: o.jobId,
    p_employee_id: o.employeeId,
    p_type: o.type,
    p_rate_percent: o.ratePercent,
    p_flat_cents: o.flatCents,
    p_reason: o.reason,
  });
  fail(error);
  return data as string;
}

export async function removeJobOverride(overrideId: string): Promise<string> {
  const { data, error } = await supabase.rpc('remove_commission_job_override', { p_override_id: overrideId });
  fail(error);
  return data as string;
}

export async function addAdjustment(a: {
  employeeId: string;
  kind: 'adjustment' | 'clawback';
  amountCents: number;
  jobId: string | null;
  memo: string;
  earnedDate: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('add_commission_adjustment', {
    p_employee_id: a.employeeId,
    p_kind: a.kind,
    p_amount_cents: a.amountCents,
    p_job_id: a.jobId,
    p_memo: a.memo,
    p_earned_date: a.earnedDate,
  });
  fail(error);
}

export async function buildStatements(start: string, end: string, employeeId?: string): Promise<{ created: number; skipped_negative: number }> {
  const { data, error } = await supabase.rpc('build_commission_statements', {
    p_period_start: start,
    p_period_end: end,
    p_employee_id: employeeId ?? null,
  });
  fail(error);
  return data as { created: number; skipped_negative: number };
}

export async function transitionStatement(id: string, action: StatementAction, note?: string): Promise<void> {
  const { error } = await supabase.rpc('transition_commission_statement', { p_id: id, p_action: action, p_note: note ?? null });
  fail(error);
}

export async function markStatementsExported(ids: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('mark_commission_statements_exported', { p_ids: ids });
  fail(error);
  return Number(data ?? 0);
}

export async function markStatementsPaid(ids: string[], reference: string): Promise<number> {
  const { data, error } = await supabase.rpc('mark_commission_statements_paid', { p_ids: ids, p_reference: reference || null });
  fail(error);
  return Number(data ?? 0);
}
