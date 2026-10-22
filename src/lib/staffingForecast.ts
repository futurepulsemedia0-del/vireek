import { supabase } from '@/lib/supabase';
import type {
  CapStatus,
  Confidence,
  DayForecast,
  Recommendation,
  RecommendationKind,
  StaffingReport,
} from '../../supabase/functions/_shared/staffing-forecast/engine';

/**
 * Vireek Staffing Forecast — dashboard client.
 *
 * All forecasting runs server-side (supabase/functions/staffing-forecast) in a pure, deterministic
 * engine that reuses Capacity Demand Control (capacity + thresholds) and Regional Demand.
 * This module invokes it, manages the account's staffing assumptions and holds display metadata.
 */

export type { CapStatus, Confidence, DayForecast, Recommendation, RecommendationKind, StaffingReport };
export type {
  Band,
  HourForecast,
  WeekForecast,
  StaffingSettings,
} from '../../supabase/functions/_shared/staffing-forecast/engine';

export interface StaffingInsight {
  title: string;
  description: string;
  recommended_action: string;
  priority: number;
}

export interface StaffingForecastResult {
  run_id: string | null;
  persisted: boolean;
  report: StaffingReport;
  insights: StaffingInsight[];
}

export interface StaffingSettingsRow {
  calls_per_csr_hour: number;
  csr_target_occupancy_pct: number;
  csr_concurrent_override: number | null;
  avg_job_minutes_override: number | null;
  tech_hourly_cost_cents: number | null;
  csr_hourly_cost_cents: number | null;
  overtime_multiplier: number;
  tech_paid_hours_per_day: number;
  sustained_weeks_to_hire: number;
}

export interface StaffingRunSummary {
  id: string;
  created_at: string;
  confidence: Confidence;
  status: 'ok' | 'insufficient_data';
  headline: StaffingReport['headline'];
}

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<CapStatus, string> = {
  low: 'Under-booked',
  optimal: 'Healthy',
  full: 'At capacity',
  no_capacity: 'No capacity set',
  closed: 'Closed',
};

export const STATUS_TONE: Record<CapStatus, string> = {
  low: 'bg-warning-500/10 text-warning-500',
  optimal: 'bg-success-500/10 text-success-500',
  full: 'bg-danger/10 text-danger',
  no_capacity: 'bg-bg-tertiary text-text-secondary',
  closed: 'bg-bg-tertiary text-text-secondary',
};

export const SEVERITY_TONE: Record<Recommendation['severity'], string> = {
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-bg-tertiary text-text-secondary',
};

export const KIND_LABEL: Record<RecommendationKind, string> = {
  hire_technician: 'Hire',
  overtime: 'Overtime',
  rebalance_schedule: 'Rebalance',
  generate_demand: 'Generate demand',
  add_csr_coverage: 'CSR coverage',
  after_hours_coverage: 'After hours',
  configure_technicians: 'Setup',
  configure_csr: 'Setup',
  improve_data: 'Data',
  balanced: 'On track',
};

/** Where each recommendation is acted on, using routes that already exist in the app. */
export const KIND_LINK: Partial<Record<RecommendationKind, { href: string; label: string }>> = {
  generate_demand: { href: '/dashboard/capacity-demand', label: 'Open Capacity Demand Control' },
  rebalance_schedule: { href: '/dashboard/capacity-demand', label: 'Use waitlist & reserve' },
  configure_technicians: { href: '/dashboard/technician-capacity', label: 'Open Technician Capacity' },
};

export const CONFIDENCE_TONE: Record<Confidence, string> = {
  high: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

export const fmtMoney = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '—' : `$${Math.round(cents / 100).toLocaleString('en-US')}`;

export const fmtPct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

export const fmtDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export const fmtHour = (h: number): string => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export async function runStaffingForecast(opts: { narrative?: boolean } = {}): Promise<StaffingForecastResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('staffing-forecast', {
    body: { narrative: opts.narrative ?? true },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) {
    // Surface the function's own message (403 / 429 / 500) when present.
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      const body = ctx ? await ctx.json() : null;
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* keep generic message */
    }
    throw new Error(message);
  }
  if (!data?.report) throw new Error('The forecast returned no data.');
  return data as StaffingForecastResult;
}

export async function fetchStaffingSettings(): Promise<StaffingSettingsRow> {
  const { data, error } = await supabase.rpc('get_or_create_staffing_settings');
  if (error) throw error;
  return data as StaffingSettingsRow;
}

export async function updateStaffingSettings(patch: Partial<StaffingSettingsRow>): Promise<StaffingSettingsRow> {
  const { data, error } = await supabase.rpc('update_staffing_forecast_settings', { p_patch: patch });
  if (error) throw error;
  return data as StaffingSettingsRow;
}

export async function fetchLatestStaffingRun(): Promise<StaffingForecastResult | null> {
  const { data, error } = await supabase
    .from('staffing_forecast_runs')
    .select('id, report')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { run_id: data.id as string, persisted: true, report: data.report as StaffingReport, insights: [] };
}

export async function fetchStaffingRunHistory(limit = 12): Promise<StaffingRunSummary[]> {
  const { data, error } = await supabase
    .from('staffing_forecast_runs')
    .select('id, created_at, confidence, status, headline')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as StaffingRunSummary[];
}
