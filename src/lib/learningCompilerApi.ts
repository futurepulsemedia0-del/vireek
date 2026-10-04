/**
 * Learning Compiler — data layer. Reads job_outcomes, runs the pure compiler
 * (learningCompiler.ts) and persists proposals through RPCs. Clients cannot
 * write the tables directly; every state change is audited server-side.
 */
import { supabase } from '@/lib/supabase';
import {
  COMPILER,
  checkPolicies,
  compileLearning,
  evaluatePolicy,
  observe,
  type CompileResult,
  type Enforcement,
  type LearnedPolicy,
  type OutcomeRow,
  type PolicyCheckContext,
  type PolicyEvaluation,
  type PolicyMatch,
} from '@/lib/learningCompiler';

const DAY_MS = 86_400_000;
const PAGE = 1000;
const MAX_ROWS = 10_000;

const OUTCOME_COLUMNS =
  'job_id, job_type_key, resolution, caused_callback, is_rework, technician_id, root_cause_key, parts_used, checklist_done, checklist_total, recorded_at';

/** Pages through job_outcomes (PostgREST caps a single response at 1000 rows). */
export async function gatherOutcomes(): Promise<OutcomeRow[]> {
  const since = new Date(Date.now() - COMPILER.windowDays * DAY_MS).toISOString();
  const rows: OutcomeRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('job_outcomes')
      .select(OUTCOME_COLUMNS)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as OutcomeRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

export async function fetchTechnicianNames(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('team_members').select('id, member_name');
  if (error) throw error;
  return new Map((data ?? []).map((t: { id: string; member_name: string | null }) => [t.id, t.member_name ?? 'Technician']));
}

export async function fetchLearnedPolicies(): Promise<LearnedPolicy[]> {
  const { data, error } = await supabase
    .from('learned_policies')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as LearnedPolicy[];
}

export interface CompilerRunSummary {
  result: CompileResult;
  saved: { inserted: number; refreshed: number; superseded: number };
}

/** Owner only: compile from experience and store the proposals for human review. */
export async function runCompiler(): Promise<CompilerRunSummary> {
  const [outcomes, names] = await Promise.all([gatherOutcomes(), fetchTechnicianNames()]);
  const result = compileLearning(outcomes, {
    technicianName: (id) => names.get(id) ?? 'this technician',
  });
  const { data, error } = await supabase.rpc('record_learning_run', {
    p_policies: result.policies,
    p_supported_facets: result.policies.map((p) => p.facet),
  });
  if (error) throw error;
  const saved = (data ?? { inserted: 0, refreshed: 0, superseded: 0 }) as CompilerRunSummary['saved'];
  return { result, saved };
}

export async function decidePolicy(
  id: string,
  decision: 'approve' | 'reject' | 'retire',
  options: { enforcement?: Enforcement; note?: string } = {},
): Promise<void> {
  const { error } = await supabase.rpc('decide_learned_policy', {
    p_id: id,
    p_decision: decision,
    p_enforcement: options.enforcement ?? 'advise',
    p_note: options.note?.trim() || null,
  });
  if (error) throw error;
}

/** Owner only: measures every active policy against jobs recorded since activation. */
export async function evaluateActivePolicies(policies: LearnedPolicy[]): Promise<Map<string, PolicyEvaluation>> {
  const active = policies.filter((p) => p.status === 'active');
  const results = new Map<string, PolicyEvaluation>();
  if (active.length === 0) return results;

  const observations = observe(await gatherOutcomes());
  for (const policy of active) {
    const evaluation = evaluatePolicy(policy, observations);
    const { error } = await supabase.rpc('record_policy_evaluation', { p_id: policy.id, p_evaluation: evaluation });
    if (error) throw error;
    results.set(policy.id, evaluation);
  }
  return results;
}

// ---------------------------------------------------------------
// Runtime guard for dispatch, agents and workflows
// ---------------------------------------------------------------

const GUARD_TTL_MS = 60_000;
let guardCache: { at: number; policies: LearnedPolicy[] } | null = null;

async function activePolicies(): Promise<LearnedPolicy[]> {
  if (guardCache && Date.now() - guardCache.at < GUARD_TTL_MS) return guardCache.policies;
  const { data, error } = await supabase.from('learned_policies').select('*').eq('status', 'active').limit(300);
  if (error) throw error;
  const policies = (data ?? []) as LearnedPolicy[];
  guardCache = { at: Date.now(), policies };
  return policies;
}

/** Call before assigning, quoting or closing a job. Returns every active policy that applies. */
export async function checkLearnedPolicies(ctx: PolicyCheckContext): Promise<PolicyMatch[]> {
  return checkPolicies(ctx, await activePolicies());
}

export function invalidateLearnedPolicyCache(): void {
  guardCache = null;
}

export interface PolicyEvent {
  id: string;
  event: 'proposed' | 'approved' | 'rejected' | 'retired' | 'evaluated';
  note: string | null;
  created_at: string;
}

export async function fetchPolicyEvents(policyId: string): Promise<PolicyEvent[]> {
  const { data, error } = await supabase
    .from('learned_policy_events')
    .select('id, event, note, created_at')
    .eq('policy_id', policyId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as PolicyEvent[];
}
