/**
 * VIREEK Predictive Failure Network - client domain logic.
 *
 * Loop: equipment + history + weather + usage + network -> failure probability -> hand-off to the
 * Home Health Agent (governed outreach -> quote -> job -> dispatch) -> parts staged -> real outcome
 * scores the forecast -> calibration feeds the next forecast.
 *
 * Server counterparts:
 *   supabase/functions/predictive-failure                     (scan / handoff)
 *   supabase/functions/_shared/predictive-failure/engine.ts   (pure prediction engine)
 *   supabase/migrations/20270401000000_predictive_failure_network.sql
 * The client NEVER recomputes probabilities; it only displays what the server stored.
 */

import { supabase } from '@/lib/supabase';

export type PfnBand = 'critical' | 'high' | 'elevated' | 'low';
export type PfnConfidence = 'high' | 'moderate' | 'low';
export type PfnStatus = 'open' | 'handed_off' | 'resolved' | 'dismissed' | 'superseded';
export type PfnOutcome = 'failed_in_window' | 'no_failure' | 'intervened' | 'censored';
export type PfnPartsStatus = 'none' | 'not_needed' | 'staged' | 'backordered' | 'partial' | 'failed';

export interface PfnFactor {
  key: string;
  label: string;
  ratio: number;
  detail: string;
  driver: 'age' | 'service' | 'repairs' | 'data';
}

export interface PfnMode {
  mode: string;
  label: string;
  probability: number;
  rawProbability: number;
  ageMonths: number;
  ageSource: 'component_replaced' | 'unit_age';
  etaSource: 'expert_prior' | 'blended_with_network' | 'network';
  hazardRatio: number;
  factors: PfnFactor[];
  safetyCritical: boolean;
  parts: string[];
  costCents: number;
  costBasis: 'account_history' | 'typical';
  network: { failureRatePct: number; medianAgeMonths: number | null; contributors: number } | null;
}

export interface PfnRecommended {
  kind: 'preventive_repair' | 'inspection' | 'maintenance' | 'replacement_planning';
  handoffAction: 'maintenance' | 'replacement_planning';
  label: string;
  parts: string[];
  estMinutes: number;
}

export interface PfnForecast {
  id: string;
  equipment_id: string;
  customer_id: string | null;
  equipment_label: string;
  horizon_days: number;
  horizon_end: string;
  probability: number;
  raw_probability: number;
  ci_low: number | null;
  ci_high: number | null;
  band: PfnBand;
  confidence: PfnConfidence;
  calibrated: boolean;
  top_mode: string | null;
  top_mode_label: string | null;
  modes: PfnMode[];
  factors: PfnFactor[];
  evidence: Record<string, unknown>;
  recommended: PfnRecommended | null;
  data_gaps: string[];
  customer_explanation: string | null;
  exposure_cents: number;
  status: PfnStatus;
  hh_action_id: string | null;
  hh_quote_id: string | null;
  job_id: string | null;
  loop_stage: string | null;
  loop_blocked_reason: string | null;
  parts_status: PfnPartsStatus;
  parts_detail: { name: string; part?: string; result: string }[];
  handed_off_at: string | null;
  intervened_at: string | null;
  outcome: PfnOutcome | null;
  outcome_mode: string | null;
  issued_at: string;
}

export interface PfnSettings {
  enabled: boolean;
  horizon_days: number;
  alert_threshold: number;
  auto_handoff: boolean;
  auto_stage_parts: boolean;
}

export const PFN_DEFAULT_SETTINGS: PfnSettings = {
  enabled: true,
  horizon_days: 90,
  alert_threshold: 0.35,
  auto_handoff: false,
  auto_stage_parts: true,
};

export interface PfnStats {
  monitored_units: number;
  open: { total: number; critical: number; high: number; elevated: number; exposure_cents: number };
  loop: {
    issued: number;
    handed_off: number;
    contacted: number;
    scheduled: number;
    dispatched: number;
    completed: number;
    declined: number;
    parts_staged: number;
    scored: number;
  };
  accuracy: {
    scored: number;
    failures: number;
    brier: number | null;
    base_rate: number | null;
    skill: number | null;
    calibrated: boolean;
    intervened: number;
    censored: number;
  };
  bins: { bin: number; n: number; positives: number }[];
  modes: { mode: string; expected: number; observed: number; n: number }[];
}

export interface PfnScanResult {
  accounts: number;
  scanned: number;
  forecasts_issued: number;
  unchanged: number;
  skipped_no_evidence: number;
  alerts: number;
  handed_off: number;
  parts_staged: number;
  resolved: number;
  synced: number;
}

export const PFN_MIN_CALIBRATION_N = 30;

export const BAND_LABEL: Record<PfnBand, string> = {
  critical: 'Critical',
  high: 'High',
  elevated: 'Elevated',
  low: 'Low',
};

export const STAGE_LABEL: Record<string, string> = {
  explained: 'Queued for outreach',
  awaiting_customer: 'Quote sent',
  scheduled: 'Visit scheduled',
  dispatched: 'Technician assigned',
  repaired: 'Work completed',
  verified: 'Verified',
  declined: 'Customer declined',
  expired: 'Quote expired',
  dismissed: 'Dismissed',
};

