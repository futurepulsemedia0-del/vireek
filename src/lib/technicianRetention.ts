import { supabase } from '@/lib/supabase';

// ============================================================
// Types (mirror supabase/migrations/20271122000000_technician_retention_engine.sql)
// ============================================================

export type RiskBand = 'high' | 'elevated' | 'low' | 'insufficient';
export type DataQuality = 'ok' | 'limited' | 'insufficient';
export type DriverKey =
  | 'same_day_changes' | 'overtime' | 'on_call_load' | 'earnings_trend'
  | 'callback_rate' | 'unpaid_time' | 'unanswered_requests';
export type ActionType =
  | 'rebalance_on_call' | 'freeze_schedule' | 'reduce_overtime'
  | 'remove_paperwork_step' | 'clear_office_backlog' | 'manager_one_on_one';
export type ActionStatus = 'suggested' | 'approved' | 'dismissed' | 'expired';
export type ActionOutcome = 'improved' | 'no_change' | 'worsened';

export const DRIVER_KEYS: DriverKey[] = [
  'same_day_changes', 'earnings_trend', 'overtime', 'on_call_load',
  'unanswered_requests', 'unpaid_time', 'callback_rate',
];
/** Max points each signal can add to a score (sums to 100). */
export const DRIVER_WEIGHTS: Record<DriverKey, number> = {
  same_day_changes: 22, earnings_trend: 18, overtime: 16, on_call_load: 14,
  unanswered_requests: 12, unpaid_time: 10, callback_rate: 8,
};
export const HIGH_AT = 50;
export const ELEVATED_AT = 25;

export interface RiskDriver {
  key: DriverKey;
  points: number;
  severity: number;
  params: Record<string, number>;
  message: string;
}

export interface TechRiskScore {
  id: string;
  tech_id: string;
  week: string;
  score: number;
  risk_band: RiskBand;
  data_quality: DataQuality;
  confidence: number;
  top_drivers: RiskDriver[];
  attrition_probability: number;
  est_replacement_cost: number;
  expected_annual_cost: number;
  score_delta: number | null;
  computed_at: string;
  is_demo: boolean;
}

export interface RetentionAction {
  id: string;
  tech_id: string;
  action_type: ActionType;
  driver_key: DriverKey;
  title: string;
  detail: string;
  params: Record<string, number | string>;
  status: ActionStatus;
  baseline_score: number | null;
  outcome: ActionOutcome | null;
  score_after: number | null;
  decided_at: string | null;
  created_at: string;
}

export interface RetentionFreeze {
  id: string;
  tech_id: string;
  starts_at: string;
  ends_at: string;
}

export interface RetentionTech {
  id: string;
  name: string;
  tenureDays: number;
}

export interface RetentionSnapshot {
  week: string | null;
  scores: TechRiskScore[];
  techs: Record<string, RetentionTech>;
  actions: RetentionAction[];
  freezes: RetentionFreeze[];
  history: Record<string, number[]>; // oldest -> newest
}

// ============================================================
// Pure helpers
// ============================================================

export function bandForScore(score: number): Exclude<RiskBand, 'insufficient'> {
  return score >= HIGH_AT ? 'high' : score >= ELEVATED_AT ? 'elevated' : 'low';
}

const BAND_ORDER: Record<RiskBand, number> = { high: 0, elevated: 1, low: 2, insufficient: 3 };

export type SortMode = 'risk' | 'cost';

export function sortScores(scores: TechRiskScore[], mode: SortMode): TechRiskScore[] {
  const copy = [...scores];
  copy.sort((a, b) => {
    if (mode === 'cost') return b.expected_annual_cost - a.expected_annual_cost || b.score - a.score;
    return BAND_ORDER[a.risk_band] - BAND_ORDER[b.risk_band] || b.score - a.score || b.expected_annual_cost - a.expected_annual_cost;
  });
  return copy;
}

export function filterByBand(scores: TechRiskScore[], band: RiskBand | 'all'): TechRiskScore[] {
  return band === 'all' ? scores : scores.filter((s) => s.risk_band === band);
}

export interface RetentionSummary {
  total: number;
  high: number;
  elevated: number;
  low: number;
  insufficient: number;
  /** Sum of attrition_probability x replacement cost across the team, whole USD per year. */
  yearlyAttritionCost: number;
  /** Cost of losing everyone currently high/elevated, whole USD. */
  costAtRisk: number;
}

export function summarize(scores: TechRiskScore[]): RetentionSummary {
  const out: RetentionSummary = { total: scores.length, high: 0, elevated: 0, low: 0, insufficient: 0, yearlyAttritionCost: 0, costAtRisk: 0 };
  for (const s of scores) {
    out[s.risk_band] += 1;
    out.yearlyAttritionCost += s.expected_annual_cost;
    if (s.risk_band === 'high' || s.risk_band === 'elevated') out.costAtRisk += s.est_replacement_cost;
  }
  return out;
}

export interface ActionImpact { approved: number; measured: number; improved: number; worsened: number }

export function actionImpact(actions: RetentionAction[]): ActionImpact {
  const out: ActionImpact = { approved: 0, measured: 0, improved: 0, worsened: 0 };
  for (const a of actions) {
    if (a.status !== 'approved') continue;
    out.approved += 1;
    if (a.outcome) out.measured += 1;
    if (a.outcome === 'improved') out.improved += 1;
    if (a.outcome === 'worsened') out.worsened += 1;
  }
  return out;
}

