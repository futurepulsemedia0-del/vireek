import { supabase } from '@/lib/supabase';
import {
  loadRulesContext,
  loadVipCustomerIds,
  dayKey,
  toEngineJob,
  type RulesContext,
} from '../../supabase/functions/_shared/dispatch/rulesContext';
import {
  loadsForDay,
  rankTechnicians,
  snapshotForAudit,
  RULE_TYPES,
  type DispatchRule,
  type RankResult,
  type RuleMode,
  type RuleType,
} from '../../supabase/functions/_shared/dispatch/rulesEngine';

export type { DispatchRule, RankResult, RankedTechnician, RuleFactor, RuleMode, RuleType } from '../../supabase/functions/_shared/dispatch/rulesEngine';
export { RULE_TYPES };

/**
 * Data access for the Dispatch Rules Engine UI. The ranking itself is the SAME pure module the
 * dispatch-auto-assign edge function runs (supabase/functions/_shared/dispatch/rulesEngine.ts),
 * so what the board explains is exactly what auto-assign does.
 * Schema: supabase/migrations/20271012000000_dispatch_rules_engine.sql.
 */

export interface ParamField {
  key: string;
  label: string;
  kind: 'number' | 'percent' | 'hours' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Only shown for this mode. */
  onlyMode?: RuleMode;
}

export interface RuleMeta {
  title: string;
  description: string;
  defaults: { mode: RuleMode; weight: number; params: Record<string, unknown>; position: number };
  fields: ParamField[];
}

const UNKNOWN_POLICY: ParamField = {
  key: 'unknown_policy', label: 'When data is missing', kind: 'select',
  options: [{ value: 'allow', label: 'Allow technician' }, { value: 'block', label: 'Exclude technician' }],
  onlyMode: 'require',
};

export const RULE_META: Record<RuleType, RuleMeta> = {
  skill_match: {
    title: 'Skill match',
    description: "The technician's listed skills include the job's service type.",
    defaults: { mode: 'require', weight: 30, params: {}, position: 1 },
    fields: [],
  },
  zone: {
    title: 'Zone / territory',
    description: 'The job sits inside the technician’s territory (or their service area).',
    defaults: { mode: 'score', weight: 15, params: { unknown_policy: 'allow' }, position: 2 },
    fields: [UNKNOWN_POLICY],
  },
  vip_priority: {
    title: 'VIP priority',
    description: 'VIP customers get first pick of capacity and the technicians with the cleanest completion record.',
    defaults: { mode: 'score', weight: 25, params: { min_quality: 0.8 }, position: 3 },
    fields: [{ key: 'min_quality', label: 'Minimum clean-completion rate', kind: 'percent', min: 0, max: 100, step: 5, onlyMode: 'require' }],
  },
  max_drive_time: {
    title: 'Max drive time',
    description: 'Estimated drive from the technician’s current (or home) location to the job.',
    defaults: { mode: 'score', weight: 25, params: { max_minutes: 45, avg_speed_mph: 30, unknown_policy: 'allow' }, position: 4 },
    fields: [
      { key: 'max_minutes', label: 'Limit (minutes)', kind: 'number', min: 5, max: 240, step: 5 },
      { key: 'avg_speed_mph', label: 'Average speed (mph)', kind: 'number', min: 10, max: 70, step: 5 },
      UNKNOWN_POLICY,
    ],
  },
  tech_preference: {
    title: 'Technician preferences',
    description: 'Prefer, avoid or require specific technicians for a customer or service type (managed below).',
    defaults: { mode: 'score', weight: 20, params: {}, position: 5 },
    fields: [],
  },
  overtime_limit: {
    title: 'Overtime limit',
    description: 'Keeps a technician’s scheduled hours for the day under your limit.',
    defaults: { mode: 'require', weight: 30, params: { max_daily_minutes: 600, default_job_minutes: 60 }, position: 6 },
    fields: [
      { key: 'max_daily_minutes', label: 'Max scheduled hours per day', kind: 'hours', min: 1, max: 16, step: 0.5 },
      { key: 'default_job_minutes', label: 'Assumed job length when unset (min)', kind: 'number', min: 15, max: 480, step: 15 },
    ],
  },
};

export function draftRule(type: RuleType, saved?: DispatchRule): DispatchRule {
  if (saved) return saved;
  const d = RULE_META[type].defaults;
  return { id: `draft:${type}`, rule_type: type, name: RULE_META[type].title, enabled: false, mode: d.mode, weight: d.weight, params: { ...d.params }, position: d.position };
}

export interface RulesBundle {
  ctx: RulesContext;
  vipIds: Set<string>;
  hasRules: boolean;
}

export async function fetchRulesBundle(ownerId: string, jobs: Record<string, unknown>[]): Promise<RulesBundle> {
  const days = [...new Set(jobs.flatMap((j) => { const d = dayKey(j.scheduled_datetime as string | null); return d ? [d] : []; }))];
  const ctx = await loadRulesContext(supabase, ownerId, days);
  const vipIds = await loadVipCustomerIds(supabase, ownerId, jobs.map((j) => j.customer_id as string).filter(Boolean));
  return { ctx, vipIds, hasRules: ctx.rules.some((r) => r.enabled) };
}

