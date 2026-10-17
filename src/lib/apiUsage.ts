/**
 * API Usage monitoring — pure domain logic (no I/O, fully unit-tested).
 * Definitions match the SQL in 20270502000000_api_usage_monitoring.sql:
 *   error = status >= 400 excluding 429; error rate = errors / requests; latency excludes rate-limited requests.
 */

export const RANGES = [
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
] as const;
export type RangeHours = (typeof RANGES)[number]['hours'];

export interface UsageSummaryRow {
  key_id: string;
  requests: number;
  ok: number;
  client_errors: number;
  server_errors: number;
  rate_limited: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_request_at: string | null;
}

export interface UsagePoint {
  bucket: string;
  requests: number;
  errors: number;
  rate_limited: number;
  p95_ms: number | null;
}

export type AlertKind = 'error_rate' | 'latency' | 'rate_limit';

export interface Breach {
  key_id: string;
  kind: AlertKind;
  value: number;
  threshold: number;
  requests: number;
  window_minutes: number;
}

export interface AlertEvent {
  id: string;
  key_id: string;
  kind: AlertKind;
  value: number;
  threshold: number;
  window_minutes: number;
  created_at: string;
}

export interface AlertRules {
  enabled: boolean;
  window_minutes: number;
  min_requests: number;
  error_rate_pct: number;
  p95_latency_ms: number;
  rate_limit_hits: number;
  notify_in_app: boolean;
}

export const DEFAULT_RULES: AlertRules = {
  enabled: true,
  window_minutes: 60,
  min_requests: 20,
  error_rate_pct: 10,
  p95_latency_ms: 2000,
  rate_limit_hits: 10,
  notify_in_app: true,
};

export const RATE_LIMIT_PER_MINUTE = 120;

/* ----------------------------- coercion ----------------------------- */

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

/** Postgres bigint/numeric can arrive as strings — coerce once at the boundary. */
export function toSummaryRow(r: Record<string, unknown>): UsageSummaryRow {
  return {
    key_id: String(r.key_id),
    requests: num(r.requests),
    ok: num(r.ok),
    client_errors: num(r.client_errors),
    server_errors: num(r.server_errors),
    rate_limited: num(r.rate_limited),
    p50_ms: numOrNull(r.p50_ms),
    p95_ms: numOrNull(r.p95_ms),
    last_request_at: (r.last_request_at as string | null) ?? null,
  };
}

export function toPoint(r: Record<string, unknown>): UsagePoint {
  return { bucket: String(r.bucket), requests: num(r.requests), errors: num(r.errors), rate_limited: num(r.rate_limited), p95_ms: numOrNull(r.p95_ms) };
}

export function toBreach(r: Record<string, unknown>): Breach {
  return { key_id: String(r.key_id), kind: r.kind as AlertKind, value: num(r.value), threshold: num(r.threshold), requests: num(r.requests), window_minutes: num(r.window_minutes) };
}

export function toEvent(r: Record<string, unknown>): AlertEvent {
  return { id: String(r.id), key_id: String(r.key_id), kind: r.kind as AlertKind, value: num(r.value), threshold: num(r.threshold), window_minutes: num(r.window_minutes), created_at: String(r.created_at) };
}

export function toRules(r: Record<string, unknown> | null): AlertRules {
  if (!r) return { ...DEFAULT_RULES };
  return {
    enabled: r.enabled !== false,
    window_minutes: num(r.window_minutes) || DEFAULT_RULES.window_minutes,
    min_requests: num(r.min_requests) || DEFAULT_RULES.min_requests,
    error_rate_pct: num(r.error_rate_pct) || DEFAULT_RULES.error_rate_pct,
    p95_latency_ms: num(r.p95_latency_ms) || DEFAULT_RULES.p95_latency_ms,
    rate_limit_hits: num(r.rate_limit_hits) || DEFAULT_RULES.rate_limit_hits,
    notify_in_app: r.notify_in_app !== false,
  };
}

/* ----------------------------- metrics ------------------------------ */

export const errorCount = (r: Pick<UsageSummaryRow, 'client_errors' | 'server_errors'>): number => r.client_errors + r.server_errors;

/** Fraction 0..1, or null when there is no traffic. */
export function errorRate(r: Pick<UsageSummaryRow, 'requests' | 'client_errors' | 'server_errors'>): number | null {
  return r.requests > 0 ? errorCount(r) / r.requests : null;
}

export interface Totals {
  requests: number;
  errors: number;
  rateLimited: number;
  errorRate: number | null;
  /** Worst p95 across keys — a conservative proxy, since per-request data is not shipped to the browser. */
  worstP95: number | null;
}

