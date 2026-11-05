// src/lib/chiefOfStaff.ts
//
// Client for the Chief of Staff layer. Reads go through the `chief-of-staff` edge function (aggregation);
// every state change is a SECURITY DEFINER RPC called with the user's own JWT, so the database — not this
// file — decides who may claim, dismiss, change autonomy or flip the kill switch.

import { supabase } from '@/lib/supabase';

export type RecKind = 'capacity_gap' | 'leak' | 'risk' | 'opportunity';
export type OwnerRole = 'owner' | 'manager' | 'dispatcher' | 'csr' | 'any';
export type AutonomyMode = 'suggest' | 'approve' | 'auto';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type GoalMetric = 'revenue' | 'booked_jobs' | 'answer_rate' | 'gross_margin';
export type PeriodAnswer = 'week' | 'month' | 'quarter' | 'year';

export interface Evidence {
  source_table: string;
  ref: string;
  metric: string;
  value: string;
  as_of?: string;
}

export interface Recommendation {
  id: string;
  kind: RecKind;
  domain: string;
  title: string;
  why_it_matters: string;
  evidence: Evidence[];
  impact_low_cents: number | null;
  impact_high_cents: number | null;
  impact_basis: string | null;
  confidence: number | null;
  confidence_basis: string | null;
  owner_role: OwnerRole;
  action_kind: 'navigate' | 'operator_command' | 'none';
  action_label: string | null;
  action_href: string | null;
  action_command: string | null;
  works_with: string[];
  priority_score: number;
  source_engine: string;
  status: 'open' | 'claimed';
  claimed_by_me: boolean;
  claimed_by_other: boolean;
  claim_expires_at: string | null;
}

export interface GoalProgress {
  metric: GoalMetric;
  target: number;
  actual: number | null;
  expectedToDate: number | null;
  projected: number | null;
  pct: number | null;
  status: 'ahead' | 'on_track' | 'behind' | 'unavailable';
  basis: string;
  unavailable?: 'not_enough_data' | 'query_failed' | 'too_large' | 'no_permission';
}

export interface GoalRow {
  target: {
    id: string;
    metric: GoalMetric;
    target_value: number | string;
    unit: 'usd' | 'count' | 'pct';
    period_start: string;
    period_end: string;
    source: string;
    source_ref: string | null;
  };
  progress: GoalProgress;
}

export interface CosSettings {
  kill_switch_active: boolean;
  kill_switch_reason: string | null;
  kill_switch_changed_at: string | null;
  autonomy_by_risk: Partial<Record<RiskLevel, AutonomyMode>>;
  max_messages_per_day: number | null;
  can_manage: boolean;
  can_act: boolean;
}

export interface AgentDial {
  agent_source: string;
  labels: string[];
  has_messaging: boolean;
  mode: AutonomyMode | null;
  max_messages_per_day: number | null;
}

export interface ConflictRow {
  id: string;
  rule_key: 'demand_vs_capacity' | 'margin_vs_discount' | 'same_subject_contact';
  severity: 'info' | 'warning' | 'critical';
  summary: string;
  created_at: string;
}

export interface SuppressedRow {
  id: string;
  title: string;
  domain: string;
  suppressed_reason: string | null;
  priority_score: number;
}

export interface FeedEvent {
  id: string;
  event_type: string;
  source: string;
  subject_type: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface UsefulnessRow {
  source_engine: string;
  accepted: number;
  dismissed: number;
  expired: number;
  total: number;
  accept_rate_pct: number | null;
}

export interface Overview {
  as_of: string;
  timezone: string;
  today: string;
  can_see_billing: boolean;
  last_refresh_at: string | null;
  settings: CosSettings | null;
  dials: AgentDial[];
  top: Recommendation[];
  more_count: number;
  suppressed: SuppressedRow[];
  conflicts: ConflictRow[];
  goals: GoalRow[];
  feed: FeedEvent[];
  pending_approvals: number;
  usefulness: UsefulnessRow[];
}

export interface ParsedTarget {
  metric: GoalMetric;
  value: number;
  unit: 'usd' | 'count' | 'pct';
  periodStart: string | null;
  periodEnd: string | null;
  source: 'typed' | 'spreadsheet';
  sourceRef: string;
  sourceText: string;
}

export interface ClarifyQuestion {
  id: 'period' | 'duplicate_metric' | 'missing_value';
  metric?: GoalMetric;
  options?: string[];
}

export type ExtractWarning =
  | { code: 'fraction_converted'; ref: string }
  | { code: 'truncated'; detail: string }
  | { code: 'input_too_long' };

export interface ExtractResult {
  targets: ParsedTarget[];
  pendingPeriod: ParsedTarget[];
  unresolved: { metric: GoalMetric; ref: string; reason: 'missing_value' | 'duplicate_metric' }[];
  questions: ClarifyQuestion[];
  warnings: ExtractWarning[];
}

export interface ExtractAnswers {
  period?: PeriodAnswer;
  pick?: Partial<Record<GoalMetric, number>>;
}

export class ChiefOfStaffError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ChiefOfStaffError';
    this.status = status;
  }
}

async function readFunctionError(error: unknown): Promise<ChiefOfStaffError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new ChiefOfStaffError(body.error, ctx.status);
    } catch {
      /* body was not JSON */
    }
    return new ChiefOfStaffError('Chief of Staff could not complete that right now.', ctx.status);
  }
  return new ChiefOfStaffError('Could not reach Chief of Staff. Check your connection and try again.');
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('chief-of-staff', {
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readFunctionError(error);
  if (!data) throw new ChiefOfStaffError('Chief of Staff returned an empty response.');
  return data as T;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const forbidden = error.code === '42501' || /not_allowed/.test(error.message);
    throw new ChiefOfStaffError(forbidden ? 'You do not have permission to do that.' : 'That did not go through. Please try again.', forbidden ? 403 : null);
  }
  return data as T;
}

