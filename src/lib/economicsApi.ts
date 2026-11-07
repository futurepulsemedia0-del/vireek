// Staff economics API: thin typed wrappers over the staff-gated RPCs added in
// 20281110000000_economics_cost_ledger.sql and 20281111000000_economics_unit_costs_alerts_roi.sql.
// Every RPC re-checks is_vireek_staff server-side; the parsers are defensive (jsonb -> typed, unknown -> null).
import { supabase } from '@/lib/supabase';
import { UnitEconomicsError } from '@/lib/unitEconomicsApi';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface UnitCosts {
  callsHandled: number; callsWithCost: number; microPerCall: number | null;
  bookedCalls: number; bookedCallsWithCost: number; microPerBookingDirect: number | null; microPerBookingLoaded: number | null;
  paidJobs: number; paidCallsWithCost: number; microPerPaidJobDirect: number | null;
  workflowRunsWithCost: number; workflowRunsCompletedWithCost: number; microPerWorkflowRun: number | null; microPerCompletedWorkflow: number | null;
  notes: string[];
}
export function parseUnitCosts(raw: unknown): UnitCosts | null {
  if (!isObj(raw)) return null;
  const n = (k: string) => toNum(raw[k]) ?? 0;
  return {
    callsHandled: n('calls_handled'), callsWithCost: n('calls_with_cost'), microPerCall: toNum(raw.micro_per_call),
    bookedCalls: n('booked_calls'), bookedCallsWithCost: n('booked_calls_with_cost'),
    microPerBookingDirect: toNum(raw.micro_per_booking_direct), microPerBookingLoaded: toNum(raw.micro_per_booking_loaded),
    paidJobs: n('paid_jobs'), paidCallsWithCost: n('paid_calls_with_cost'), microPerPaidJobDirect: toNum(raw.micro_per_paid_job_direct),
    workflowRunsWithCost: n('workflow_runs_with_cost'), workflowRunsCompletedWithCost: n('workflow_runs_completed_with_cost'),
    microPerWorkflowRun: toNum(raw.micro_per_workflow_run), microPerCompletedWorkflow: toNum(raw.micro_per_completed_workflow),
    notes: arr(raw.notes).filter((x): x is string => typeof x === 'string'),
  };
}

export interface CoverageRow { resourceType: string; events: number; withCorrelation: number; withTenant: number; costMicro: number }
export function parseCoverage(raw: unknown): CoverageRow[] {
  return arr(raw).filter(isObj).map((r) => ({
    resourceType: String(r.resource_type ?? ''), events: toNum(r.events) ?? 0, withCorrelation: toNum(r.with_correlation) ?? 0,
    withTenant: toNum(r.with_tenant) ?? 0, costMicro: toNum(r.cost_micro) ?? 0,
  }));
}

export type ReconStatus = 'match' | 'within_tolerance' | 'over_threshold' | 'no_invoice' | 'no_ledger';
export interface ReconRow { provider: string; ledgerMicro: number | null; events: number; invoicedMicro: number | null; varianceMicro: number | null; variancePct: number | null; status: ReconStatus }
export function parseReconciliation(raw: unknown): ReconRow[] {
  const ok = new Set(['match', 'within_tolerance', 'over_threshold', 'no_invoice', 'no_ledger']);
  return arr(raw).filter(isObj).map((r) => ({
    provider: String(r.provider ?? ''), ledgerMicro: toNum(r.ledger_micro), events: toNum(r.events) ?? 0, invoicedMicro: toNum(r.invoiced_micro),
    varianceMicro: toNum(r.variance_micro), variancePct: toNum(r.variance_pct), status: (ok.has(String(r.status)) ? r.status : 'no_invoice') as ReconStatus,
  }));
}

