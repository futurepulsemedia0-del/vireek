import { supabase } from '@/lib/supabase';
import { loadRules } from '../../supabase/functions/_shared/dispatch/rulesContext';
import {
  analyzeCausalDispatch,
  suggestWeightChanges,
  type CausalAnalysis,
  type FactorProvenance,
  type RawDecision,
  type RawOutcomeJob,
  type WeightSuggestion,
} from '@/lib/causalDispatch';
import { saveRule, type DispatchRule } from '@/lib/dispatchRulesApi';

/**
 * Data access for the Causal Dispatch Loop UI. Every query is filtered by the account owner id on top of RLS.
 * Schema: supabase/migrations/20281102000100_causal_dispatch_loop.sql.
 */

// ============================================================
// SETTINGS
// ============================================================

export interface ExplorationSettings {
  enabled: boolean;
  killSwitch: boolean;
  budgetPct: number;
  delta: number;
  maxRegretPct: number;
  perTechWeeklyCap: number;
  guardrailTolerancePct: number;
  autoDisabledAt: string | null;
  autoDisabledReason: string | null;
}

export const DEFAULT_SETTINGS: ExplorationSettings = {
  enabled: false, killSwitch: false, budgetPct: 10, delta: 3, maxRegretPct: 5, perTechWeeklyCap: 3, guardrailTolerancePct: 5, autoDisabledAt: null, autoDisabledReason: null,
};

/** Bounds mirror the CHECK constraints so the UI never sends a value the database would reject. */
export const SETTING_LIMITS = {
  budgetPct: { min: 0, max: 25, step: 1 },
  delta: { min: 0, max: 20, step: 0.5 },
  maxRegretPct: { min: 0, max: 20, step: 1 },
  perTechWeeklyCap: { min: 0, max: 50, step: 1 },
  guardrailTolerancePct: { min: 0, max: 50, step: 1 },
} as const;

const clampTo = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

export function sanitizeSettings(s: ExplorationSettings): ExplorationSettings {
  const L = SETTING_LIMITS;
  return {
    ...s,
    budgetPct: clampTo(s.budgetPct, L.budgetPct.min, L.budgetPct.max, DEFAULT_SETTINGS.budgetPct),
    delta: clampTo(s.delta, L.delta.min, L.delta.max, DEFAULT_SETTINGS.delta),
    maxRegretPct: clampTo(s.maxRegretPct, L.maxRegretPct.min, L.maxRegretPct.max, DEFAULT_SETTINGS.maxRegretPct),
    perTechWeeklyCap: Math.round(clampTo(s.perTechWeeklyCap, L.perTechWeeklyCap.min, L.perTechWeeklyCap.max, DEFAULT_SETTINGS.perTechWeeklyCap)),
    guardrailTolerancePct: clampTo(s.guardrailTolerancePct, L.guardrailTolerancePct.min, L.guardrailTolerancePct.max, DEFAULT_SETTINGS.guardrailTolerancePct),
  };
}

export async function fetchExplorationSettings(ownerId: string): Promise<ExplorationSettings> {
  const { data, error } = await supabase
    .from('dispatch_exploration_settings')
    .select('enabled, kill_switch, budget_pct, delta, max_regret_pct, per_tech_weekly_cap, guardrail_tolerance_pct, auto_disabled_at, auto_disabled_reason')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ...DEFAULT_SETTINGS };
  const r = data as Record<string, unknown>;
  return sanitizeSettings({
    enabled: r.enabled === true,
    killSwitch: r.kill_switch === true,
    budgetPct: Number(r.budget_pct),
    delta: Number(r.delta),
    maxRegretPct: Number(r.max_regret_pct),
    perTechWeeklyCap: Number(r.per_tech_weekly_cap),
    guardrailTolerancePct: Number(r.guardrail_tolerance_pct),
    autoDisabledAt: (r.auto_disabled_at as string | null) ?? null,
    autoDisabledReason: (r.auto_disabled_reason as string | null) ?? null,
  });
}

