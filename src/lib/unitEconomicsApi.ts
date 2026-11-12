import { supabase } from '@/lib/supabase';
import { parseExtras, parseUeReport, parseUsageEvents, type MarginExtras, type UeReport, type UsageEventTotal } from '@/lib/marginDashboard';
import type { CostComponent, CostRate } from '@/lib/unitEconomics';
import { parseAiUsage, type AiUsageBreakdown } from '@/lib/aiRepricing';
import type { InvoiceInput, LimitInput, RateInput } from '@/lib/unitEconomicsInputs';

export class UnitEconomicsError extends Error {
  constructor(message: string, readonly forbidden: boolean) {
    super(message);
  }
}

function fail(error: { message: string; code?: string }): never {
  throw new UnitEconomicsError(error.message, error.code === '42501');
}

const win = (start: Date, end: Date) => ({ p_start: start.toISOString(), p_end: end.toISOString() });

/** All RPCs re-check is_vireek_staff server-side; RLS on the tables does the same for direct reads/writes. */
export async function fetchUnitEconomics(start: Date, end: Date): Promise<UeReport> {
  const { data, error } = await supabase.rpc('staff_unit_economics', win(start, end));
  if (error) fail(error);
  const r = parseUeReport(data);
  if (!r) throw new UnitEconomicsError('Unexpected response from the margin report.', false);
  return r;
}

export async function fetchMarginExtras(start: Date, end: Date): Promise<MarginExtras> {
  const { data, error } = await supabase.rpc('staff_margin_extras', win(start, end));
  if (error) fail(error);
  return parseExtras(data);
}

export async function fetchUsageEvents(start: Date, end: Date): Promise<UsageEventTotal[]> {
  const { data, error } = await supabase.rpc('staff_usage_events_summary', win(start, end));
  if (error) fail(error);
  return parseUsageEvents(data);
}

export async function fetchStorageSummary(): Promise<UsageEventTotal | null> {
  const { data, error } = await supabase.rpc('staff_storage_summary');
  if (error) fail(error);
  return storageToUsage(data);
}

export async function fetchAiUsage(start: Date, end: Date): Promise<AiUsageBreakdown> {
  const { data, error } = await supabase.rpc('staff_ai_usage_breakdown', win(start, end));
  if (error) fail(error);
  return parseAiUsage(data);
}
export interface RateRow extends CostRate { id: string; sourceUrl: string | null }

export async function listRates(): Promise<RateRow[]> {
  const { data, error } = await supabase.from('provider_cost_rates').select('*').order('effective_from', { ascending: false }).limit(500);
  if (error) fail(error);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id), component: r.component as CostComponent, provider: String(r.provider), unit: String(r.unit), rateUsd: Number(r.rate_usd),
    source: String(r.source), sourceUrl: (r.source_url as string | null) ?? null, effectiveFrom: String(r.effective_from), effectiveTo: (r.effective_to as string | null) ?? null,
    status: (r.status as string | null | undefined) ?? null,
  }));
}

export async function insertRate(i: RateInput): Promise<void> {
  const { error } = await supabase.from('provider_cost_rates').insert({
    component: i.component, provider: i.provider, unit: i.unit, rate_usd: i.rateUsd, source: i.source, source_url: i.sourceUrl,
    effective_from: i.effectiveFrom, effective_to: i.effectiveTo,
  });
  if (error) fail(error);
}

/** Ends a rate (sets effective_to) instead of deleting it, so history stays reproducible. */
export async function endRate(id: string, effectiveTo: string): Promise<void> {
  const { error } = await supabase.from('provider_cost_rates').update({ effective_to: effectiveTo }).eq('id', id);
  if (error) fail(error);
}

export interface LimitRow { plan: string; softCostUsd: number | null; hardCostUsd: number | null; maxCallSeconds: number | null }

export async function listLimits(): Promise<LimitRow[]> {
  const { data, error } = await supabase.from('plan_cost_limits').select('*').order('plan');
  if (error) fail(error);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return (data ?? []).map((r: Record<string, unknown>) => ({ plan: String(r.plan), softCostUsd: n(r.soft_cost_usd), hardCostUsd: n(r.hard_cost_usd), maxCallSeconds: n(r.max_call_seconds) }));
}

export async function upsertLimit(i: LimitInput): Promise<void> {
  const { error } = await supabase.from('plan_cost_limits').upsert(
    { plan: i.plan, soft_cost_usd: i.softCostUsd, hard_cost_usd: i.hardCostUsd, max_call_seconds: i.maxCallSeconds, updated_at: new Date().toISOString() },
    { onConflict: 'plan' },
  );
  if (error) fail(error);
}

export async function deleteLimit(plan: string): Promise<void> {
  const { error } = await supabase.from('plan_cost_limits').delete().eq('plan', plan);
  if (error) fail(error);
}

export async function upsertInvoice(i: InvoiceInput): Promise<void> {
  const { error } = await supabase.from('provider_invoices').upsert(
    { provider: i.provider, period_month: i.periodMonth, invoiced_usd: i.invoicedUsd, invoice_ref: i.invoiceRef },
    { onConflict: 'provider,period_month' },
  );
  if (error) fail(error);
}

export interface AuditRow { id: number; table_name: string; row_key: string | null; action: string; actor: string | null; changed_at: string }

export async function listAudit(limit = 30): Promise<AuditRow[]> {
  const { data, error } = await supabase.from('unit_economics_audit').select('id, table_name, row_key, action, actor, changed_at').order('id', { ascending: false }).limit(limit);
  if (error) fail(error);
  return (data ?? []) as AuditRow[];
}
