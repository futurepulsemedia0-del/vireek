import { supabase } from '@/lib/supabase';

/**
 * Per-key request logs written by the `api-v1` edge function into
 * `api_request_logs`. Read access is enforced by RLS (account owner only);
 * there is no client-side write path.
 */

export const LOG_PAGE_SIZE = 50;

export type LogFilter = 'all' | 'success' | 'client_error' | 'server_error';

export const LOG_FILTERS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'success', label: '2xx' },
  { id: 'client_error', label: '4xx' },
  { id: 'server_error', label: '5xx' },
];

export interface ApiRequestLogRow {
  id: string;
  api_key_id: string;
  method: string;
  path: string;
  resource: string | null;
  status: number;
  latency_ms: number;
  error: string | null;
  user_agent: string | null;
  created_at: string;
}

/** Inclusive-min / exclusive-max HTTP status range for a filter, or null for "all". */
export function statusRangeFor(filter: LogFilter): { min: number; max: number } | null {
  switch (filter) {
    case 'success':
      return { min: 200, max: 400 };
    case 'client_error':
      return { min: 400, max: 500 };
    case 'server_error':
      return { min: 500, max: 600 };
    default:
      return null;
  }
}

export async function fetchApiRequestLogs(opts: {
  keyId: string;
  filter: LogFilter;
  /** Raw `created_at` string of the last row already loaded (keyset cursor). */
  before?: string;
}): Promise<ApiRequestLogRow[]> {
  let query = supabase
    .from('api_request_logs')
    .select('id, api_key_id, method, path, resource, status, latency_ms, error, user_agent, created_at')
    .eq('api_key_id', opts.keyId)
    .order('created_at', { ascending: false })
    .limit(LOG_PAGE_SIZE);

  const range = statusRangeFor(opts.filter);
  if (range) query = query.gte('status', range.min).lt('status', range.max);
  if (opts.before) query = query.lt('created_at', opts.before);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ApiRequestLogRow[];
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1];
}

export interface LogSummary {
  total: number;
  errors: number;
  /** 0–100, null when there are no rows. */
  successRate: number | null;
  p50: number | null;
  p95: number | null;
}

export function summarizeLogs(rows: Pick<ApiRequestLogRow, 'status' | 'latency_ms'>[]): LogSummary {
  if (rows.length === 0) return { total: 0, errors: 0, successRate: null, p50: null, p95: null };
  const errors = rows.filter((r) => r.status >= 400).length;
  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  return {
    total: rows.length,
    errors,
    successRate: Math.round(((rows.length - errors) / rows.length) * 1000) / 10,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
  };
}

export type StatusTone = 'success' | 'warning' | 'danger';

export function statusTone(status: number): StatusTone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  return 'success';
}

export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