/** Owner/manager only (RLS: time_off_can_manage). Turning exploration back on clears an automatic shut-off. */
export async function saveExplorationSettings(ownerId: string, input: ExplorationSettings): Promise<void> {
  const s = sanitizeSettings(input);
  const { error } = await supabase.from('dispatch_exploration_settings').upsert(
    {
      user_id: ownerId,
      enabled: s.enabled,
      kill_switch: s.killSwitch,
      budget_pct: s.budgetPct,
      delta: s.delta,
      max_regret_pct: s.maxRegretPct,
      per_tech_weekly_cap: s.perTechWeeklyCap,
      guardrail_tolerance_pct: s.guardrailTolerancePct,
      ...(s.enabled ? { auto_disabled_at: null, auto_disabled_reason: null } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}

// ============================================================
// RECENT EXPLORATION PICKS (for the "why" label)
// ============================================================

export interface ExplorationPick {
  decisionId: string;
  jobId: string;
  createdAt: string;
  jobLabel: string;
  chosenName: string;
  topName: string | null;
  setSize: number;
  propensity: number | null;
  delta: number | null;
  overridden: boolean;
}

export async function fetchRecentExplorationPicks(ownerId: string, days = 14, limit = 20): Promise<ExplorationPick[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('dispatch_decisions')
    .select('id, job_id, technician_id, propensity, set_size, indifference_set, created_at, jobs(customer_name, service_type)')
    .eq('user_id', ownerId)
    .eq('arm', 'explore')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as {
    id: string; job_id: string; technician_id: string | null; propensity: number | null; set_size: number | null; created_at: string;
    indifference_set: { top_id?: string | null; delta?: number } | null;
    jobs: { customer_name: string | null; service_type: string | null } | { customer_name: string | null; service_type: string | null }[] | null;
  }[];
  if (rows.length === 0) return [];

  const techIds = [...new Set(rows.flatMap((r) => [r.technician_id, r.indifference_set?.top_id ?? null]).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (techIds.length) {
    const { data: t } = await supabase.from('team_members').select('id, member_name, member_email').eq('account_owner_id', ownerId).in('id', techIds);
    for (const m of (t ?? []) as { id: string; member_name: string | null; member_email: string | null }[]) names.set(m.id, m.member_name ?? m.member_email ?? 'Technician');
  }

  // A later manual/override decision for the same job means the dispatcher changed the pick.
  const jobIds = rows.map((r) => r.job_id);
  const { data: later } = await supabase.from('dispatch_decisions').select('job_id, mode, created_at').eq('user_id', ownerId).in('job_id', jobIds).in('mode', ['override', 'manual']).gte('created_at', since);
  const overriddenJobs = new Set<string>();
  for (const l of (later ?? []) as { job_id: string; mode: string; created_at: string }[]) {
    const pick = rows.find((r) => r.job_id === l.job_id);
    if (pick && l.mode === 'override' && l.created_at >= pick.created_at) overriddenJobs.add(l.job_id);
  }

  return rows.map((r) => {
    const j = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    return {
      decisionId: r.id,
      jobId: r.job_id,
      createdAt: r.created_at,
      jobLabel: [j?.service_type, j?.customer_name].filter(Boolean).join(' · ') || 'Job',
      chosenName: (r.technician_id && names.get(r.technician_id)) || 'Technician',
      topName: r.indifference_set?.top_id ? names.get(r.indifference_set.top_id) ?? null : null,
      setSize: r.set_size ?? 0,
      propensity: r.propensity,
      delta: typeof r.indifference_set?.delta === 'number' ? r.indifference_set.delta : null,
      overridden: overriddenJobs.has(r.job_id),
    };
  });
}

// ============================================================
// CAUSAL ANALYSIS
// ============================================================

const CHUNK = 150;
function chunks<T>(a: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += CHUNK) out.push(a.slice(i, i + CHUNK));
  return out;
}

export interface CausalReport {
  analysis: CausalAnalysis;
  suggestions: WeightSuggestion[];
  generatedAt: string;
}

export async function fetchCausalReport(ownerId: string, days = 180): Promise<CausalReport> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: dec, error } = await supabase
    .from('dispatch_decisions')
    .select('id, job_id, technician_id, arm, set_size, indifference_set')
    .eq('user_id', ownerId)
    .eq('mode', 'auto')
    .in('arm', ['explore', 'exploit'])
    .gte('set_size', 2)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3000);
  if (error) throw new Error(error.message);
  const decisions = (dec ?? []) as RawDecision[];
  const jobIds = [...new Set(decisions.map((d) => d.job_id))];

  const jobs: RawOutcomeJob[] = [];
  const reworks: { rework_of_job_id: string | null; created_at: string }[] = [];
  const durationResidual: Record<string, number> = {};
  for (const ids of chunks(jobIds)) {
    const [j, r, p] = await Promise.all([
      supabase.from('jobs').select('id, service_type, job_status, scheduled_datetime, created_at, completed_at, invoice_amount, sla_response_hours, assigned_technician_id, is_rework, rework_of_job_id').eq('user_id', ownerId).in('id', ids),
      supabase.from('jobs').select('rework_of_job_id, created_at').eq('user_id', ownerId).eq('is_rework', true).in('rework_of_job_id', ids),
      supabase.from('job_duration_predictions').select('job_id, p50, actual_minutes, predicted_at').eq('user_id', ownerId).eq('scored', true).in('job_id', ids).order('predicted_at', { ascending: true }),
    ]);
    if (j.error) throw new Error(j.error.message);
    if (r.error) throw new Error(r.error.message);
    jobs.push(...((j.data ?? []) as unknown as RawOutcomeJob[]));
    reworks.push(...((r.data ?? []) as { rework_of_job_id: string | null; created_at: string }[]));
    // Duration predictions are optional (table may be empty); the latest scored prediction per job wins.
    if (!p.error) for (const row of (p.data ?? []) as { job_id: string; p50: number; actual_minutes: number }[]) {
      if (Number.isFinite(row.p50) && Number.isFinite(row.actual_minutes)) durationResidual[row.job_id] = row.actual_minutes - row.p50;
    }
  }

  const analysis = analyzeCausalDispatch({ decisions, jobs, reworks, durationResidual, now: new Date() });
  const rules = await loadRules(supabase, ownerId).catch(() => []);
  return { analysis, suggestions: suggestWeightChanges(analysis.factors, rules), generatedAt: new Date().toISOString() };
}

/** The owner approved this exact suggestion: write the single new weight through the normal rule save. */
export async function applyWeightSuggestion(ownerId: string, s: WeightSuggestion): Promise<void> {
  const rules = await loadRules(supabase, ownerId);
  const rule = rules.find((r) => r.rule_type === s.ruleType);
  if (!rule) throw new Error('That rule no longer exists.');
  if (rule.weight !== s.currentWeight) throw new Error('The rule changed since this suggestion was made. Re-run the analysis.');
  const next: DispatchRule = { ...rule, weight: s.suggestedWeight };
  await saveRule(ownerId, next);
}

// ============================================================
// PROVENANCE STORE — lets factor explanations anywhere on the board show a badge
// ============================================================

type Listener = () => void;
let provenance: Record<string, FactorProvenance> | null = null;
const listeners = new Set<Listener>();

export const getProvenance = () => provenance;
export function setProvenance(next: Record<string, FactorProvenance> | null) {
  provenance = next;
  listeners.forEach((l) => l());
}
export function subscribeProvenance(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
