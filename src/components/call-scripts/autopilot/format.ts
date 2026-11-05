import { METRICS, type MetricId } from '@/lib/voiceAutopilot';

/** Rates are fractions; show them as percentage points. Seconds and sentiment keep their own units. */
export function formatEffect(metric: MetricId, v: number | null, signed = true): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const sign = signed && v > 0 ? '+' : '';
  if (METRICS[metric].kind === 'binary') return `${sign}${(v * 100).toFixed(1)}`;
  return `${sign}${v.toFixed(metric === 'customer_sentiment' ? 2 : 0)}`;
}

export function formatRate(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

export function unitOf(metric: MetricId): 'points' | 'seconds' | 'score' | 'ms' {
  if (metric === 'time_to_book_seconds') return 'seconds';
  if (metric === 'customer_sentiment') return 'score';
  if (metric === 'latency_ms') return 'ms';
  return 'points';
}
