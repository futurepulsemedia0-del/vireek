/**
 * Business Digital Twin — client library.
 *
 * A lightweight, transparent model of the business (revenue, jobs,
 * technician capacity, cash) that projects forward in time under a set
 * of owner-chosen levers — hire technicians, change prices, shift
 * marketing spend, absorb a demand shock, expect churn to move — so the
 * owner can see the likely shape of a decision *before* making it.
 *
 * The math is deterministic and explainable on purpose (no black box):
 * every lever has one documented effect, uncertainty bands widen with
 * time via a fixed variance curve, and the only thing that changes
 * between runs is the per-lever `adjustment_factor`, which the twin
 * learns by comparing past projections to what actually happened
 * (see recordActualOutcome). That's the "digital twin" part: it doesn't
 * just simulate once, it gets calibrated to *your* business over time.
 *
 * Server counterpart: supabase/migrations/20261203000000_business_digital_twin.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type LeverType =
  | 'hire_technicians'
  | 'price_change'
  | 'marketing_spend'
  | 'demand_shock'
  | 'churn_change'
  | 'custom';

export interface TwinLever {
  id: string;
  type: LeverType;
  /** meaning depends on type — see LEVER_VALUE_HINTS */
  value: number;
  label: string;
  notes?: string;
}

export interface TwinBaseline {
  weekly_revenue: number;
  weekly_jobs_completed: number;
  technician_count: number;
  technician_weekly_capacity_hours: number;
  avg_job_hours: number;
  weekly_marketing_spend: number;
  cash_on_hand: number;
}

export interface TwinWeekProjection {
  week_index: number;
  revenue_expected: number;
  revenue_optimistic: number;
  revenue_pessimistic: number;
  jobs_expected: number;
  utilization_pct_expected: number;
  cash_cumulative_expected: number;
  cash_cumulative_optimistic: number;
  cash_cumulative_pessimistic: number;
}

export interface TwinSummary {
  revenue_total_expected: number;
  jobs_total_expected: number;
  utilization_avg_expected: number;
  cash_delta_expected: number;
  cash_delta_optimistic: number;
  cash_delta_pessimistic: number;
}

