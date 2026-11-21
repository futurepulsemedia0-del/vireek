/**
 * Dispute-ratio monitoring — pure domain helpers (no I/O).
 * Data comes from dispute_ratio_monthly_v / dispute_ratio_platform_monthly() (migration 20290306000100).
 * Thresholds are internal early-warning placeholders, not provider or card-network limits.
 * [VERIFY against payment provider docs]
 */

export type RatioLevel = 'insufficient_data' | 'ok' | 'warning' | 'critical';

export interface TenantMonthRow {
  user_id: string;
  month: string; // 'YYYY-MM-DD' (first day of the UTC month)
  disputes_count: number;
  txn_count: number;
  ratio_pct: number | null;
  level: RatioLevel;
  warning_pct: number;
  critical_pct: number;
  min_transactions: number;
}

export interface PlatformMonthRow {
  month: string;
  disputes_count: number;
  txn_count: number;
  ratio_pct: number | null;
  level: RatioLevel;
  tenants_with_disputes: number;
  tenants_warning: number;
  tenants_critical: number;
  warning_pct: number;
  critical_pct: number;
  thresholds_verified: boolean;
  min_transactions: number;
}

/** Must stay identical to public.dispute_ratio_level() in SQL (covered by tests on both sides). */
export function classifyRatio(disputes: number, transactions: number, warningPct: number, criticalPct: number, minTransactions: number): RatioLevel {
  if (!Number.isFinite(transactions) || transactions < Math.max(minTransactions, 1)) return 'insufficient_data';
  const pct = (100 * Math.max(disputes, 0)) / transactions;
  if (pct >= criticalPct) return 'critical';
  if (pct >= warningPct) return 'warning';
  return 'ok';
}

export function formatRatio(pct: number | null | undefined, locale?: string): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(pct)}%`;
}

/** 'YYYY-MM-01' → localized "Nov 2026". Parses by hand so the browser time zone never shifts the month. */
export function formatMonth(month: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

const SEVERITY: Record<RatioLevel, number> = { insufficient_data: 0, ok: 1, warning: 2, critical: 3 };

export function worstLevel(levels: readonly RatioLevel[]): RatioLevel {
  return levels.reduce<RatioLevel>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'insufficient_data');
}

export function levelTone(level: RatioLevel): 'success' | 'warning' | 'danger' | 'neutral' {
  return level === 'ok' ? 'success' : level === 'warning' ? 'warning' : level === 'critical' ? 'danger' : 'neutral';
}

/** Latest `n` months, newest first. Input order does not matter. */
export function latestMonths<T extends { month: string }>(rows: readonly T[], n: number): T[] {
  return [...rows].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)).slice(0, Math.max(0, n));
}

/** Direction of the last two months with enough data: 'up' | 'down' | 'flat' | null. */
export function trend(rows: readonly TenantMonthRow[]): 'up' | 'down' | 'flat' | null {
  const usable = latestMonths(rows, 6).filter((r) => r.ratio_pct !== null && r.level !== 'insufficient_data');
  if (usable.length < 2) return null;
  const [cur, prev] = usable;
  const delta = (cur.ratio_pct as number) - (prev.ratio_pct as number);
  if (Math.abs(delta) < 0.005) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

export function validateThresholds(input: { warning: string; critical: string; minTransactions: string }): {
  error: 'invalidNumber' | 'order' | 'range' | 'minTransactions' | null;
  value: { warning: number; critical: number; minTransactions: number } | null;
} {
  const num = (s: string) => (/^\d{1,3}(\.\d{1,3})?$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const warning = num(input.warning);
  const critical = num(input.critical);
  if (Number.isNaN(warning) || Number.isNaN(critical)) return { error: 'invalidNumber', value: null };
  if (warning > 100 || critical > 100) return { error: 'range', value: null };
  if (critical < warning) return { error: 'order', value: null };
  if (!/^\d{1,7}$/.test(input.minTransactions.trim())) return { error: 'minTransactions', value: null };
  const minTransactions = Number(input.minTransactions.trim());
  if (minTransactions < 1 || minTransactions > 1_000_000) return { error: 'minTransactions', value: null };
  return { error: null, value: { warning, critical, minTransactions } };
}