/** Same call the edge function makes — one job against the loaded context. */
export function rankJob(job: Record<string, unknown>, bundle: RulesBundle): RankResult {
  const engineJob = toEngineJob(job, bundle.vipIds);
  const day = dayKey(job.scheduled_datetime as string | null) ?? dayKey(new Date().toISOString())!;
  return rankTechnicians({
    job: engineJob,
    technicians: bundle.ctx.technicians,
    rules: bundle.ctx.rules,
    territories: bundle.ctx.territories,
    preferences: bundle.ctx.preferences,
    loads: loadsForDay(bundle.ctx.openJobs, day, engineJob.id),
  });
}

export async function saveRule(ownerId: string, rule: DispatchRule): Promise<void> {
  const { error } = await supabase.from('dispatch_rules').upsert(
    {
      user_id: ownerId,
      rule_type: rule.rule_type,
      name: rule.name,
      enabled: rule.enabled,
      mode: rule.mode,
      weight: Math.round(Math.min(100, Math.max(0, rule.weight))),
      params: rule.params,
      position: rule.position,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,rule_type' },
  );
  if (error) throw new Error(error.message);
}

export interface PreferenceRow {
  id: string;
  technician_id: string;
  customer_id: string | null;
  customer_name: string | null;
  service_type: string | null;
  preference: 'prefer' | 'avoid' | 'require';
  note: string | null;
}

export async function fetchPreferences(ownerId: string): Promise<PreferenceRow[]> {
  const { data, error } = await supabase
    .from('dispatch_technician_preferences')
    .select('id, technician_id, customer_id, service_type, preference, note, customers(name)')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as (Omit<PreferenceRow, 'customer_name'> & { customers: { name: string } | { name: string }[] | null })[]).map((r) => {
    const c = Array.isArray(r.customers) ? r.customers[0] : r.customers;
    return { id: r.id, technician_id: r.technician_id, customer_id: r.customer_id, customer_name: c?.name ?? null, service_type: r.service_type, preference: r.preference, note: r.note };
  });
}

export async function addPreference(
  ownerId: string,
  p: { technician_id: string; customer_id: string | null; service_type: string | null; preference: 'prefer' | 'avoid' | 'require'; note?: string },
): Promise<void> {
  const { error } = await supabase.from('dispatch_technician_preferences').insert({
    user_id: ownerId, technician_id: p.technician_id, customer_id: p.customer_id, service_type: p.service_type?.trim() || null, preference: p.preference, note: p.note?.trim() || null,
  });
  if (error) throw new Error(error.code === '23505' ? 'That preference already exists.' : error.message);
}

export async function deletePreference(id: string): Promise<void> {
  const { error } = await supabase.from('dispatch_technician_preferences').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function searchCustomers(ownerId: string, q: string): Promise<{ id: string; name: string }[]> {
  const term = q.trim().replace(/[%,()]/g, ' ');
  if (term.length < 2) return [];
  const { data } = await supabase.from('customers').select('id, name').eq('user_id', ownerId).ilike('name', `%${term}%`).order('name').limit(8);
  return (data ?? []) as { id: string; name: string }[];
}

export interface DecisionRow {
  id: string;
  job_id: string;
  technician_id: string | null;
  recommended_technician_id: string | null;
  mode: 'auto' | 'manual' | 'override' | 'no_eligible';
  score: number | null;
  note: string | null;
  created_at: string;
  explanation: { candidates?: { technician_id: string; name: string; summary: string }[] };
  job: { customer_name: string | null; service_type: string | null } | null;
}

export async function fetchDecisions(ownerId: string, limit = 25): Promise<DecisionRow[]> {
  const { data, error } = await supabase
    .from('dispatch_decisions')
    .select('id, job_id, technician_id, recommended_technician_id, mode, score, note, created_at, explanation, jobs(customer_name, service_type)')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as (Omit<DecisionRow, 'job'> & { jobs: DecisionRow['job'] | DecisionRow['job'][] })[]).map((r) => {
    const { jobs, ...rest } = r;
    return { ...rest, job: Array.isArray(jobs) ? jobs[0] ?? null : jobs ?? null };
  });
}

/** Human picked a technician on the board. 'manual' = engine's own top pick, 'override' = anyone else. */
export async function recordManualDecision(
  ownerId: string,
  p: { jobId: string; technicianId: string; ranking: RankResult; reason?: string },
): Promise<void> {
  const best = p.ranking.best;
  const chosen = p.ranking.ranked.find((r) => r.technician_id === p.technicianId);
  const isOverride = !best || best.technician_id !== p.technicianId;
  const parts = [
    p.reason?.trim() ? `Reason: ${p.reason.trim()}` : '',
    chosen && !chosen.eligible ? `Violated rules: ${chosen.blocked_by.join('; ')}` : '',
  ].filter(Boolean);
  const { error } = await supabase.from('dispatch_decisions').insert({
    user_id: ownerId,
    job_id: p.jobId,
    technician_id: p.technicianId,
    recommended_technician_id: best?.technician_id ?? null,
    mode: isOverride ? 'override' : 'manual',
    score: chosen?.score ?? null,
    explanation: { rules_applied: p.ranking.rules_applied, margin: p.ranking.margin, candidates: snapshotForAudit(p.ranking) },
    note: parts.join(' | ').slice(0, 900) || null,
  });
  if (error) console.error('dispatch decision log failed', error.message);
}
