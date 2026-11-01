/**
 * Voice Brand — data access. Every call is scoped by the account owner id AND
 * protected by RLS (see 20280401000000_voice_brand.sql).
 */

import { supabase } from '@/lib/supabase';
import { toEvalCaseInputs } from '../../supabase/functions/_shared/voice-brand/golden';

export const VOICE_SUITE_NAME = 'Voice Brand Golden';

export async function fetchScriptOverrides(ownerId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('voice_script_overrides').select('template_id, body').eq('user_id', ownerId);
  if (error) throw new Error('Could not load your custom scripts.');
  return Object.fromEntries((data ?? []).map((r: { template_id: string; body: string }) => [r.template_id, r.body]));
}

export async function saveScriptOverride(ownerId: string, userId: string, templateId: string, body: string): Promise<void> {
  const { error } = await supabase
    .from('voice_script_overrides')
    .upsert({ user_id: ownerId, template_id: templateId, body: body.trim(), updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'user_id,template_id' });
  if (error) throw new Error(error.code === '42501' ? "You don't have permission to edit scripts." : 'Could not save this script.');
}

export async function deleteScriptOverride(ownerId: string, templateId: string): Promise<void> {
  const { error } = await supabase.from('voice_script_overrides').delete().eq('user_id', ownerId).eq('template_id', templateId);
  if (error) throw new Error('Could not reset this script.');
}

/** Creates (once) the golden voice-eval suite used by the nightly AI Regression workflow. */
export async function seedVoiceEvalSuite(ownerId: string, userId: string): Promise<{ suiteId: string; created: boolean }> {
  const existing = await supabase.from('ai_eval_suites').select('id').eq('account_id', ownerId).eq('name', VOICE_SUITE_NAME).maybeSingle();
  if (existing.error) throw new Error('Could not check existing eval suites.');
  if (existing.data) return { suiteId: (existing.data as { id: string }).id, created: false };

  const suite = await supabase
    .from('ai_eval_suites')
    .insert({ account_id: ownerId, name: VOICE_SUITE_NAME, task: 'demo_chat', description: "Sarah's tone, brevity, disclosure and safety rules (golden conversations).", created_by: userId })
    .select('id')
    .single();
  if (suite.error || !suite.data) throw new Error("Only owners/admins can create the eval suite.");
  const suiteId = (suite.data as { id: string }).id;

  const rows = toEvalCaseInputs().map((c) => ({ suite_id: suiteId, name: c.id, user_message: c.userMessage, json_mode: false, assertions: c.assertions }));
  const cases = await supabase.from('ai_eval_cases').insert(rows);
  if (cases.error) {
    await supabase.from('ai_eval_suites').delete().eq('id', suiteId); // no half-created suite
    throw new Error('Could not create the eval cases.');
  }
  return { suiteId, created: true };
}

export interface LatencyRow { p50_ms: number | null; p95_ms: number | null; within_budget: boolean; turn_count: number }

export async function fetchLatencySummary(ownerId: string, days = 30): Promise<{ calls: number; withinBudgetPct: number | null; avgP95: number | null }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('voice_call_latency')
    .select('p50_ms, p95_ms, within_budget, turn_count')
    .eq('user_id', ownerId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error('Could not load latency data.');
  const rows = (data ?? []) as LatencyRow[];
  if (!rows.length) return { calls: 0, withinBudgetPct: null, avgP95: null };
  const p95s = rows.map((r) => r.p95_ms).filter((v): v is number => typeof v === 'number');
  return {
    calls: rows.length,
    withinBudgetPct: Math.round((rows.filter((r) => r.within_budget).length / rows.length) * 100),
    avgP95: p95s.length ? Math.round(p95s.reduce((a, b) => a + b, 0) / p95s.length) : null,
  };
}
