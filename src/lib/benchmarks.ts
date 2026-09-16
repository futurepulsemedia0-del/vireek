import { supabase } from '@/lib/supabase';

export type MetricKey =
  | 'lead_conversion_rate'
  | 'avg_invoice_amount'
  | 'avg_call_duration_seconds'
  | 'emergency_call_rate'
  | 'job_completion_rate'
  | 'avg_payment_collection_hours';

export interface BenchmarkSnapshot {
  metric_key: MetricKey;
  segment: string;
  sample_size: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
  average: number | null;
  period_end: string | null;
}

export const METRIC_META: Record<MetricKey, { label: string; unit: 'percent' | 'currency' | 'seconds' | 'hours'; higherIsBetter: boolean }> = {
  lead_conversion_rate: { label: 'Lead-to-Job Conversion', unit: 'percent', higherIsBetter: true },
  avg_invoice_amount: { label: 'Average Invoice', unit: 'currency', higherIsBetter: true },
  avg_call_duration_seconds: { label: 'Average Call Length', unit: 'seconds', higherIsBetter: false },
  emergency_call_rate: { label: 'Emergency Call Rate', unit: 'percent', higherIsBetter: false },
  job_completion_rate: { label: 'Job Completion Rate', unit: 'percent', higherIsBetter: true },
  avg_payment_collection_hours: { label: 'Time to Get Paid', unit: 'hours', higherIsBetter: false },
};

const METRIC_ORDER: MetricKey[] = [
  'lead_conversion_rate',
  'job_completion_rate',
  'avg_invoice_amount',
  'avg_payment_collection_hours',
  'avg_call_duration_seconds',
  'emergency_call_rate',
];
export { METRIC_ORDER };

export async function fetchBenchmarks(): Promise<BenchmarkSnapshot[]> {
  const { data, error } = await supabase.from('benchmark_snapshots').select('*').eq('segment', 'all');
  if (error) throw error;
  return (data ?? []) as BenchmarkSnapshot[];
}

export async function computeMyMetrics(): Promise<Partial<Record<MetricKey, number>>> {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const result: Partial<Record<MetricKey, number>> = {};

  const { count: leadCount } = await supabase.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', since);
  const { data: convertedLeads } = await supabase.from('leads').select('id, jobs!inner(id)').gte('created_at', since);
  if (leadCount) result.lead_conversion_rate = (convertedLeads?.length ?? 0) / leadCount;

  const { data: invoicedJobs } = await supabase.from('jobs').select('invoice_amount').not('invoice_amount', 'is', null).gte('created_at', since);
  if (invoicedJobs?.length) result.avg_invoice_amount = invoicedJobs.reduce((s, j) => s + Number(j.invoice_amount), 0) / invoicedJobs.length;

  const { data: durations } = await supabase.from('calls').select('duration_seconds').not('duration_seconds', 'is', null).gte('call_datetime', since);
  if (durations?.length) result.avg_call_duration_seconds = durations.reduce((s, c) => s + Number(c.duration_seconds), 0) / durations.length;

  const { data: calls } = await supabase.from('calls').select('is_emergency').gte('call_datetime', since);
  if (calls?.length) result.emergency_call_rate = calls.filter((c) => c.is_emergency).length / calls.length;

  const { data: jobs } = await supabase.from('jobs').select('job_status').gte('created_at', since);
  if (jobs?.length) result.job_completion_rate = jobs.filter((j) => j.job_status === 'completed').length / jobs.length;

  const { data: paidRequests } = await supabase.from('payment_requests').select('created_at, paid_at').not('paid_at', 'is', null).gte('created_at', since);
  if (paidRequests?.length) {
    const hours = paidRequests.map((r) => (new Date(r.paid_at as string).getTime() - new Date(r.created_at).getTime()) / 3600000);
    result.avg_payment_collection_hours = hours.reduce((s, h) => s + h, 0) / hours.length;
  }

  return result;
}

export function formatMetricValue(key: MetricKey, value: number): string {
  const meta = METRIC_META[key];
  if (meta.unit === 'percent') return `${(value * 100).toFixed(0)}%`;
  if (meta.unit === 'currency') return `$${value.toFixed(0)}`;
  if (meta.unit === 'hours') return `${value.toFixed(1)}h`;
  return value >= 60 ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s` : `${Math.round(value)}s`;
}

// Where "my value" sits on a 0-100 scale between p25/median/p75, for the position bar.
export function percentilePosition(myValue: number, p25: number, median: number, p75: number): number {
  if (myValue <= p25) return 12.5;
  if (myValue <= median) return 12.5 + ((myValue - p25) / (median - p25 || 1)) * 37.5;
  if (myValue <= p75) return 50 + ((myValue - median) / (p75 - median || 1)) * 37.5;
  return 87.5;
}

export function metricTier(key: MetricKey, myValue: number, snapshot: BenchmarkSnapshot): 'top' | 'above' | 'below' | 'bottom' {
  const { p25, median, p75 } = snapshot;
  const higherIsBetter = METRIC_META[key].higherIsBetter;
  if (p25 == null || median == null || p75 == null) return 'above';
  const better = higherIsBetter ? myValue >= p75 : myValue <= p25;
  const worse = higherIsBetter ? myValue <= p25 : myValue >= p75;
  if (better) return 'top';
  if (worse) return 'bottom';
  return higherIsBetter ? (myValue >= median ? 'above' : 'below') : (myValue <= median ? 'above' : 'below');
}
