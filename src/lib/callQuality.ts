/**
 * AI Quality Center — client library.
 *
 *   Tables / RPCs: supabase/migrations/20271102000000_ai_quality_center.sql
 *   Reviewer:      supabase/functions/call-quality-review
 *   Pure rules:    supabase/functions/_shared/call-quality/logic.ts (shared, unit-tested)
 *
 * Access: owner, or a team member with can_edit_business_profile (the DB gate
 * is can_edit_call_scripts(), same as Call Scripts). Reviews, findings and fixes
 * are read-only for the browser; changes go through RPCs / the Edge Function.
 */

import { supabase } from '@/lib/supabase';
import type {
  AppliesWhen,
  FindingKind,
  FixProposal,
  FixType,
  RuleType,
  ScoredPoint,
  Severity,
} from '../../supabase/functions/_shared/call-quality/logic';

export * from '../../supabase/functions/_shared/call-quality/logic';
export { SCENARIOS, scenarioLabel } from '../../supabase/functions/_shared/call-scripts/logic';

// ============================================================
// TYPES
// ============================================================

export interface QualityReviewRow {
  review_id: string;
  call_id: string;
  call_at: string;
  caller_name: string | null;
  caller_phone: string | null;
  duration_seconds: number | null;
  is_emergency: boolean;
  scenario: string | null;
  overall_score: number | null;
  accuracy_score: number | null;
  compliance_score: number | null;
  booking_score: number | null;
  upsell_score: number | null;
  experience_score: number | null;
  ai_status: 'ok' | 'skipped' | 'failed';
  summary: string | null;
  compliance: { rule_id: string; label: string; status: 'pass' | 'fail' | 'na' | 'unknown'; severity: Severity }[];
  feedback_rating: number | null;
  feedback_comment: string | null;
  open_findings: number;
  reviewed_at: string;
}

export interface QualityFinding {
  id: string;
  review_id: string;
  call_id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  evidence_quote: string | null;
  turn_index: number | null;
  status: 'open' | 'fixed' | 'dismissed';
  created_at: string;
}

export interface QualityFix {
  id: string;
  finding_id: string | null;
  fix_type: FixType;
  scenario: string | null;
  proposal: FixProposal;
  rationale: string | null;
  evidence_count: number;
  status: 'proposed' | 'applied' | 'rejected';
  created_at: string;
  applied_at: string | null;
  result: Record<string, unknown> | null;
}

export interface QualityRule {
  id: string;
  label: string;
  rule_type: RuleType;
  patterns: string[];
  applies_when: AppliesWhen;
  severity: Severity;
  script_instruction: string | null;
  enabled: boolean;
}

export interface CopilotStats {
  sessions: number;
  escalated: number;
  emergency: number;
  turns: number;
  avg_confidence: number | null;
  low_confidence_turns: number;
  top_missing_info: { text: string; count: number }[];
  flagged_sessions: { id: string; created_at: string; status: string; max_severity: string; turn_count: number; job_id: string | null; min_confidence: number | null }[];
}

export interface QualityOverview {
  coverage: { calls: number; eligible: number; reviewed: number };
  copilot: CopilotStats;
}

export interface ReviewRunResult {
  reviewed: number;
  skipped: number;
  failed: number;
  remaining: number;
}

export interface ApplyResult {
  type: FixType;
  changed?: boolean;
  live?: boolean;
  updated_existing?: boolean;
  article_id?: string;
  findings_resolved: number;
}

// ============================================================
// HELPERS
// ============================================================

/** Postgres / Edge Function errors → one readable sentence. */
export async function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  const e = error as { message?: unknown; code?: unknown } | null;
  if (e?.code === '42501') return "You don't have permission to do this.";
  if (e?.code === '23505') return 'That already exists.';
  if (typeof e?.message === 'string' && e.message && !/^(TypeError|FetchError)/.test(e.message)) return e.message;
  return fallback;
}

export const toScoredPoint = (r: QualityReviewRow): ScoredPoint => ({
  at: r.call_at,
  overall: r.overall_score,
  accuracy: r.accuracy_score,
  compliance: r.compliance_score,
  booking: r.booking_score,
  experience: r.experience_score,
  upsell: r.upsell_score,
});

// ============================================================
// READS
// ============================================================

