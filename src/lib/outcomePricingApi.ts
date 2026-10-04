// Outcome-Based Pricing Engine — data access.
// Pure pricing math lives in src/lib/outcomePricing.ts; this file only talks to Supabase.
// Server counterpart: supabase/migrations/20270215000000_outcome_pricing_engine.sql

import { supabase } from '@/lib/supabase';
import {
  type AssetInput,
  type CreditTier,
  DEFAULT_ANNUAL_CREDIT_CAP_PCT,
  DEFAULT_ASSUMPTIONS,
  DEFAULT_CREDIT_SCHEDULE,
  type Decision,
  type PricingAssumptions,
  type PricingResult,
} from '@/lib/outcomePricing';

export type QuoteStatus = 'draft' | 'quoted' | 'active' | 'completed' | 'declined' | 'cancelled';

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  quoted: 'Quoted',
  active: 'Active',
  completed: 'Completed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

export const QUOTE_STATUS_COLORS: Record<QuoteStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  quoted: 'bg-warning-500/10 text-warning-500',
  active: 'bg-success-500/10 text-success-500',
  completed: 'bg-accent/10 text-accent',
  declined: 'bg-danger/10 text-danger',
  cancelled: 'bg-danger/10 text-danger',
};

export interface QuoteRow {
  id: string;
  customer_id: string;
  contract_id: string | null;
  name: string;
  target_uptime_pct: number;
  term_months: number;
  status: QuoteStatus;
  decision: Decision;
  review_note: string | null;
  monthly_fee_cents: number;
  annual_price_cents: number;
  term_value_cents: number;
  expected_margin_pct: number | null;
  probability_of_loss: number | null;
  model_version: string;
  result: PricingResult;
  credit_schedule: Array<{ up_to_pts: number; credit_pct: number }>;
  annual_credit_cap_pct: number;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  customers?: { name: string } | null;
}

export interface QuoteAssetRow {
  id: string;
  quote_id: string;
  equipment_id: string | null;
  label: string;
  equipment_type: string;
  pm_visits_per_year: number;
  operating_hours_per_year: number;
  annual_price_cents: number;
  expected_uptime_pct: number | null;
  p_meet_target: number | null;
}

export interface PeriodRow {
  id: string;
  quote_id: string;
  asset_id: string;
  period_start: string;
  period_end: string;
  operating_minutes: number;
  downtime_minutes: number;
  failures: number;
  measured_uptime_pct: number;
  shortfall_pts: number;
  credit_pct: number;
  credit_cents: number;
  actual_cost_cents: number | null;
  notes: string | null;
}

export interface PricingSettings {
  assumptions: PricingAssumptions;
  creditSchedule: CreditTier[];
  annualCreditCapPct: number;
}

export interface CustomerOption {
  id: string;
  name: string;
}

export interface CandidateAsset {
  input: AssetInput;
  repairEvents: number;
  lastRepairAt: string | null;
}

const fromDbSchedule = (rows: Array<{ up_to_pts: number; credit_pct: number }> | null | undefined): CreditTier[] =>
  rows && rows.length ? rows.map((r) => ({ upToPts: Number(r.up_to_pts), creditPct: Number(r.credit_pct) })) : DEFAULT_CREDIT_SCHEDULE;

const toDbSchedule = (tiers: CreditTier[]) => tiers.map((t) => ({ up_to_pts: t.upToPts, credit_pct: t.creditPct }));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function fetchPricingSettings(): Promise<PricingSettings> {
  const { data, error } = await supabase
    .from('outcome_pricing_settings')
    .select('assumptions, credit_schedule, annual_credit_cap_pct')
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    assumptions: Partial<PricingAssumptions> | null;
    credit_schedule: Array<{ up_to_pts: number; credit_pct: number }> | null;
    annual_credit_cap_pct: number | null;
  } | null;
  return {
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...(row?.assumptions ?? {}) },
    creditSchedule: fromDbSchedule(row?.credit_schedule),
    annualCreditCapPct: row?.annual_credit_cap_pct != null ? Number(row.annual_credit_cap_pct) : DEFAULT_ANNUAL_CREDIT_CAP_PCT,
  };
}