export function totals(rows: UsageSummaryRow[]): Totals {
  const requests = rows.reduce((s, r) => s + r.requests, 0);
  const errors = rows.reduce((s, r) => s + errorCount(r), 0);
  const p95s = rows.map((r) => r.p95_ms).filter((v): v is number => v !== null);
  return {
    requests,
    errors,
    rateLimited: rows.reduce((s, r) => s + r.rate_limited, 0),
    errorRate: requests > 0 ? errors / requests : null,
    worstP95: p95s.length ? Math.max(...p95s) : null,
  };
}

export type KeyHealth = 'idle' | 'healthy' | 'warning' | 'critical';

/** Health reflects the live breaches (same rules as alerts) so the table and the alert banner never disagree. */
export function keyHealth(row: UsageSummaryRow | undefined, breaches: Breach[]): KeyHealth {
  if (!row || row.requests === 0) return 'idle';
  const mine = breaches.filter((b) => b.key_id === row.key_id);
  if (mine.some((b) => b.kind === 'error_rate' && b.value >= b.threshold * 2)) return 'critical';
  if (mine.length > 0) return 'warning';
  return 'healthy';
}

/* ---------------------------- formatting ---------------------------- */

export const formatCount = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));
export const formatPct = (f: number | null): string => (f === null ? '—' : f === 0 ? '0%' : f < 0.001 ? '<0.1%' : `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`);
export const formatMs = (ms: number | null): string => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export function formatBucket(iso: string, hours: number): string {
  const d = new Date(iso);
  return hours <= 24
    ? d.toLocaleTimeString([], { hour: 'numeric' })
    : hours <= 168
      ? d.toLocaleDateString([], { weekday: 'short', hour: 'numeric' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function alertTitle(kind: AlertKind): string {
  return kind === 'error_rate' ? 'High error rate' : kind === 'latency' ? 'High latency' : 'Rate limit reached';
}

export function alertDetail(a: Pick<Breach, 'kind' | 'value' | 'threshold' | 'window_minutes'>): string {
  const win = a.window_minutes >= 60 && a.window_minutes % 60 === 0 ? `${a.window_minutes / 60} h` : `${a.window_minutes} min`;
  if (a.kind === 'error_rate') return `${a.value}% of requests failed in the last ${win} (threshold ${a.threshold}%).`;
  if (a.kind === 'latency') return `p95 latency ${formatMs(a.value)} in the last ${win} (threshold ${formatMs(a.threshold)}).`;
  return `${a.value} requests were rate limited in the last ${win} (threshold ${a.threshold}).`;
}

/* ------------------------------ chart ------------------------------- */

export interface Bar {
  x: number;
  width: number;
  okH: number;
  errH: number;
  rlH: number;
}

/** Geometry for a stacked bar chart (ok / errors / rate-limited), heights in 0..height. */
export function buildBars(points: UsagePoint[], width: number, height: number, gap = 2): { bars: Bar[]; max: number } {
  const max = Math.max(1, ...points.map((p) => p.requests));
  const n = Math.max(points.length, 1);
  const bw = Math.max(1, (width - gap * (n - 1)) / n);
  const bars = points.map((p, i) => {
    const total = (p.requests / max) * height;
    const share = (v: number) => (p.requests > 0 ? (v / p.requests) * total : 0);
    const errH = share(p.errors);
    const rlH = share(p.rate_limited);
    return { x: i * (bw + gap), width: bw, okH: Math.max(0, total - errH - rlH), errH, rlH };
  });
  return { bars, max };
}

/* ---------------------------- validation ---------------------------- */

export type RuleErrors = Partial<Record<keyof Omit<AlertRules, 'enabled' | 'notify_in_app'>, string>>;

const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

export function validateRules(r: AlertRules): RuleErrors {
  const e: RuleErrors = {};
  if (!inRange(r.window_minutes, 15, 1440) || !Number.isInteger(r.window_minutes)) e.window_minutes = 'Whole minutes, 15 to 1440.';
  if (!inRange(r.min_requests, 1, 100_000) || !Number.isInteger(r.min_requests)) e.min_requests = 'Whole number, 1 to 100,000.';
  if (!inRange(r.error_rate_pct, 1, 100)) e.error_rate_pct = 'Between 1 and 100.';
  if (!inRange(r.p95_latency_ms, 100, 60_000) || !Number.isInteger(r.p95_latency_ms)) e.p95_latency_ms = 'Whole ms, 100 to 60,000.';
  if (!inRange(r.rate_limit_hits, 1, 100_000) || !Number.isInteger(r.rate_limit_hits)) e.rate_limit_hits = 'Whole number, 1 to 100,000.';
  return e;
}

export const rulesEqual = (a: AlertRules, b: AlertRules): boolean => JSON.stringify(a) === JSON.stringify(b);

export function friendlyUsageError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = err instanceof Error ? err.message : typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : '';
  if (msg.includes('API_USAGE_FORBIDDEN') || /row-level security/i.test(msg)) return 'Only the account owner can view or change API usage.';
  return fallback;
}