export async function fetchFeed(fromIso: string, toIso: string, limit = 1500): Promise<QualityReviewRow[]> {
  const { data, error } = await supabase.rpc('get_ai_quality_feed', { p_from: fromIso, p_to: toIso, p_limit: limit });
  if (error) throw error;
  return (data as QualityReviewRow[]) ?? [];
}

export async function fetchOverview(fromIso: string, toIso: string): Promise<QualityOverview> {
  const { data, error } = await supabase.rpc('get_ai_quality_overview', { p_from: fromIso, p_to: toIso });
  if (error) throw error;
  return data as QualityOverview;
}

export async function fetchFindings(status: 'open' | 'all' = 'open', limit = 300): Promise<QualityFinding[]> {
  let q = supabase
    .from('ai_quality_findings')
    .select('id, review_id, call_id, kind, severity, title, detail, evidence_quote, turn_index, status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status === 'open') q = q.eq('status', 'open');
  const { data, error } = await q;
  if (error) throw error;
  return (data as QualityFinding[]) ?? [];
}

export async function fetchFixes(status: 'proposed' | 'applied' = 'proposed', limit = 100): Promise<QualityFix[]> {
  const { data, error } = await supabase
    .from('ai_quality_fixes')
    .select('id, finding_id, fix_type, scenario, proposal, rationale, evidence_count, status, created_at, applied_at, result')
    .eq('status', status)
    .order('evidence_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as QualityFix[]) ?? [];
}

// ============================================================
// ACTIONS
// ============================================================

/** Reviews calls that have no scorecard yet (or the given ones). Each request handles at most 8 calls. */
export async function runReview(input: { callIds?: string[]; backfill?: boolean; days?: number; limit?: number; force?: boolean }): Promise<ReviewRunResult> {
  const { data, error } = await supabase.functions.invoke('call-quality-review', { body: input });
  if (error) throw new Error(await friendlyError(error, 'Could not reach the quality reviewer. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.error));
  return data as ReviewRunResult;
}

export async function applyFix(fixId: string, overrides?: { answer?: string; title?: string; addition?: string; scenario?: string }): Promise<ApplyResult> {
  const { data, error } = await supabase.rpc('apply_ai_quality_fix', { p_fix_id: fixId, p_overrides: overrides ?? null });
  if (error) throw new Error(await friendlyError(error));
  return data as ApplyResult;
}

export async function rejectFix(fixId: string): Promise<void> {
  const { error } = await supabase.rpc('reject_ai_quality_fix', { p_fix_id: fixId });
  if (error) throw new Error(await friendlyError(error));
}

export async function setFindingStatus(findingId: string, status: 'open' | 'dismissed'): Promise<void> {
  const { error } = await supabase.rpc('set_ai_quality_finding_status', { p_finding_id: findingId, p_status: status });
  if (error) throw new Error(await friendlyError(error));
}

// ============================================================
// COMPLIANCE RULES
// ============================================================

export async function ensureDefaultRules(): Promise<void> {
  const { error } = await supabase.rpc('ensure_ai_quality_default_rules');
  if (error) throw new Error(await friendlyError(error));
}

export async function fetchRules(): Promise<QualityRule[]> {
  const { data, error } = await supabase
    .from('ai_quality_rules')
    .select('id, label, rule_type, patterns, applies_when, severity, script_instruction, enabled')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as QualityRule[]) ?? [];
}

export type RuleInput = Omit<QualityRule, 'id'>;

export async function saveRule(id: string | null, input: RuleInput): Promise<void> {
  const row = {
    label: input.label.trim(),
    rule_type: input.rule_type,
    patterns: input.patterns,
    applies_when: input.applies_when,
    severity: input.severity,
    script_instruction: input.script_instruction?.trim() || null,
    enabled: input.enabled,
  };
  const res = id ? await supabase.from('ai_quality_rules').update(row).eq('id', id) : await supabase.from('ai_quality_rules').insert(row);
  if (res.error) {
    if ((res.error as { code?: string }).code === '23505') throw new Error('You already have a rule with this name.');
    throw new Error(await friendlyError(res.error));
  }
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('ai_quality_rules').update({ enabled }).eq('id', id);
  if (error) throw new Error(await friendlyError(error));
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from('ai_quality_rules').delete().eq('id', id);
  if (error) throw new Error(await friendlyError(error));
}
