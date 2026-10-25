import { supabase } from '@/lib/supabase';
import { adjustmentsToMap, fetchLearnedAdjustments } from '@/lib/digitalTwin';
import {
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  buildStabilizerReport,
  type ActionStatus,
  type ActionType,
  type Effect,
  type GuardrailStatus,
  type HistoryPayload,
  type MeasureWindow,
  type ProposedAction,
  type StabilizerReport,
  type StabilizerSettings,
  type TwinCalibration,
} from '@/lib/seasonalStabilizer';

/**
 * Seasonal Revenue Stabilizer — data access.
 * Forecasting is pure (seasonalStabilizer.ts); this module only reads the aggregated history, applies the
 * Digital Twin's learned calibration, and drives the approval workflow through SECURITY DEFINER RPCs.
 */

export interface ActionRow {
  id: string;
  fingerprint: string;
  action_type: ActionType;
  service_line: string;
  title: string;
  rationale: string;
  window_start: string;
  window_end: string;
  est_revenue_cents: number;
  est_margin_cents: number;
  shifted_revenue_cents: number;
  est_labor_hours: number;
  margin_pct_after: number | null;
  margin_floor_pct: number | null;
  guardrail_status: GuardrailStatus;
  override_reason: string | null;
  status: ActionStatus;
  details: Record<string, unknown> & { effects?: Effect[] };
  measure_windows: MeasureWindow[];
  decision_note: string | null;
  decided_at: string | null;
  launched_at: string | null;
  launch_ref: string | null;
  measured_at: string | null;
  result: MeasuredResult | null;
  created_at: string;
}

export interface MeasuredResult {
  measured_on: string;
  windows: (MeasureWindow & { actual_cents: number; actual_jobs: number })[];
  realized_revenue_delta_cents: number;
  predicted_revenue_delta_cents: number;
  realized_margin_delta_cents: number;
  accuracy_ratio: number | null;
  new_memberships: number;
  membership_target: number | null;
  deferral_offers_accepted: number;
  deferral_offers_total: number;
  method: string;
}

export interface DeferralOffer {
  id: string;
  action_id: string;
  job_id: string;
  customer_name: string | null;
  original_datetime: string;
  proposed_datetime: string;
  incentive_pct: number;
  status: 'offered' | 'accepted' | 'declined' | 'failed';
  failure_reason: string | null;
}

export interface RunSummary {
  id: string;
  created_at: string;
  stability_score: number;
  stability_score_with_actions: number | null;
  confidence: 'high' | 'medium' | 'low';
}

const ACTION_COLUMNS =
  'id, fingerprint, action_type, service_line, title, rationale, window_start, window_end, est_revenue_cents, est_margin_cents, shifted_revenue_cents, est_labor_hours, margin_pct_after, margin_floor_pct, guardrail_status, override_reason, status, details, measure_windows, decision_note, decided_at, launched_at, launch_ref, measured_at, result, created_at';

export async function fetchHistory(): Promise<HistoryPayload> {
  const { data, error } = await supabase.rpc('seasonal_stabilizer_history');
  if (error) throw error;
  return data as HistoryPayload;
}

export async function fetchSettings(): Promise<StabilizerSettings> {
  const { data, error } = await supabase.rpc('get_or_create_seasonal_settings');
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...(data as Partial<StabilizerSettings>) };
}

export async function updateSettings(patch: Partial<StabilizerSettings>): Promise<StabilizerSettings> {
  const { data, error } = await supabase.rpc('update_seasonal_settings', { p_patch: patch });
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...(data as Partial<StabilizerSettings>) };
}

/** Digital Twin learned adjustments -> multipliers for marketing response and price response. */
export async function loadCalibration(): Promise<TwinCalibration> {
  try {
    const map = adjustmentsToMap(await fetchLearnedAdjustments());
    const c = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1.5, Math.max(0.5, v)) : 1);
    return { marketing_factor: c(map.marketing_spend), price_factor: c(map.price_change) };
  } catch {
    return { marketing_factor: 1, price_factor: 1 };
  }
}