export function formatUsd(amount: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `$${Math.round(amount).toLocaleString('en-US')}`;
  }
}

export function formatTenure(days: number): { unit: 'days' | 'months' | 'years'; value: number } {
  if (days < 60) return { unit: 'days', value: Math.max(0, Math.round(days)) };
  if (days < 730) return { unit: 'months', value: Math.round(days / 30.44) };
  return { unit: 'years', value: Math.round((days / 365.25) * 10) / 10 };
}

/** Only owners, admins and managers may see retention data (RLS enforces the same rule). */
export function canViewRetention(isOwner: boolean, role: string | null | undefined): boolean {
  return isOwner || role === 'admin' || role === 'manager';
}

// ============================================================
// API
// ============================================================

type RpcStatus = 'applied' | 'forbidden' | 'not_found' | 'already_processed';

function asStatus(data: unknown): RpcStatus {
  const s = (data as { status?: string } | null)?.status;
  return s === 'applied' || s === 'forbidden' || s === 'not_found' || s === 'already_processed' ? s : 'not_found';
}

export async function fetchRetentionSnapshot(): Promise<RetentionSnapshot> {
  const empty: RetentionSnapshot = { week: null, scores: [], techs: {}, actions: [], freezes: [], history: {} };

  const { data: latest, error: latestErr } = await supabase
    .from('tech_risk_scores').select('week').order('week', { ascending: false }).limit(1).maybeSingle();
  if (latestErr) throw new Error(latestErr.message);
  if (!latest) return { ...empty, ...(await fetchActionsAndFreezes()) };

  const week = (latest as { week: string }).week;
  const { data: scoreRows, error: scoreErr } = await supabase
    .from('tech_risk_scores')
    .select('id, tech_id, week, score, risk_band, data_quality, confidence, top_drivers, attrition_probability, est_replacement_cost, expected_annual_cost, score_delta, computed_at, is_demo')
    .eq('week', week);
  if (scoreErr) throw new Error(scoreErr.message);
  const scores = (scoreRows ?? []) as TechRiskScore[];
  const ids = scores.map((s) => s.tech_id);

  const [techRes, histRes, extras] = await Promise.all([
    ids.length
      ? supabase.from('team_members').select('id, member_name, member_email, created_at').in('id', ids)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? supabase.from('tech_risk_scores').select('tech_id, week, score, risk_band').in('tech_id', ids).order('week', { ascending: false }).limit(ids.length * 8)
      : Promise.resolve({ data: [], error: null }),
    fetchActionsAndFreezes(),
  ]);
  if (techRes.error) throw new Error(techRes.error.message);

  const now = Date.now();
  const techs: Record<string, RetentionTech> = {};
  for (const t of (techRes.data ?? []) as { id: string; member_name: string | null; member_email: string; created_at: string }[]) {
    techs[t.id] = {
      id: t.id,
      name: (t.member_name ?? '').trim() || t.member_email,
      tenureDays: Math.max(0, Math.floor((now - Date.parse(t.created_at)) / 86_400_000)),
    };
  }

  const history: Record<string, number[]> = {};
  const rows = ((histRes.data ?? []) as { tech_id: string; week: string; score: number; risk_band: RiskBand }[])
    .filter((r) => r.risk_band !== 'insufficient')
    .sort((a, b) => a.week.localeCompare(b.week));
  for (const r of rows) (history[r.tech_id] ??= []).push(r.score);

  return { week, scores, techs, history, ...extras };
}

async function fetchActionsAndFreezes(): Promise<Pick<RetentionSnapshot, 'actions' | 'freezes'>> {
  const [actionRes, freezeRes] = await Promise.all([
    supabase.from('retention_actions')
      .select('id, tech_id, action_type, driver_key, title, detail, params, status, baseline_score, outcome, score_after, decided_at, created_at')
      .in('status', ['suggested', 'approved']).order('created_at', { ascending: false }).limit(300),
    supabase.from('retention_schedule_freezes')
      .select('id, tech_id, starts_at, ends_at').is('lifted_at', null).gt('ends_at', new Date().toISOString()),
  ]);
  if (actionRes.error) throw new Error(actionRes.error.message);
  if (freezeRes.error) throw new Error(freezeRes.error.message);
  return { actions: (actionRes.data ?? []) as RetentionAction[], freezes: (freezeRes.data ?? []) as RetentionFreeze[] };
}

export async function runRetentionEngine(): Promise<{ scored: number; suggested: number }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('technician-retention-engine', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: {},
  });
  if (error) throw new Error(error.message);
  return { scored: Number(data?.scored ?? 0), suggested: Number(data?.suggested ?? 0) };
}

export async function approveRetentionAction(id: string, taskTitle: string, taskDescription: string): Promise<RpcStatus> {
  const { data, error } = await supabase.rpc('approve_retention_action', {
    p_action_id: id, p_task_title: taskTitle, p_task_description: taskDescription,
  });
  if (error) throw new Error(error.message);
  return asStatus(data);
}

export async function dismissRetentionAction(id: string): Promise<RpcStatus> {
  const { data, error } = await supabase.rpc('dismiss_retention_action', { p_action_id: id });
  if (error) throw new Error(error.message);
  return asStatus(data);
}

export async function liftRetentionFreeze(id: string): Promise<RpcStatus> {
  const { data, error } = await supabase.rpc('lift_retention_freeze', { p_freeze_id: id });
  if (error) throw new Error(error.message);
  return asStatus(data);
}