export async function savePricingSettings(settings: PricingSettings): Promise<void> {
  const { error } = await supabase.rpc('save_outcome_pricing_settings', {
    p_assumptions: settings.assumptions,
    p_credit_schedule: toDbSchedule(settings.creditSchedule),
    p_cap_pct: settings.annualCreditCapPct,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Customers + assets
// ---------------------------------------------------------------------------

export async function fetchCustomerOptions(): Promise<CustomerOption[]> {
  const { data, error } = await supabase.from('customers').select('id, name').order('name').limit(500);
  if (error) throw error;
  return (data ?? []) as CustomerOption[];
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export async function fetchCandidateAssets(customerId: string): Promise<CandidateAsset[]> {
  const [eqRes, histRes] = await Promise.all([
    supabase
      .from('equipment')
      .select('id, equipment_type, make, model, install_date, expected_lifespan_years, service_interval_months, last_service_date')
      .eq('customer_id', customerId)
      .eq('status', 'active')
      .order('created_at'),
    supabase.rpc('outcome_pricing_equipment_history', { p_customer_id: customerId, p_window_months: 36 }),
  ]);
  if (eqRes.error) throw eqRes.error;
  if (histRes.error) throw histRes.error;

  const history = new Map<string, { repair_events: number; observed_years: number; last_repair_at: string | null }>();
  for (const h of (histRes.data ?? []) as Array<{ equipment_id: string; repair_events: number; observed_years: number; last_repair_at: string | null }>) {
    history.set(h.equipment_id, { repair_events: h.repair_events, observed_years: Number(h.observed_years), last_repair_at: h.last_repair_at });
  }

  const now = Date.now();
  return ((eqRes.data ?? []) as Array<{
    id: string;
    equipment_type: string;
    make: string | null;
    model: string | null;
    install_date: string | null;
    expected_lifespan_years: number;
    service_interval_months: number;
    last_service_date: string | null;
  }>).map((e) => {
    const h = history.get(e.id);
    const label = [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type;
    const ageYears = e.install_date ? Math.max(0, (now - new Date(e.install_date).getTime()) / MS_PER_YEAR) : e.expected_lifespan_years / 2;
    const lastService = e.last_service_date ?? e.install_date;
    return {
      repairEvents: h?.repair_events ?? 0,
      lastRepairAt: h?.last_repair_at ?? null,
      input: {
        id: e.id,
        label: `${label} (${e.equipment_type})`,
        equipmentType: e.equipment_type,
        ageYears: Math.round(ageYears * 10) / 10,
        expectedLifespanYears: Math.max(1, e.expected_lifespan_years),
        serviceIntervalMonths: Math.max(1, e.service_interval_months),
        monthsSinceService: lastService ? Math.max(0, (now - new Date(lastService).getTime()) / (MS_PER_YEAR / 12)) : null,
        observedFailures: h?.repair_events ?? 0,
        observedYears: Math.max(0, h?.observed_years ?? 0),
        operatingHoursPerYear: 8760,
        downtimeCostPerHour: 0,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface SaveDraftArgs {
  customerId: string;
  name: string;
  result: PricingResult;
  assets: AssetInput[];
  assumptions: PricingAssumptions;
  creditSchedule: CreditTier[];
  annualCreditCapPct: number;
}

export async function saveQuoteDraft(args: SaveDraftArgs): Promise<string> {
  const { result } = args;
  if (result.decision === 'not_offerable') throw new Error('This guarantee is not offerable at the chosen target — nothing to save.');
  if (!args.name.trim()) throw new Error('Give the guarantee a name.');
  const payload = {
    customer_id: args.customerId,
    name: args.name.trim(),
    target_uptime_pct: result.targetUptimePct,
    term_months: result.termMonths,
    decision: result.decision,
    monthly_fee_cents: result.priceMonthlyCents,
    annual_price_cents: result.priceAnnualCents,
    term_value_cents: result.priceTermCents,
    expected_margin_pct: result.risk.expectedMarginPct,
    probability_of_loss: result.risk.probabilityOfLoss,
    model_version: result.modelVersion,
    inputs: { assets: args.assets, assumptions: args.assumptions },
    result,
    credit_schedule: toDbSchedule(args.creditSchedule),
    annual_credit_cap_pct: args.annualCreditCapPct,
    assets: result.assets.map((a) => {
      const src = args.assets.find((x) => x.id === a.id);
      return {
        equipment_id: a.id,
        label: a.label,
        equipment_type: a.equipmentType,
        pm_visits_per_year: a.pmVisitsPerYear,
        operating_hours_per_year: src?.operatingHoursPerYear ?? 8760,
        annual_price_cents: a.priceAnnualCents,
        expected_uptime_pct: a.expectedUptimePct,
        p_meet_target: a.pMeetTarget,
        details: { baseFailuresPerYear: a.baseFailuresPerYear, plannedFailuresPerYear: a.plannedFailuresPerYear, components: a.components },
      };
    }),
  };
  const { data, error } = await supabase.rpc('save_outcome_guarantee_draft', { p_payload: payload });
  if (error) throw error;
  return data as string;
}

export async function fetchQuotes(): Promise<QuoteRow[]> {
  const { data, error } = await supabase
    .from('outcome_guarantee_quotes')
    .select('*, customers(name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as QuoteRow[];
}

export async function fetchQuoteDetail(quoteId: string): Promise<{ assets: QuoteAssetRow[]; periods: PeriodRow[] }> {
  const [a, p] = await Promise.all([
    supabase.from('outcome_guarantee_assets').select('*').eq('quote_id', quoteId).order('created_at'),
    supabase.from('outcome_guarantee_periods').select('*').eq('quote_id', quoteId).order('period_start', { ascending: false }),
  ]);
  if (a.error) throw a.error;
  if (p.error) throw p.error;
  return { assets: (a.data ?? []) as QuoteAssetRow[], periods: (p.data ?? []) as PeriodRow[] };
}

export async function finalizeQuote(quoteId: string, reviewNote: string | null): Promise<void> {
  const { error } = await supabase.rpc('finalize_outcome_quote', { p_quote_id: quoteId, p_review_note: reviewNote });
  if (error) throw error;
}

export async function activateQuote(quoteId: string, startsOn: string, createContract: boolean): Promise<void> {
  const { error } = await supabase.rpc('activate_outcome_guarantee', { p_quote_id: quoteId, p_starts_on: startsOn, p_create_contract: createContract });
  if (error) throw error;
}

export async function closeQuote(quoteId: string, status: 'declined' | 'cancelled' | 'completed', note: string | null): Promise<void> {
  const { error } = await supabase.rpc('close_outcome_guarantee', { p_quote_id: quoteId, p_status: status, p_note: note });
  if (error) throw error;
}

export async function deleteDraftQuote(quoteId: string): Promise<void> {
  const { data, error } = await supabase.from('outcome_guarantee_quotes').delete().eq('id', quoteId).eq('status', 'draft').select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('Only drafts can be deleted.');
}

export interface RecordPeriodArgs {
  assetId: string;
  periodStart: string;
  periodEnd: string;
  operatingMinutes: number;
  downtimeMinutes: number;
  failures: number;
  actualCostCents: number | null;
  notes: string | null;
}

export async function recordPeriod(a: RecordPeriodArgs): Promise<PeriodRow> {
  const { data, error } = await supabase.rpc('record_outcome_period', {
    p_asset_id: a.assetId,
    p_period_start: a.periodStart,
    p_period_end: a.periodEnd,
    p_operating_minutes: a.operatingMinutes,
    p_downtime_minutes: a.downtimeMinutes,
    p_failures: a.failures,
    p_actual_cost_cents: a.actualCostCents,
    p_notes: a.notes,
  });
  if (error) throw error;
  return data as PeriodRow;
}

/** Linked completed repair visits for one asset in a window — a hint for the failure count. */
export async function countRepairVisits(equipmentId: string, fromIso: string, toIso: string): Promise<number> {
  const { count, error } = await supabase
    .from('job_equipment')
    .select('job_id, jobs!inner(scheduled_datetime, job_status)', { count: 'exact', head: true })
    .eq('equipment_id', equipmentId)
    .eq('service_type', 'repair')
    .eq('jobs.job_status', 'completed')
    .gte('jobs.scheduled_datetime', fromIso)
    .lte('jobs.scheduled_datetime', toIso);
  if (error) throw error;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Pure helpers for the delivery view
// ---------------------------------------------------------------------------

export interface DeliverySummary {
  periods: number;
  creditOwedCents: number;
  actualCostCents: number;
  billedCents: number;
  avgUptimePct: number | null;
  worstUptimePct: number | null;
}

export function summarizeDelivery(quote: QuoteRow, periods: PeriodRow[]): DeliverySummary {
  let operating = 0;
  let down = 0;
  let credit = 0;
  let cost = 0;
  let worst: number | null = null;
  for (const p of periods) {
    operating += p.operating_minutes;
    down += p.downtime_minutes;
    credit += p.credit_cents;
    cost += p.actual_cost_cents ?? 0;
    worst = worst === null ? Number(p.measured_uptime_pct) : Math.min(worst, Number(p.measured_uptime_pct));
  }
  return {
    periods: periods.length,
    creditOwedCents: credit,
    actualCostCents: cost,
    billedCents: quote.monthly_fee_cents * periods.length,
    avgUptimePct: operating > 0 ? Math.round((1 - down / operating) * 100000) / 1000 : null,
    worstUptimePct: worst,
  };
}

export function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Day after the last recorded period of ONE asset (or the contract start if none yet). */
export function nextPeriodStart(quote: QuoteRow, assetPeriods: PeriodRow[]): string | null {
  if (!quote.starts_on) return null;
  if (assetPeriods.length === 0) return quote.starts_on;
  const last = assetPeriods.reduce((m, p) => (p.period_end > m ? p.period_end : m), assetPeriods[0].period_end);
  return dayAfter(last);
}

/** End of a one-month billing period starting at `start` (matches the 28–31 day rule in SQL). */
export function periodEndFor(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // Month overflow (e.g. Jan 31 -> Mar 3): clamp back to the last day of the target month.
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
