import { supabase } from '@/lib/supabase';
import { parseUsageCsv, type UsageDraft } from '@/lib/energyCsv';
import {
  paybackYears,
  projectSavings,
  type EnergyAnomaly,
  type EnergyReport,
  type EquipmentEnergyRow,
  type Fuel,
  type Opportunity,
  type OpportunityMeasure,
} from '../../supabase/functions/_shared/energy-intelligence/engine';
import {
  formatUsd,
  runRebateAnalysis,
  type RebateAnalysisResult,
  type ReplacementOption,
} from '@/lib/rebateIntelligence';

/**
 * Vireek Energy Intelligence - dashboard client.
 *
 * All analysis runs server-side (supabase/functions/energy-intelligence) in a pure,
 * deterministic engine. This module invokes it, manages the account's utility-bill
 * history, bridges opportunities into Rebate Intelligence, and holds display metadata.
 */

export type {
  EnergyAnomaly,
  EnergyReport,
  EquipmentEnergyRow,
  Fuel,
  Opportunity,
  OpportunityMeasure,
};
export { formatUsd, paybackYears, projectSavings, parseUsageCsv };
export type { UsageDraft };

export const DEFAULT_ESCALATION_PCT = 2.5;

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export const ANOMALY_LABELS: Record<EnergyAnomaly['kind'], string> = {
  usage_spike: 'Usage spike',
  usage_drop: 'Usage drop',
  yoy_increase: 'Year-over-year increase',
  baseload_creep: 'Baseload creep',
  rate_increase: 'Price increase',
  equipment_signal: 'Equipment signal',
};

export const SEVERITY_TONE: Record<EnergyAnomaly['severity'], string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

export const CONFIDENCE_TONE: Record<EnergyReport['confidence'], string> = {
  high: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

export const CATEGORY_LABELS: Record<EquipmentEnergyRow['category'], string> = {
  cooling: 'Cooling',
  heat_pump: 'Heat pump',
  heating: 'Heating',
  water_heating: 'Water heating',
  controls: 'Controls',
  other: 'Other',
};

export const STAGE_TONE: Record<EquipmentEnergyRow['stage'], { label: string; tone: string }> = {
  unknown: { label: 'Age unknown', tone: 'bg-bg-tertiary text-text-secondary' },
  early: { label: 'Early life', tone: 'bg-success-500/10 text-success-500' },
  mid: { label: 'Mid life', tone: 'bg-success-500/10 text-success-500' },
  late: { label: 'Plan replacement', tone: 'bg-warning-500/10 text-warning-500' },
  past_life: { label: 'Past expected life', tone: 'bg-danger-500/10 text-danger-500' },
};

export const GRADE_TONE: Record<string, string> = {
  A: 'text-success-500',
  B: 'text-success-500',
  C: 'text-warning-500',
  D: 'text-warning-500',
  E: 'text-danger-500',
};

export const fmtNum = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined
    ? '-'
    : n.toLocaleString('en-US', { maximumFractionDigits: digits });

export const fmtMoney = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '-' : formatUsd(cents);

export const monthLabel = (key: string): string => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
};

// ---------------------------------------------------------------------------
// Invoke helpers
// ---------------------------------------------------------------------------

async function extractInvokeError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through
    }
  }
  return error instanceof Error ? error.message : 'Could not run Energy Intelligence.';
}

export interface EnergyRequest {
  customerId: string;
  siteId?: string | null;
  escalationPct?: number;
}

export interface EnergyAnalysisResult {
  analysisId: string | null;
  persisted: boolean;
  siteId: string | null;
  report: EnergyReport;
}