export interface TwinScenario {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  horizon_weeks: number;
  baseline: TwinBaseline;
  levers: TwinLever[];
  status: 'draft' | 'run' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface TwinRun {
  id: string;
  scenario_id: string;
  user_id: string;
  horizon_weeks: number;
  baseline: TwinBaseline;
  levers: TwinLever[];
  assumptions_used: Record<string, number>;
  weekly_projection: TwinWeekProjection[];
  summary: TwinSummary;
  narrative: string | null;
  actual_outcome: TwinActualOutcome | null;
  accuracy_score: number | null;
  compared_at: string | null;
  created_at: string;
}

export interface TwinActualOutcome {
  actual_revenue_total: number;
  actual_jobs_total: number;
  actual_utilization_avg_pct: number;
  actual_cash_delta: number;
  notes?: string;
}

export interface TwinLearnedAdjustment {
  id: string;
  user_id: string;
  lever_type: LeverType;
  adjustment_factor: number;
  sample_size: number;
  confidence: 'low' | 'medium' | 'high';
  updated_at: string;
}

// ============================================================
// LEVER METADATA
// ============================================================

export const LEVER_LABELS: Record<LeverType, string> = {
  hire_technicians: 'Hire technicians',
  price_change: 'Change prices',
  marketing_spend: 'Shift marketing spend',
  demand_shock: 'Demand shock (season, PR, competitor)',
  churn_change: 'Customer retention change',
  custom: 'Custom growth adjustment',
};

export const LEVER_VALUE_HINTS: Record<LeverType, string> = {
  hire_technicians: 'Number of technicians hired (e.g. 2)',
  price_change: '% price change (e.g. 8, or -5)',
  marketing_spend: 'Extra $/week spent on marketing (e.g. 500, or -300 to cut)',
  demand_shock: '% change in incoming demand (e.g. -15 for a slow season)',
  churn_change: '% change in customer retention (e.g. -10 for higher churn)',
  custom: '% weekly growth to apply directly to revenue and jobs',
};

/** Default effect-size assumptions, before any learning has happened. */
const DEFAULT_ASSUMPTIONS = {
  /** weeks for a newly hired technician to reach full productivity */
  hire_ramp_up_weeks: 3,
  /** one-time cost of hiring a technician (recruiting, onboarding, tools) */
  hire_one_time_cost: 2000,
  /** demand elasticity: a 1% price rise costs this % of job volume */
  price_elasticity_pct: 0.35,
  /** jobs gained per extra marketing dollar per week */
  marketing_jobs_per_dollar: 0.00006,
  /** operating margin applied to revenue to estimate cash impact */
  operating_margin_pct: 27,
  /** base weekly uncertainty band, widening with sqrt(week) */
  variance_base_pct: 7,
};

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function blankLever(type: LeverType = 'price_change'): TwinLever {
  return { id: newId('lvr'), type, value: 0, label: LEVER_LABELS[type] };
}

export function defaultBaseline(): TwinBaseline {
  return {
    weekly_revenue: 12000,
    weekly_jobs_completed: 20,
    technician_count: 4,
    technician_weekly_capacity_hours: 40,
    avg_job_hours: 3,
    weekly_marketing_spend: 800,
    cash_on_hand: 25000,
  };
}

// ============================================================
// THE SIMULATION
// ============================================================

export interface ProjectionResult {
  weekly: TwinWeekProjection[];
  summary: TwinSummary;
  narrative: string;
  assumptionsUsed: Record<string, number>;
}

/**
 * Project the business forward `horizonWeeks` under the given levers.
 * `adjustmentFactors` (lever_type -> multiplier, default 1.0) come from
 * what the twin has learned from past runs; pass {} to use raw defaults.
 */
export function computeProjection(
  baseline: TwinBaseline,
  levers: TwinLever[],
  horizonWeeks: number,
  adjustmentFactors: Partial<Record<LeverType, number>> = {}
): ProjectionResult {
  const factor = (t: LeverType) => adjustmentFactors[t] ?? 1.0;
  const avgJobValue = baseline.weekly_jobs_completed > 0
    ? baseline.weekly_revenue / baseline.weekly_jobs_completed
    : 0;
  const baseCapacityHours = baseline.technician_count * baseline.technician_weekly_capacity_hours;

  const hireLevers = levers.filter((l) => l.type === 'hire_technicians' && l.value !== 0);
  const priceLevers = levers.filter((l) => l.type === 'price_change' && l.value !== 0);
  const marketingLevers = levers.filter((l) => l.type === 'marketing_spend' && l.value !== 0);
  const demandLevers = levers.filter((l) => l.type === 'demand_shock' && l.value !== 0);
  const churnLevers = levers.filter((l) => l.type === 'churn_change' && l.value !== 0);
  const customLevers = levers.filter((l) => l.type === 'custom' && l.value !== 0);

  const priceMultiplier = priceLevers.reduce((m, l) => m * (1 + (l.value / 100)), 1);
  const priceDemandDropPct = priceLevers.reduce(
    (sum, l) => sum + l.value * DEFAULT_ASSUMPTIONS.price_elasticity_pct * factor('price_change'),
    0
  );
  const marketingExtraJobsPerWeek = marketingLevers.reduce(
    (sum, l) => sum + l.value * DEFAULT_ASSUMPTIONS.marketing_jobs_per_dollar * factor('marketing_spend'),
    0
  );
  const marketingExtraSpendPerWeek = marketingLevers.reduce((sum, l) => sum + l.value, 0);
  const demandShockPct = demandLevers.reduce((sum, l) => sum + l.value * factor('demand_shock'), 0);
  const churnRevenueDriftPctPerWeek = churnLevers.reduce(
    (sum, l) => sum + (l.value * 0.15 * factor('churn_change')) / 100,
    0
  );
  const customGrowthPctPerWeek = customLevers.reduce((sum, l) => sum + l.value * factor('custom'), 0) / 100;
  const totalHires = hireLevers.reduce((sum, l) => sum + l.value, 0);
  const rampWeeks = Math.max(1, DEFAULT_ASSUMPTIONS.hire_ramp_up_weeks * factor('hire_technicians'));
  const hiringOneTimeCost = totalHires * DEFAULT_ASSUMPTIONS.hire_one_time_cost;

  const weekly: TwinWeekProjection[] = [];
  let cashExpected = 0;
  let cashOptimistic = 0;
  let cashPessimistic = 0;

  for (let week = 1; week <= horizonWeeks; week++) {
    // Capacity added by hires, ramping in linearly over rampWeeks
    const hireRampFrac = totalHires > 0 ? Math.min(1, week / rampWeeks) : 0;
    const extraCapacityHours = totalHires * baseline.technician_weekly_capacity_hours * hireRampFrac;
    const capacityHours = baseCapacityHours + extraCapacityHours;
    const maxJobsFromCapacity = baseline.avg_job_hours > 0 ? capacityHours / baseline.avg_job_hours : Infinity;

    // Demand-side jobs before capacity constraint
    const demandMultiplier =
      (1 + demandShockPct / 100) *
      (1 + customGrowthPctPerWeek * week) *
      Math.max(0, 1 - priceDemandDropPct / 100);
    let jobsDemand = baseline.weekly_jobs_completed * demandMultiplier + marketingExtraJobsPerWeek * week;
    jobsDemand = Math.max(0, jobsDemand);

    const jobsExpected = Math.min(jobsDemand, maxJobsFromCapacity);
    const utilizationPct = capacityHours > 0
      ? Math.min(100, ((jobsExpected * baseline.avg_job_hours) / capacityHours) * 100)
      : 0;

    const revenueExpected =
      jobsExpected * avgJobValue * priceMultiplier * (1 - churnRevenueDriftPctPerWeek * week);

    const variancePct = DEFAULT_ASSUMPTIONS.variance_base_pct * Math.sqrt(week);
    const revenueOptimistic = revenueExpected * (1 + variancePct / 100);
    const revenuePessimistic = Math.max(0, revenueExpected * (1 - variancePct / 100));

    const marginPct = DEFAULT_ASSUMPTIONS.operating_margin_pct / 100;
    const oneTimeThisWeek = week === 1 ? hiringOneTimeCost : 0;
    const weeklyCashExpected = revenueExpected * marginPct - marketingExtraSpendPerWeek - oneTimeThisWeek;
    const weeklyCashOptimistic = revenueOptimistic * marginPct - marketingExtraSpendPerWeek - oneTimeThisWeek;
    const weeklyCashPessimistic = revenuePessimistic * marginPct - marketingExtraSpendPerWeek - oneTimeThisWeek;

    cashExpected += weeklyCashExpected;
    cashOptimistic += weeklyCashOptimistic;
    cashPessimistic += weeklyCashPessimistic;

    weekly.push({
      week_index: week,
      revenue_expected: revenueExpected,
      revenue_optimistic: revenueOptimistic,
      revenue_pessimistic: revenuePessimistic,
      jobs_expected: jobsExpected,
      utilization_pct_expected: utilizationPct,
      cash_cumulative_expected: cashExpected,
      cash_cumulative_optimistic: cashOptimistic,
      cash_cumulative_pessimistic: cashPessimistic,
    });
  }

  const summary: TwinSummary = {
    revenue_total_expected: weekly.reduce((s, w) => s + w.revenue_expected, 0),
    jobs_total_expected: weekly.reduce((s, w) => s + w.jobs_expected, 0),
    utilization_avg_expected: weekly.reduce((s, w) => s + w.utilization_pct_expected, 0) / (weekly.length || 1),
    cash_delta_expected: cashExpected,
    cash_delta_optimistic: cashOptimistic,
    cash_delta_pessimistic: cashPessimistic,
  };

  const narrative = buildNarrative(baseline, levers, summary, horizonWeeks);
  const assumptionsUsed: Record<string, number> = { ...DEFAULT_ASSUMPTIONS };
  (Object.keys(LEVER_LABELS) as LeverType[]).forEach((t) => {
    assumptionsUsed[`factor_${t}`] = factor(t);
  });

  return { weekly, summary, narrative, assumptionsUsed };
}

function buildNarrative(
  baseline: TwinBaseline,
  levers: TwinLever[],
  summary: TwinSummary,
  horizonWeeks: number
): string {
  if (levers.length === 0) {
    return `No levers applied — this projects the business continuing exactly as it runs today for ${horizonWeeks} weeks.`;
  }
  const parts = levers
    .filter((l) => l.value !== 0)
    .map((l) => `${LEVER_LABELS[l.type]} (${l.value > 0 ? '+' : ''}${l.value})`);
  const cashWord = summary.cash_delta_expected >= 0 ? 'add' : 'cost';
  return (
    `Over ${horizonWeeks} weeks, applying ${parts.join(', ')} is projected to ${cashWord} about ` +
    `$${Math.abs(Math.round(summary.cash_delta_expected)).toLocaleString('en-US')} in cash ` +
    `(range $${Math.round(summary.cash_delta_pessimistic).toLocaleString('en-US')} to ` +
    `$${Math.round(summary.cash_delta_optimistic).toLocaleString('en-US')}), averaging ` +
    `${summary.utilization_avg_expected.toFixed(0)}% technician utilization.`
  );
}

// ============================================================
// FORMAT
// ============================================================

export function formatDollars(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

export function formatPct(n: number): string {
  return `${n.toFixed(0)}%`;
}

// ============================================================
// CRUD — scenarios
// ============================================================

export async function fetchScenarios(): Promise<TwinScenario[]> {
  const { data, error } = await supabase
    .from('business_twin_scenarios')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as TwinScenario[]) ?? [];
}

export interface SaveScenarioInput {
  id?: string;
  name: string;
  description: string;
  horizon_weeks: number;
  baseline: TwinBaseline;
  levers: TwinLever[];
  status?: TwinScenario['status'];
}

export async function saveScenario(input: SaveScenarioInput): Promise<TwinScenario> {
  const payload = {
    name: input.name.trim(),
    description: input.description.trim() || null,
    horizon_weeks: input.horizon_weeks,
    baseline: input.baseline,
    levers: input.levers,
    status: input.status ?? 'draft',
  };
  if (input.id) {
    const { data, error } = await supabase
      .from('business_twin_scenarios')
      .update(payload)
      .eq('id', input.id)
      .select()
      .single();
    if (error) throw error;
    return data as TwinScenario;
  }
  const { data, error } = await supabase
    .from('business_twin_scenarios')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as TwinScenario;
}

export async function deleteScenario(id: string): Promise<void> {
  const { error } = await supabase.from('business_twin_scenarios').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// CRUD — runs
// ============================================================

export async function fetchRuns(scenarioId?: string): Promise<TwinRun[]> {
  let query = supabase.from('business_twin_runs').select('*').order('created_at', { ascending: false }).limit(100);
  if (scenarioId) query = query.eq('scenario_id', scenarioId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as TwinRun[]) ?? [];
}

export async function saveRun(
  scenarioId: string,
  horizonWeeks: number,
  baseline: TwinBaseline,
  levers: TwinLever[],
  result: ProjectionResult
): Promise<TwinRun> {
  const { data, error } = await supabase
    .from('business_twin_runs')
    .insert({
      scenario_id: scenarioId,
      horizon_weeks: horizonWeeks,
      baseline,
      levers,
      assumptions_used: result.assumptionsUsed,
      weekly_projection: result.weekly,
      summary: result.summary,
      narrative: result.narrative,
    })
    .select()
    .single();
  if (error) throw error;
  await supabase.from('business_twin_scenarios').update({ status: 'run' }).eq('id', scenarioId);
  return data as TwinRun;
}

export async function deleteRun(id: string): Promise<void> {
  const { error } = await supabase.from('business_twin_runs').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// THE LEARNING LOOP
// ============================================================

export async function fetchLearnedAdjustments(): Promise<TwinLearnedAdjustment[]> {
  const { data, error } = await supabase.from('business_twin_learned_adjustments').select('*');
  if (error) throw error;
  return (data as TwinLearnedAdjustment[]) ?? [];
}

export function adjustmentsToMap(rows: TwinLearnedAdjustment[]): Partial<Record<LeverType, number>> {
  const map: Partial<Record<LeverType, number>> = {};
  for (const r of rows) map[r.lever_type] = r.adjustment_factor;
  return map;
}

const LEARNING_RATE = 0.25;

/**
 * Close the loop on a run: record what actually happened, score how
 * accurate the projection was, and nudge the adjustment_factor for every
 * lever type that run used — closer to reality, bounded so one noisy
 * outcome can't swing the model wildly.
 */
export async function recordActualOutcome(run: TwinRun, actual: TwinActualOutcome): Promise<number> {
  const errRevenue = relativeError(actual.actual_revenue_total, run.summary.revenue_total_expected);
  const errJobs = relativeError(actual.actual_jobs_total, run.summary.jobs_total_expected);
  const errCash = relativeError(actual.actual_cash_delta, run.summary.cash_delta_expected);
  const accuracy = clamp(1 - (errRevenue + errJobs + errCash) / 3, 0, 1);

  const { error } = await supabase
    .from('business_twin_runs')
    .update({ actual_outcome: actual, accuracy_score: accuracy, compared_at: new Date().toISOString() })
    .eq('id', run.id);
  if (error) throw error;

  const leverTypesUsed = Array.from(new Set(run.levers.filter((l) => l.value !== 0).map((l) => l.type)));
  const jobsRatio = run.summary.jobs_total_expected !== 0
    ? actual.actual_jobs_total / run.summary.jobs_total_expected
    : 1;

  for (const leverType of leverTypesUsed) {
    await nudgeAdjustment(leverType, jobsRatio, run.id);
  }

  return accuracy;
}

async function nudgeAdjustment(leverType: LeverType, observedRatio: number, runId: string): Promise<void> {
  const { data: existing } = await supabase
    .from('business_twin_learned_adjustments')
    .select('*')
    .eq('lever_type', leverType)
    .maybeSingle();

  const prevFactor = existing?.adjustment_factor ?? 1.0;
  const prevSamples = existing?.sample_size ?? 0;
  // Move the factor toward what would have made the projection match
  // reality, but only by LEARNING_RATE of the way — and keep it sane.
  const target = clamp(prevFactor * observedRatio, 0.4, 1.8);
  const nextFactor = prevFactor + (target - prevFactor) * LEARNING_RATE;
  const nextSamples = prevSamples + 1;
  const confidence: TwinLearnedAdjustment['confidence'] =
    nextSamples >= 8 ? 'high' : nextSamples >= 3 ? 'medium' : 'low';

  const { error } = await supabase.from('business_twin_learned_adjustments').upsert(
    {
      lever_type: leverType,
      adjustment_factor: nextFactor,
      sample_size: nextSamples,
      confidence,
      last_run_id: runId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,lever_type' }
  );
  if (error) throw error;
}

function relativeError(actual: number, expected: number): number {
  const denom = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return clamp(Math.abs(actual - expected) / denom, 0, 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