export const PARTS_LABEL: Record<PfnPartsStatus, string> = {
  none: 'Not staged yet',
  not_needed: 'No parts needed',
  staged: 'Parts staged on the job',
  backordered: 'Parts backordered',
  partial: 'Some parts staged',
  failed: 'No matching inventory part',
};

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('predictive-failure', { body });
  if (error) {
    throw new Error(
      await functionErrorMessage(
        error,
        'Could not reach the predictive failure engine. Check your connection and try again.',
      ),
    );
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export function runPfnScan(equipmentIds?: string[]): Promise<PfnScanResult> {
  return invoke<PfnScanResult>({ action: 'scan', equipmentIds: equipmentIds ?? null });
}

export async function handoffPfnForecast(forecastId: string): Promise<void> {
  await invoke<{ ok: boolean }>({ action: 'handoff', forecastId });
}

/** Runs the existing Home Health Agent now so a fresh hand-off is quoted without waiting for its schedule. */
export async function runOutreachNow(): Promise<void> {
  const { error } = await supabase.functions.invoke('home-health-agent', { method: 'POST' });
  if (error) {
    throw new Error(
      await functionErrorMessage(error, 'Could not start outreach. It will still run on its normal schedule.'),
    );
  }
}

const FORECAST_COLUMNS =
  'id, equipment_id, customer_id, equipment_label, horizon_days, horizon_end, probability, raw_probability, ci_low, ci_high, band, confidence, calibrated, top_mode, top_mode_label, modes, factors, evidence, recommended, data_gaps, customer_explanation, exposure_cents, status, hh_action_id, hh_quote_id, job_id, loop_stage, loop_blocked_reason, parts_status, parts_detail, handed_off_at, intervened_at, outcome, outcome_mode, issued_at';

function normalize(r: Record<string, unknown>): PfnForecast {
  const f = r as unknown as PfnForecast;
  return {
    ...f,
    probability: Number(f.probability),
    raw_probability: Number(f.raw_probability),
    ci_low: f.ci_low === null ? null : Number(f.ci_low),
    ci_high: f.ci_high === null ? null : Number(f.ci_high),
    exposure_cents: Number(f.exposure_cents),
    modes: Array.isArray(f.modes) ? f.modes : [],
    factors: Array.isArray(f.factors) ? f.factors : [],
    data_gaps: Array.isArray(f.data_gaps) ? f.data_gaps : [],
    parts_detail: Array.isArray(f.parts_detail) ? f.parts_detail : [],
  };
}

/** Live forecasts (open + in-flight hand-offs), highest risk first. */
export async function fetchPfnForecasts(limit = 200): Promise<PfnForecast[]> {
  const { data, error } = await supabase
    .from('pfn_forecasts')
    .select(FORECAST_COLUMNS)
    .in('status', ['open', 'handed_off'])
    .order('probability', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data as Record<string, unknown>[]) ?? []).map(normalize);
}

export async function fetchPfnStats(): Promise<PfnStats | null> {
  const { data, error } = await supabase.rpc('pfn_my_stats');
  if (error) throw error;
  return (data as PfnStats | null) ?? null;
}

export async function dismissPfnForecast(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('pfn_dismiss_forecast', { p_id: id });
  if (error) throw new Error(error.message);
  return data === true;
}

/** Scores forecasts whose window has ended. Returns how many were resolved. */
export async function sweepPfnForecasts(): Promise<number> {
  const { data, error } = await supabase.rpc('pfn_sweep_my_forecasts');
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function fetchPfnSettings(): Promise<PfnSettings> {
  const { data, error } = await supabase
    .from('pfn_settings')
    .select('enabled, horizon_days, alert_threshold, auto_handoff, auto_stage_parts')
    .maybeSingle();
  if (error) throw error;
  const row = data as Partial<PfnSettings> | null;
  return row
    ? { ...PFN_DEFAULT_SETTINGS, ...row, alert_threshold: Number(row.alert_threshold ?? 0.35) }
    : PFN_DEFAULT_SETTINGS;
}

export async function savePfnSettings(userId: string, settings: PfnSettings): Promise<void> {
  const { error } = await supabase
    .from('pfn_settings')
    .upsert({ user_id: userId, ...settings, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export interface PfnProfile {
  duty_class: 'light' | 'normal' | 'heavy';
  environment: 'normal' | 'coastal' | 'dusty' | 'corrosive' | 'humid';
}

export async function fetchPfnProfile(equipmentId: string): Promise<PfnProfile | null> {
  const { data, error } = await supabase
    .from('pfn_equipment_profiles')
    .select('duty_class, environment')
    .eq('equipment_id', equipmentId)
    .maybeSingle();
  if (error) throw error;
  return (data as PfnProfile | null) ?? null;
}

export async function savePfnProfile(equipmentId: string, profile: PfnProfile): Promise<void> {
  const { error } = await supabase
    .from('pfn_equipment_profiles')
    .upsert(
      { equipment_id: equipmentId, ...profile, updated_at: new Date().toISOString() },
      { onConflict: 'equipment_id' },
    );
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// display helpers
// ---------------------------------------------------------------------------

export const pct = (p: number | null | undefined, digits = 0): string =>
  p === null || p === undefined ? '—' : `${(p * 100).toFixed(digits)}%`;

export const dollars = (cents: number): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    cents / 100,
  );

export function humanizeMode(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Observed failure frequency per calibration bin, for the reliability table. */
export function reliabilityRows(bins: PfnStats['bins']): {
  range: string;
  predicted: number;
  observed: number | null;
  n: number;
}[] {
  const byBin = new Map(bins.map((b) => [b.bin, b]));
  return Array.from({ length: 10 }, (_, i) => {
    const b = byBin.get(i);
    return {
      range: `${i * 10}–${(i + 1) * 10}%`,
      predicted: (i + 0.5) / 10,
      observed: b && b.n > 0 ? b.positives / b.n : null,
      n: b?.n ?? 0,
    };
  });
}

export function skillLabel(skill: number | null): string {
  if (skill === null) return 'Not enough outcomes yet';
  if (skill >= 0.3) return 'Strong';
  if (skill >= 0.1) return 'Useful';
  if (skill > 0) return 'Slightly better than baseline';
  return 'No better than baseline';
}