export interface MarketplaceRow { agentId: string; runs: number; runsWithCost: number; costMicro: number; billedCents: number | null; platformFeeCents: number | null; vireekMarginCents: number | null }
export function parseMarketplace(raw: unknown): MarketplaceRow[] {
  return arr(raw).filter(isObj).map((r) => ({
    agentId: String(r.agent_id ?? ''), runs: toNum(r.runs) ?? 0, runsWithCost: toNum(r.runs_with_cost) ?? 0, costMicro: toNum(r.cost_micro) ?? 0,
    billedCents: toNum(r.billed_cents), platformFeeCents: toNum(r.platform_fee_cents), vireekMarginCents: toNum(r.vireek_margin_cents),
  }));
}

export interface OutcomeFeeInput { accountId: string; plan: string; costMicro: number; bookedJobs: number; recoveredCents: number }
export function parseOutcomeFeeInputs(raw: unknown): OutcomeFeeInput[] {
  return arr(raw).filter(isObj).map((r) => ({
    accountId: String(r.account_id ?? ''), plan: String(r.plan ?? 'free'), costMicro: toNum(r.cost_micro) ?? 0,
    bookedJobs: toNum(r.booked_jobs) ?? 0, recoveredCents: toNum(r.recovered_cents) ?? 0,
  })).filter((r) => r.accountId !== '');
}

export interface EconomicsAlert { id: string; kind: string; severity: string; details: unknown; createdAt: string; resolvedAt: string | null }

function fail(error: { message: string; code?: string }): never {
  throw new UnitEconomicsError(error.message, error.code === '42501');
}
const win = (s: Date, e: Date) => ({ p_start: s.toISOString(), p_end: e.toISOString() });

export async function fetchUnitCosts(s: Date, e: Date): Promise<UnitCosts | null> {
  const { data, error } = await supabase.rpc('staff_unit_costs', win(s, e)); if (error) fail(error); return parseUnitCosts(data);
}
export async function fetchCoverage(s: Date, e: Date): Promise<CoverageRow[]> {
  const { data, error } = await supabase.rpc('staff_ledger_coverage', win(s, e)); if (error) fail(error); return parseCoverage(data);
}
export async function fetchReconciliation(monthFirstDay: string): Promise<ReconRow[]> {
  const { data, error } = await supabase.rpc('staff_cost_reconciliation', { p_month: monthFirstDay }); if (error) fail(error); return parseReconciliation(data);
}
export async function fetchMarketplaceEconomics(s: Date, e: Date): Promise<MarketplaceRow[]> {
  const { data, error } = await supabase.rpc('staff_marketplace_economics', win(s, e)); if (error) fail(error); return parseMarketplace(data);
}
export async function fetchOutcomeFeeInputs(s: Date, e: Date): Promise<OutcomeFeeInput[]> {
  const { data, error } = await supabase.rpc('staff_outcome_fee_inputs', win(s, e)); if (error) fail(error); return parseOutcomeFeeInputs(data);
}
export async function fetchOpenAlerts(): Promise<EconomicsAlert[]> {
  const { data, error } = await supabase.from('economics_alerts').select('id, kind, severity, details, created_at, resolved_at').is('resolved_at', null).order('created_at', { ascending: false }).limit(50);
  if (error) fail(error);
  return arr(data).filter(isObj).map((r) => ({ id: String(r.id), kind: String(r.kind), severity: String(r.severity), details: r.details, createdAt: String(r.created_at), resolvedAt: null }));
}
export async function resolveAlert(id: string): Promise<void> {
  const { error } = await supabase.rpc('staff_resolve_economics_alert', { p_id: id }); if (error) fail(error);
}
/** Posts an OFFSETTING ledger event. Never edits history. `ref` makes the call idempotent. */
export async function postCostCorrection(a: { provider: string; monthFirstDay: string; deltaMicro: number; reason: string; ref: string }): Promise<void> {
  const { error } = await supabase.rpc('post_cost_correction', { p_provider: a.provider, p_month: a.monthFirstDay, p_delta_micro: a.deltaMicro, p_reason: a.reason, p_ref: a.ref });
  if (error) fail(error);
}

export const fmtMicroUsd = (m: number | null, digits = 4): string => (m === null ? 'n/a' : `$${(m / 1_000_000).toFixed(digits)}`);
export const fmtPct = (p: number | null): string => (p === null ? 'n/a' : `${p.toFixed(1)}%`);