export async function fetchActions(): Promise<ActionRow[]> {
  const { data, error } = await supabase
    .from('seasonal_stabilizer_actions')
    .select(ACTION_COLUMNS)
    .neq('status', 'cancelled')
    .order('window_start', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as ActionRow[];
}

export async function fetchRuns(limit = 12): Promise<RunSummary[]> {
  const { data, error } = await supabase
    .from('seasonal_stabilizer_runs')
    .select('id, created_at, stability_score, stability_score_with_actions, confidence')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as RunSummary[];
}

/** Computes a fresh report from live data (no writes). */
export async function computeReport(existing: ActionRow[]): Promise<{ report: StabilizerReport; history: HistoryPayload; settings: StabilizerSettings }> {
  const [history, calibration] = await Promise.all([fetchHistory(), loadCalibration()]);
  const report = buildStabilizerReport(history, {
    calibration,
    existing: existing.map((a) => ({
      action_type: a.action_type,
      service_line: a.service_line,
      window_start: a.window_start,
      window_end: a.window_end,
      status: a.status,
    })),
  });
  return { report, history, settings: { ...DEFAULT_SETTINGS, ...history.settings } as StabilizerSettings };
}

export async function saveForecast(report: StabilizerReport): Promise<{ inserted: number; refreshed: number; withdrawn: number }> {
  const proposals: ProposedAction[] = report.status === 'ok' ? report.actions : [];
  const { data, error } = await supabase.rpc('propose_seasonal_actions', { p_actions: proposals });
  if (error) throw error;
  // The stored report keeps the summary only; the weekly curve is recomputed from live data on every visit.
  const light = { headline: report.headline, notes: report.notes, windows: report.windows, capacity: report.capacity };
  const { error: runError } = await supabase.rpc('save_seasonal_stabilizer_run', {
    p_engine_version: ENGINE_VERSION,
    p_confidence: report.confidence,
    p_score: report.stability.score,
    p_score_with_actions: report.stability_with_actions?.score ?? null,
    p_headline: report.headline,
    p_report: light,
  });
  if (runError) throw runError;
  return data as { inserted: number; refreshed: number; withdrawn: number };
}

export async function decideAction(id: string, decision: 'approve' | 'reject' | 'cancel', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('decide_seasonal_action', { p_id: id, p_decision: decision, p_reason: reason ?? null });
  if (error) throw error;
}

export async function launchAction(id: string, ref?: string): Promise<void> {
  const { error } = await supabase.rpc('launch_seasonal_action', { p_id: id, p_ref: ref ?? null });
  if (error) throw error;
}

export async function measureAction(id: string): Promise<void> {
  const { error } = await supabase.rpc('measure_seasonal_action', { p_id: id });
  if (error) throw error;
}

export async function createDeferralOffers(actionId: string): Promise<number> {
  const { data, error } = await supabase.rpc('create_seasonal_deferral_offers', { p_action_id: actionId });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function fetchDeferralOffers(actionId: string): Promise<DeferralOffer[]> {
  const { data, error } = await supabase
    .from('seasonal_deferral_offers')
    .select('id, action_id, job_id, customer_name, original_datetime, proposed_datetime, incentive_pct, status, failure_reason')
    .eq('action_id', actionId)
    .order('original_datetime', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as DeferralOffer[];
}

export async function respondDeferralOffer(offerId: string, accept: boolean): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('respond_seasonal_deferral_offer', { p_offer_id: offerId, p_accept: accept });
  if (error) throw error;
  return data as { ok: boolean; error?: string };
}

/** Plain-text message staff can send the customer (nothing is sent automatically). */
export function deferralMessage(o: DeferralOffer, business = 'us'): string {
  const fmt = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const perk = o.incentive_pct > 0 ? ` As a thank-you we will take ${o.incentive_pct}% off.` : '';
  return `Hi ${o.customer_name ?? 'there'}, it's ${business}. We are very busy around ${fmt(o.original_datetime)}. Would you be open to moving your appointment to ${fmt(o.proposed_datetime)}?${perk} Reply YES to switch or NO to keep your current time.`;
}
