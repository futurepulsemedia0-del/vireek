/**
 * Payment Plans — API layer (Supabase). RLS already scopes reads to the account owner; the explicit
 * `.eq('user_id', ownerId)` is defence-in-depth (accountOwnerId scoping). All writes go through RPCs / edge functions.
 */

import { supabase } from '@/lib/supabase';
import type { InstallmentRow, PlanEventRow, PlanRow, PlanStats } from '@/lib/paymentPlans';

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

const rpcError = (error: { message?: string } | null, fallback: string) => new Error(error?.message || fallback);

export async function fetchPlans(ownerId: string): Promise<PlanRow[]> {
  const { data, error } = await supabase
    .from('payment_plans')
    .select('*, payment_plan_installments(*)')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return ((data ?? []) as PlanRow[]).map((p) => ({
    ...p,
    payment_plan_installments: [...(p.payment_plan_installments ?? [])].sort((a: InstallmentRow, b: InstallmentRow) => a.seq - b.seq),
  }));
}

export async function fetchPlanStats(): Promise<PlanStats> {
  const { data, error } = await supabase.rpc('get_payment_plan_stats');
  if (error) throw error;
  return data as PlanStats;
}

export async function fetchPlanEvents(ownerId: string, planId: string): Promise<PlanEventRow[]> {
  const { data, error } = await supabase
    .from('payment_plan_events')
    .select('id, type, detail, created_at')
    .eq('user_id', ownerId)
    .eq('plan_id', planId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as PlanEventRow[];
}

export interface PlanJobOption { id: string; customer_name: string; customer_phone: string | null; service_type: string | null; invoice_amount: number | null }

export async function fetchJobsForPlan(ownerId: string): Promise<PlanJobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, customer_phone, service_type, invoice_amount')
    .eq('user_id', ownerId)
    .gt('invoice_amount', 0)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as PlanJobOption[];
}

export async function createPlan(payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.rpc('create_payment_plan', { p: payload });
  if (error) throw rpcError(error, 'Could not create the plan.');
  return data as string;
}

async function action(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('payment-plan-actions', { body });
  if (error) throw new Error(await functionErrorMessage(error, 'Something went wrong. Please try again.'));
  return (data ?? {}) as Record<string, unknown>;
}

export const sendPlan = (planId: string) => action({ action: 'send', plan_id: planId });
export const chargeInstallmentNow = async (installmentId: string) =>
  (await action({ action: 'charge_now', installment_id: installmentId })) as { outcome?: 'paid' | 'failed' | 'requires_action'; error?: string | null };

export async function waiveLateFee(installmentId: string): Promise<void> {
  const { error } = await supabase.rpc('waive_plan_late_fee', { p_installment_id: installmentId });
  if (error) throw rpcError(error, 'Could not waive the late fee.');
}

export async function recordOfflinePayment(installmentId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('record_offline_installment_payment', { p_installment_id: installmentId, p_note: note || null });
  if (error) throw rpcError(error, 'Could not record the payment.');
}

export async function setPlanStatus(planId: string, act: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const { error } = await supabase.rpc('set_payment_plan_status', { p_plan_id: planId, p_action: act });
  if (error) throw rpcError(error, 'Could not update the plan.');
}
