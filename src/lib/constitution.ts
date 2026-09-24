import { supabase } from '@/lib/supabase';

export type RuleType = 'no_campaign_if_sla_at_risk' | 'no_vip_cancel_without_human_contact' | 'protect_margin_floor' | 'ai_cannot_handle_unhappy_alone' | 'custom';

export interface ConstitutionArticle {
  id: string;
  rule_type: RuleType;
  title: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export interface ConstitutionViolation {
  id: string;
  article_id: string;
  action_type: string;
  reason: string;
  blocked_at: string;
  overridden: boolean;
}

export interface ConstitutionCheckResult {
  allowed: boolean;
  article_id: string | null;
  article_title: string | null;
  reason: string | null;
}

export const RULE_TEMPLATES: { rule_type: RuleType; label: string; paramLabel?: string; paramKey?: string; defaultValue?: number }[] = [
  { rule_type: 'no_campaign_if_sla_at_risk', label: 'Never increase demand campaigns while an SLA is at risk.' },
  { rule_type: 'no_vip_cancel_without_human_contact', label: 'Never cancel a VIP customer without recent human contact.', paramLabel: 'Contact window (hours)', paramKey: 'contact_window_hours', defaultValue: 48 },
  { rule_type: 'protect_margin_floor', label: 'Never discount more than X%, even to grow revenue.', paramLabel: 'Max discount (%)', paramKey: 'max_discount_pct', defaultValue: 15 },
  { rule_type: 'ai_cannot_handle_unhappy_alone', label: 'AI may not handle an unhappy customer with automated messages alone.' },
];

export async function fetchArticles(): Promise<ConstitutionArticle[]> {
  const { data, error } = await supabase.from('constitution_articles').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as ConstitutionArticle[]) ?? [];
}

export async function createArticle(ruleType: RuleType, parameters: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('create_constitution_article', { p_rule_type: ruleType, p_parameters: parameters });
  if (error) throw error;
}

export async function toggleArticle(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('constitution_articles').update({ enabled }).eq('id', id);
  if (error) throw error;
}

export async function deleteArticle(id: string): Promise<void> {
  const { error } = await supabase.from('constitution_articles').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchViolations(): Promise<ConstitutionViolation[]> {
  const { data, error } = await supabase.from('constitution_violations').select('*').order('blocked_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data as ConstitutionViolation[]) ?? [];
}

export async function overrideViolation(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('override_constitution_violation', { p_violation_id: id, p_reason: reason });
  if (error) throw error;
}

/**
 * Call this from ANY action point before it executes something the
 * constitution might govern. e.g.:
 *   const check = await checkConstitution(userId, 'apply_discount', { discount_percent: 25 });
 *   if (!check.allowed) { toast(check.reason, 'error'); return; }
 */
export async function checkConstitution(userId: string, actionType: string, context: Record<string, unknown> = {}): Promise<ConstitutionCheckResult> {
  const { data, error } = await supabase.rpc('check_constitution', { p_user_id: userId, p_action_type: actionType, p_context: context });
  if (error) throw error;
  return (data?.[0] as ConstitutionCheckResult) ?? { allowed: true, article_id: null, article_title: null, reason: null };
}