export const fetchOverview = () => invoke<Overview>({ action: 'overview' });
export const refreshRecommendations = () => invoke<{ refreshed?: boolean; throttled?: boolean; failed_sources?: string[] }>({ action: 'refresh' });
export const parseGoals = (input: { text?: string; csv?: string; answers?: ExtractAnswers }) =>
  invoke<ExtractResult>({ action: 'goals_parse', ...input });

export interface ClaimResult {
  claimed: boolean;
  status: string;
  claimed_by_other?: boolean;
  expires_at?: string | null;
}
export const claimRecommendation = (id: string) => rpc<ClaimResult>('cos_claim_recommendation', { p_id: id, p_ttl_minutes: 10 });
export const resolveRecommendation = (id: string, outcome: 'executed' | 'dismissed' | 'failed' | 'released', note?: string) =>
  rpc<{ ok: boolean; status?: string; reason?: string }>('cos_resolve_recommendation', { p_id: id, p_outcome: outcome, p_note: note ?? null });

export const setKillSwitch = (active: boolean, reason?: string) =>
  rpc<{ kill_switch_active: boolean }>('cos_set_kill_switch', { p_active: active, p_reason: reason ?? null });
export const setAutonomyByRisk = (map: Partial<Record<RiskLevel, AutonomyMode>>, maxMessagesPerDay: number | null) =>
  rpc<unknown>('cos_set_autonomy_by_risk', { p_map: map, p_max_messages_per_day: maxMessagesPerDay });
export const setAgentDial = (agentSource: string, mode: AutonomyMode, maxMessagesPerDay: number | null) =>
  rpc<unknown>('cos_set_agent_dial', { p_agent_source: agentSource, p_mode: mode, p_max_messages_per_day: maxMessagesPerDay });

export const confirmGoalTargets = (targets: ParsedTarget[]) =>
  rpc<{ saved: number }>('cos_confirm_goal_targets', {
    p_targets: targets.map((t) => ({
      metric: t.metric,
      target_value: t.value,
      unit: t.unit,
      period_start: t.periodStart,
      period_end: t.periodEnd,
      source: t.source,
      source_ref: t.sourceRef,
    })),
  });
export const archiveGoalTarget = (id: string) => rpc<boolean>('cos_archive_goal_target', { p_id: id });

// ---- pure helpers -----------------------------------------------------------

export interface TrustTests {
  /** 1. It shows its reasoning: there is a written reason AND at least one cited source row. */
  showsReasoning: boolean;
  /** 2. It asks before it acts: Chief of Staff never executes a recommendation by itself. */
  asksBeforeActing: true;
  /** 3. It works with what the business already uses: the action opens an existing Vireek screen/workflow. */
  usesExistingTools: boolean;
}

export function trustTests(r: Pick<Recommendation, 'why_it_matters' | 'evidence' | 'action_kind' | 'action_href'>): TrustTests {
  return {
    showsReasoning: r.why_it_matters.trim().length > 0 && r.evidence.length > 0,
    asksBeforeActing: true,
    usesExistingTools: r.action_kind === 'operator_command' || (r.action_kind === 'navigate' && !!r.action_href),
  };
}

export type ImpactView =
  | { kind: 'none' }
  | { kind: 'point'; cents: number }
  | { kind: 'range'; low: number; high: number };

export function impactView(r: Pick<Recommendation, 'impact_low_cents' | 'impact_high_cents'>): ImpactView {
  const { impact_low_cents: low, impact_high_cents: high } = r;
  if (low === null || high === null) return { kind: 'none' };
  return low === high ? { kind: 'point', cents: high } : { kind: 'range', low, high };
}

export function formatUsdFromCents(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

export function formatGoalValue(metric: GoalMetric, v: number, locale: string): string {
  if (metric === 'revenue') return formatUsdFromCents(Math.round(v * 100), locale);
  if (metric === 'booked_jobs') return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)}%`;
}

/** Maps the browser/app language to a BCP-47 tag for the Web Speech API. */
export function speechLang(language: string): string {
  const base = language.slice(0, 2).toLowerCase();
  const map: Record<string, string> = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', fa: 'fa-IR', ar: 'ar-SA', hi: 'hi-IN', ja: 'ja-JP', zh: 'zh-CN',
  };
  return map[base] ?? 'en-US';
}

/** Spreadsheets: CSV/TSV/TXT and .xlsx are read in the browser; older binary formats must be re-saved. */
export function classifySpreadsheet(file: Pick<File, 'name' | 'size' | 'type'>): 'csv' | 'xlsx' | 'legacy_excel' | 'too_large' | 'unsupported' {
  const n = file.name.toLowerCase();
  if (/\.xlsx$/.test(n)) return file.size > 2_000_000 ? 'too_large' : 'xlsx';
  if (/\.(xlsm|xls|ods|numbers)$/.test(n)) return 'legacy_excel';
  if (/\.(csv|tsv|txt)$/.test(n) || file.type === 'text/csv' || file.type === 'text/tab-separated-values' || file.type === 'text/plain') {
    return file.size > 20_000 ? 'too_large' : 'csv';
  }
  return 'unsupported';
}
