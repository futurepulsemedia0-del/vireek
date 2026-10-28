/**
 * Dynamic Number Insertion — API layer. Every query is scoped by account_owner_id (RLS enforces it again server-side).
 */

import { supabase } from '@/lib/supabase';
import {
  normalizeE164,
  parseDomains,
  slugifySourceKey,
  type ClassificationPreview,
  type DniNumberRow,
  type DniPerformance,
  type DniRuleRow,
  type DniSettingsRow,
  type MatchField,
  type MatchOp,
  type NumberKind,
} from '@/lib/dynamicNumbers';

const SETTINGS_COLS = 'account_owner_id, public_key, enabled, default_number, allowed_domains, lease_minutes, last_seen_at, last_seen_host';
const NUMBER_COLS = 'id, phone_e164, vapi_phone_number_id, label, kind, source_key, active, lease_until';
const RULE_COLS = 'id, priority, match_field, match_op, match_value, source_key, source_label, enabled';

export async function fetchSettings(owner: string): Promise<DniSettingsRow | null> {
  const { data, error } = await supabase.from('dni_settings').select(SETTINGS_COLS).eq('account_owner_id', owner).maybeSingle();
  if (error) throw error;
  return (data as DniSettingsRow | null) ?? null;
}

export async function saveSettings(
  owner: string,
  s: { enabled: boolean; defaultNumber: string; domainsText: string; leaseMinutes: number },
): Promise<DniSettingsRow> {
  const { data, error } = await supabase
    .from('dni_settings')
    .upsert(
      {
        account_owner_id: owner,
        enabled: s.enabled,
        default_number: normalizeE164(s.defaultNumber),
        allowed_domains: parseDomains(s.domainsText).domains,
        lease_minutes: s.leaseMinutes,
      },
      { onConflict: 'account_owner_id' },
    )
    .select(SETTINGS_COLS)
    .single();
  if (error) throw error;
  return data as DniSettingsRow;
}

export async function rotateKey(): Promise<string> {
  const { data, error } = await supabase.rpc('dni_rotate_key');
  if (error) throw error;
  return data as string;
}

export async function fetchNumbers(owner: string): Promise<DniNumberRow[]> {
  const { data, error } = await supabase.from('dni_numbers').select(NUMBER_COLS).eq('account_owner_id', owner).order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DniNumberRow[];
}

export async function addNumber(
  owner: string,
  n: { kind: NumberKind; phone: string; sourceKey: string; label: string; vapiId: string },
): Promise<DniNumberRow> {
  const phone = normalizeE164(n.phone);
  if (!phone) throw new Error('Invalid phone number');
  const { data, error } = await supabase
    .from('dni_numbers')
    .insert({
      account_owner_id: owner,
      phone_e164: phone,
      kind: n.kind,
      source_key: n.kind === 'source' ? n.sourceKey : null,
      label: n.label.trim(),
      vapi_phone_number_id: n.vapiId.trim() || null,
    })
    .select(NUMBER_COLS)
    .single();
  if (error) throw error;
  return data as DniNumberRow;
}

export async function setNumberActive(owner: string, id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('dni_numbers').update({ active }).eq('id', id).eq('account_owner_id', owner);
  if (error) throw error;
}

export async function deleteNumber(owner: string, id: string): Promise<void> {
  const { error } = await supabase.from('dni_numbers').delete().eq('id', id).eq('account_owner_id', owner);
  if (error) throw error;
}

export async function fetchRules(owner: string): Promise<DniRuleRow[]> {
  const { data, error } = await supabase.from('dni_source_rules').select(RULE_COLS).eq('account_owner_id', owner).order('priority', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DniRuleRow[];
}

export async function addRule(
  owner: string,
  r: { field: MatchField; op: MatchOp; value: string; sourceLabel: string; priority: number },
): Promise<DniRuleRow> {
  const { data, error } = await supabase
    .from('dni_source_rules')
    .insert({
      account_owner_id: owner,
      priority: r.priority,
      match_field: r.field,
      match_op: r.op,
      match_value: r.op === 'present' ? null : r.value.trim(),
      source_key: slugifySourceKey(r.sourceLabel),
      source_label: r.sourceLabel.trim(),
    })
    .select(RULE_COLS)
    .single();
  if (error) throw error;
  return data as DniRuleRow;
}

export async function setRuleEnabled(owner: string, id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('dni_source_rules').update({ enabled }).eq('id', id).eq('account_owner_id', owner);
  if (error) throw error;
}

export async function deleteRule(owner: string, id: string): Promise<void> {
  const { error } = await supabase.from('dni_source_rules').delete().eq('id', id).eq('account_owner_id', owner);
  if (error) throw error;
}

export async function fetchPerformance(days: number): Promise<DniPerformance> {
  const { data, error } = await supabase.rpc('dni_performance', { p_days: days });
  if (error) throw error;
  return data as DniPerformance;
}

export async function previewClassification(signals: Record<string, string>, siteHost: string | null): Promise<ClassificationPreview> {
  const { data, error } = await supabase.rpc('dni_preview_classification', { p_signals: signals, p_site_host: siteHost });
  if (error) throw error;
  return data as ClassificationPreview;
}
