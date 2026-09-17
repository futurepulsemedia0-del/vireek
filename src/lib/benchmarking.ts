/**
 * Cross-Tenant Anonymous Benchmarking — client library.
 *
 * Everything here reads through a single RPC,
 * `get_benchmark_comparison()`, defined in
 * supabase/migrations/20260923000000_cross_tenant_benchmarking.sql. There
 * is no other cross-tenant read path in this file or anywhere in the
 * client — see that migration's header comment for the full privacy
 * design (k-anonymity floor, no client-parameterized cross-tenant
 * queries, aggregated-twice construction).
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type BenchmarkMetric =
  | 'lead_conversion_rate'
  | 'quote_acceptance_rate'
  | 'missed_call_rate'
  | 'avg_call_score'
  | 'avg_lead_response_hours'
  | 'avg_ticket_cents';

export type MetricUnit = 'percent' | 'score' | 'hours' | 'cents';
export type MetricDirection = 'higher_is_better' | 'lower_is_better';
export type BenchmarkScope = 'industry' | 'all' | 'none';
export type PercentileBucket = 'top10' | 'top25' | 'top50' | 'bottom50' | 'bottom25';

export interface BenchmarkRow {
  metric: BenchmarkMetric;
  unit: MetricUnit;
  direction: MetricDirection;
  my_value: number;
  scope: BenchmarkScope;
  industry: string;
  contributor_count: number | null;
  cohort_avg: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  percentile_bucket: PercentileBucket | null;
}

// ============================================================
// LABELS
// ============================================================

export const METRIC_LABELS: Record<BenchmarkMetric, string> = {
  lead_conversion_rate: 'Lead conversion rate',
  quote_acceptance_rate: 'Quote acceptance rate',
  missed_call_rate: 'Missed-call rate',
  avg_call_score: 'AI call quality score',
  avg_lead_response_hours: 'Time from lead to quote',
  avg_ticket_cents: 'Average paid ticket',
};

export const METRIC_DESCRIPTIONS: Record<BenchmarkMetric, string> = {
  lead_conversion_rate: 'Share of new leads that turned into a won job.',
  quote_acceptance_rate: 'Share of sent quotes the customer accepted.',
  missed_call_rate: 'Share of calls that went unanswered or to voicemail.',
  avg_call_score: "Vireek's AI rating of how well calls were handled, 0–100.",
  avg_lead_response_hours: 'How long it took, on average, to get a quote to a new lead.',
  avg_ticket_cents: 'Average amount collected per paid job.',
};

export const BUCKET_LABELS: Record<PercentileBucket, string> = {
  top10: 'Top 10%',
  top25: 'Top 25%',
  top50: 'Above average',
  bottom50: 'Below average',
  bottom25: 'Bottom 25%',
};

export const BUCKET_COLORS: Record<PercentileBucket, string> = {
  top10: 'bg-success-500/15 text-success-500',
  top25: 'bg-success-500/10 text-success-500',
  top50: 'bg-accent/10 text-accent',
  bottom50: 'bg-warning-500/10 text-warning-500',
  bottom25: 'bg-danger/10 text-danger',
};

// ============================================================
// FORMATTING
// ============================================================

export function formatMetricValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'percent':
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case 'score':
      return value.toFixed(0);
    case 'hours':
      return value < 1 ? `${Math.round(value * 60)} min` : `${value.toFixed(1)} hrs`;
    case 'cents':
      return `$${Math.round(value / 100).toLocaleString('en-US')}`;
    default:
      return String(value);
  }
}

/** Distance from the cohort average, phrased the way a business owner would say it. */
export function describeGap(row: BenchmarkRow): string | null {
  if (row.cohort_avg === null) return null;
  const diff = row.my_value - row.cohort_avg;
  if (Math.abs(diff) < 0.05 * Math.max(1, Math.abs(row.cohort_avg))) return "right at the average";

  const better = row.direction === 'higher_is_better' ? diff > 0 : diff < 0;
  const magnitude = formatMetricValue(Math.abs(diff), row.unit);
  return `${magnitude} ${better ? 'better' : 'behind'} the average`;
}

export function scopeLabel(row: BenchmarkRow): string {
  if (row.scope === 'industry') {
    return `${row.contributor_count ?? 0}+ similar businesses in your trade`;
  }
  if (row.scope === 'all') {
    return `${row.contributor_count ?? 0}+ businesses across all trades`;
  }
  return 'Not enough data on the platform yet';
}

// ============================================================
// FETCH
// ============================================================

export interface BenchmarkResult {
  rows: BenchmarkRow[];
  fetchedAt: string;
}

export async function fetchBenchmarkComparison(userId: string, periodDays = 30): Promise<BenchmarkResult> {
  const { data, error } = await supabase.rpc('get_benchmark_comparison', {
    p_user_id: userId,
    p_period_days: periodDays,
  });
  if (error) throw error;

  return {
    rows: (data as BenchmarkRow[]) ?? [],
    fetchedAt: new Date().toISOString(),
  };
}

/** Simple headline: how many metrics land at top-50 or better. */
export function summarizeStanding(rows: BenchmarkRow[]): { strong: number; total: number } {
  const withScope = rows.filter((r) => r.scope !== 'none');
  const strong = withScope.filter((r) => r.percentile_bucket === 'top10' || r.percentile_bucket === 'top25' || r.percentile_bucket === 'top50');
  return { strong: strong.length, total: withScope.length };
}
