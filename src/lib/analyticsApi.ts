// Client for the analytics edge functions. Types mirror the pure engines (single source of truth).
import { supabase } from '@/lib/supabase';
import type { ArAging, CustomerMetricDef, KpiValues, MetricId, SeriesPoint } from '../../supabase/functions/_shared/analytics/customerKpis';
import type { CohortRow, RetentionResult, ActivationResult, AttachRow, CacResult } from '../../supabase/functions/_shared/analytics/founderKpis';

export class AnalyticsError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function call<T>(fn: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let payload: { error?: string; code?: string } | null = null;
    try { payload = await (error as { context?: Response }).context?.json(); } catch { /* not JSON */ }
    throw new AnalyticsError(payload?.error || 'Something went wrong. Please try again.', payload?.code);
  }
  return data as T;
}

export interface AnalyticsSettings { hoursPerDay: number; digestEnabled: boolean; digestCadence: 'weekly' | 'monthly'; alertsEnabled: boolean }
export interface AnalyticsAlert {
  id: string; metric: MetricId; severity: 'warning' | 'critical'; direction: 'up' | 'down'; bad: boolean;
  period_start: string; period_end: string; value: number; baseline_mean: number; z: number | null; acknowledged_at: string | null;
}
export interface AnalyticsOverview {
  range: { from: string; to: string; previousFrom: string; previousTo: string };
  kpis: KpiValues; previous: KpiValues; series: SeriesPoint[]; ar: ArAging; alerts: AnalyticsAlert[]; settings: AnalyticsSettings;
  technicians: { id: string; name: string }[]; definitions: Record<MetricId, CustomerMetricDef>; truncated: boolean; isOwner: boolean; generated_at: string;
}
export interface OverviewQuery { from: string; to: string; granularity: 'day' | 'week' | 'month'; teamIds: string[] }

export const fetchOverview = (q: OverviewQuery) => call<AnalyticsOverview>('analytics-query', { action: 'get', ...q });
export const fetchCsv = (q: OverviewQuery) => call<{ filename: string; csv: string }>('analytics-query', { action: 'csv', ...q });
export const saveSettings = (s: Partial<AnalyticsSettings>) => call<{ settings: AnalyticsSettings }>('analytics-query', { action: 'settings', ...s });
export const ackAlert = (alertId: string) => call<{ ok: true }>('analytics-query', { action: 'ack', alertId });
export const trackEvent = (name: string, props: Record<string, string | number | boolean> = {}) =>
  void call('analytics-query', { action: 'event', name, props }).catch(() => undefined); // telemetry must never break the page

// ---- staff (Part B)
export interface FounderInput { month: string; spend_cents: number; gross_margin_bp: number; platform_fee_cents: number; note: string | null; updated_at: string }
export interface FounderOverview {
  month: string; retention: RetentionResult; cohorts: CohortRow[];
  trend: { month: string; grrBp: number | null; nrrBp: number | null; closingMrrCents: number; newMrrCents: number; churnedCents: number }[];
  activation: ActivationResult & { windowDays: number }; attach: AttachRow[]; payingAccounts: number;
  takeRate: { takeRateBp: number | null; grossPaymentVolumeCents: number; platformFeeCents: number | null };
  cac: CacResult | null; inputs: FounderInput[]; input: FounderInput | null;
  dataHealth: { billing_subscription_events: number; ledger_rows: number; created_events: number; updated_events: number; deleted_events: number; oldest_event_at: string | null; newest_event_at: string | null };
  ledgerStats: { accepted: number; rejected: number }; generated_at: string;
}
export const fetchFounder = (month: string | null, activationDays: number) => call<FounderOverview>('founder-kpis', { action: 'get', month, activationDays });
export const saveFounderInput = (i: { month: string; spendCents: number; grossMarginBp: number; platformFeeCents: number; note: string | null }) =>
  call<{ input: FounderInput }>('founder-kpis', { action: 'upsert_input', ...i });