export async function runEnergyAnalysis(req: EnergyRequest): Promise<EnergyAnalysisResult> {
  const { data, error } = await supabase.functions.invoke('energy-intelligence', {
    body: {
      mode: 'site',
      customerId: req.customerId,
      siteId: req.siteId ?? null,
      escalation_pct: req.escalationPct ?? DEFAULT_ESCALATION_PCT,
    },
  });
  if (error) throw new Error(await extractInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  if (!data?.report) throw new Error('Energy Intelligence returned no result.');
  return {
    analysisId: data.analysis_id ?? null,
    persisted: data.persisted !== false,
    siteId: data.site_id ?? null,
    report: data.report as EnergyReport,
  };
}

export interface PortfolioRow {
  customer_id: string;
  name: string;
  months_covered: number;
  annual_cost_cents: number | null;
  expected_savings_cents: number | null;
  high_anomalies: number;
  grade: string | null;
  score: number | null;
  confidence: EnergyReport['confidence'];
  top_opportunity: string | null;
}

export async function runEnergyPortfolio(): Promise<PortfolioRow[]> {
  const { data, error } = await supabase.functions.invoke('energy-intelligence', {
    body: { mode: 'portfolio' },
  });
  if (error) throw new Error(await extractInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return (data?.rows ?? []) as PortfolioRow[];
}

// ---------------------------------------------------------------------------
// Utility-bill history
// ---------------------------------------------------------------------------

export interface UsagePeriodRow {
  id: string;
  customer_id: string;
  site_id: string | null;
  fuel: Fuel;
  period_start: string;
  period_end: string;
  usage: number;
  cost_cents: number | null;
  source: 'manual' | 'import';
}

export async function fetchUsagePeriods(customerId: string): Promise<UsagePeriodRow[]> {
  const { data, error } = await supabase
    .from('energy_usage_periods')
    .select('id, customer_id, site_id, fuel, period_start, period_end, usage, cost_cents, source')
    .eq('customer_id', customerId)
    .order('period_start', { ascending: false })
    .limit(600);
  if (error) throw error;
  return ((data ?? []) as UsagePeriodRow[]).map((r) => ({ ...r, usage: Number(r.usage) }));
}

export async function saveUsagePeriods(
  customerId: string,
  siteId: string | null,
  fuel: Fuel,
  rows: UsageDraft[],
  source: 'manual' | 'import',
): Promise<number> {
  let saved = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows
      .slice(i, i + 200)
      .map((r) => ({ customer_id: customerId, site_id: siteId, fuel, source, ...r }));
    const { error } = await supabase
      .from('energy_usage_periods')
      .upsert(chunk, { onConflict: 'customer_id,site_id,fuel,period_start' });
    if (error) throw error;
    saved += chunk.length;
  }
  return saved;
}

export async function deleteUsagePeriod(id: string): Promise<void> {
  const { error } = await supabase.from('energy_usage_periods').delete().eq('id', id);
  if (error) throw error;
}

export interface SiteOption {
  id: string;
  name: string;
  is_primary: boolean;
  city: string | null;
  state: string | null;
}

export async function fetchCustomerSites(customerId: string): Promise<SiteOption[]> {
  const { data, error } = await supabase
    .from('customer_sites')
    .select('id, name, is_primary, city, state')
    .eq('customer_id', customerId)
    .order('is_primary', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as SiteOption[];
}

// ---------------------------------------------------------------------------
// Bridge: opportunity -> Rebate Intelligence (net cost, incentives, financing)
// ---------------------------------------------------------------------------

/** Planning prices only, pre-filled in the UI and always editable; replace with a real quote. */
export const PLANNING_COST_CENTS: Record<OpportunityMeasure, number> = {
  central_ac: 650_000,
  heat_pump_hvac: 1_200_000,
  furnace: 480_000,
  smart_thermostat: 25_000,
  insulation_air_sealing: 350_000,
};

export function opportunityToRebateOption(
  o: Opportunity,
  installedCostCents: number,
): ReplacementOption {
  return {
    key: o.id.slice(0, 40),
    label: o.title.slice(0, 80),
    measure: o.measure,
    installed_cost_cents: Math.round(installedCostCents),
    efficiency: {
      ...(o.target_efficiency.seer2 ? { seer2: o.target_efficiency.seer2 } : {}),
      ...(o.target_efficiency.hspf2 ? { hspf2: o.target_efficiency.hspf2 } : {}),
      ...(o.target_efficiency.afue ? { afue: o.target_efficiency.afue } : {}),
    },
    annual_energy_savings_cents: o.savings_cents
      ? Math.min(o.savings_cents.expected, Math.round(installedCostCents))
      : null,
  };
}

export interface OpportunityFinance {
  gross_cost_cents: number;
  incentives_expected_cents: number;
  net_cost_cents: number;
  annual_savings_cents: number | null;
  payback_years: number | null;
  ten_year_net_cents: number | null;
  best_program: string | null;
  deadline: string | null;
}

export async function runOpportunityRebateCheck(args: {
  customerId: string;
  siteId: string | null;
  opportunity: Opportunity;
  installedCostCents: number;
  escalationPct: number;
}): Promise<{ result: RebateAnalysisResult; finance: OpportunityFinance }> {
  const { opportunity: o } = args;
  const result = await runRebateAnalysis({
    customerId: args.customerId,
    siteId: args.siteId,
    equipmentId: o.equipment_id,
    property: {},
    options: [opportunityToRebateOption(o, args.installedCostCents)],
  });
  const opt = result.report.options[0];
  const annual = o.savings_cents?.expected ?? null;
  const net = opt ? opt.net_cost_expected_cents : args.installedCostCents;
  const first = opt?.incentives.find((i) => i.status === 'eligible' || i.status === 'likely');
  const deadline = result.report.deadline_alerts[0];
  const ten =
    annual === null
      ? null
      : projectSavings(annual, 10, args.escalationPct)[9].cumulative_cents - net;
  return {
    result,
    finance: {
      gross_cost_cents: args.installedCostCents,
      incentives_expected_cents: opt ? opt.total_expected_cents : 0,
      net_cost_cents: net,
      annual_savings_cents: annual,
      payback_years: annual === null ? null : paybackYears(net, annual, args.escalationPct),
      ten_year_net_cents: ten,
      best_program: first ? first.name : null,
      deadline: deadline ? `${deadline.program} ends in ${deadline.days_left} days` : null,
    },
  };
}
