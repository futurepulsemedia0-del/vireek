/**
 * Verified Resolution Network - client API + pure helpers (public /network page).
 * Reads ONLY through the SECURITY DEFINER vrn_public_summary() RPC. k-anonymity is enforced
 * in the database; this module never fabricates or estimates a missing value.
 */

import { supabase } from '@/lib/supabase';

export type VrnMetric = 'first_time_fix_rate' | 'reservice_rate' | 'median_response_minutes';
export const VRN_METRICS: readonly VrnMetric[] = ['first_time_fix_rate', 'reservice_rate', 'median_response_minutes'];
export type VrnWindow = 30 | 90;
export const STALE_AFTER_HOURS = 72;

export interface VrnRow {
  metric: VrnMetric;
  unit: 'percent' | 'minutes';
  direction: 'higher_is_better' | 'lower_is_better';
  windowDays: VrnWindow;
  scope: 'platform' | 'industry';
  industry: string | null;
  contributors: number;
  p25: number;
  p50: number;
  p75: number;
  computedAt: string | null;
}
export interface VrnSummary { kThreshold: number; rows: VrnRow[]; latestComputedAt: string | null }

export const METRIC_LABELS: Record<VrnMetric, { title: string; hint: string }> = {
  first_time_fix_rate: { title: 'First-time fix rate', hint: 'Completed jobs with no rework within 14 days. Higher is better.' },
  reservice_rate: { title: 'Reservice rate', hint: 'Share of jobs that were rework. Lower is better.' },
  median_response_minutes: { title: 'Median response time', hint: 'Minutes from job creation to first response. Lower is better.' },
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Defensive parse: anything malformed or below k is dropped, never repaired. */
export function parseSummary(raw: unknown): VrnSummary {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const k = num(o.k_threshold) ?? 10;
  const list = Array.isArray(o.rows) ? o.rows : [];
  const rows: VrnRow[] = [];
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const metric = r.metric as VrnMetric;
    const windowDays = num(r.window_days);
    const contributors = num(r.contributors);
    const p25 = num(r.p25), p50 = num(r.p50), p75 = num(r.p75);
    if (!VRN_METRICS.includes(metric)) continue;
    if (windowDays !== 30 && windowDays !== 90) continue;
    if (contributors === null || contributors < k) continue;
    if (p25 === null || p50 === null || p75 === null) continue;
    if (r.scope !== 'platform' && r.scope !== 'industry') continue;
    rows.push({
      metric, windowDays, contributors, p25, p50, p75,
      unit: r.unit === 'minutes' ? 'minutes' : 'percent',
      direction: r.direction === 'lower_is_better' ? 'lower_is_better' : 'higher_is_better',
      scope: r.scope, industry: typeof r.industry === 'string' ? r.industry : null,
      computedAt: typeof r.computed_at === 'string' ? r.computed_at : null,
    });
  }
  return { kThreshold: k, rows, latestComputedAt: typeof o.latest_computed_at === 'string' ? o.latest_computed_at : null };
}

export type CellState = { state: 'ok'; row: VrnRow; stale: boolean } | { state: 'insufficient' };

export function isStale(computedAt: string | null, now: number = Date.now()): boolean {
  if (!computedAt) return true;
  const t = Date.parse(computedAt);
  return !Number.isFinite(t) || now - t > STALE_AFTER_HOURS * 3_600_000;
}

/** Platform cell for a metric+window: real row or an explicit "insufficient" state. */
export function platformCell(summary: VrnSummary, metric: VrnMetric, windowDays: VrnWindow, now: number = Date.now()): CellState {
  const row = summary.rows.find((r) => r.scope === 'platform' && r.metric === metric && r.windowDays === windowDays);
  return row ? { state: 'ok', row, stale: isStale(row.computedAt, now) } : { state: 'insufficient' };
}

export function industries(summary: VrnSummary, windowDays: VrnWindow): string[] {
  return [...new Set(summary.rows.filter((r) => r.scope === 'industry' && r.windowDays === windowDays).map((r) => r.industry ?? ''))]
    .filter(Boolean).sort();
}

export function industryRows(summary: VrnSummary, industry: string, windowDays: VrnWindow): VrnRow[] {
  return summary.rows.filter((r) => r.scope === 'industry' && r.industry === industry && r.windowDays === windowDays);
}

export function formatValue(v: number, unit: 'percent' | 'minutes'): string {
  const rounded = Math.round(v * 10) / 10;
  return unit === 'percent' ? `${rounded}%` : `${rounded} min`;
}

export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchNetworkSummary(): Promise<VrnSummary> {
  const { data, error } = await supabase.rpc('vrn_public_summary');
  if (error) throw new Error('network_unavailable');
  return parseSummary(data);
}
