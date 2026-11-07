/**
 * Near-tie randomization — data access (owner page + experiment analysis).
 * Scoping, the immutable salt and the append-only audit trail are enforced by the database
 * (20271201000000_dispatch_near_tie_randomization.sql). The salt is never selected here.
 */
import { supabase } from '@/lib/supabase';
import type { DecisionRow } from '@/lib/naturalRandomization';

export interface RandomizationSettingsRow {
  enabled: boolean;
  epsilon: number;
  top_k: number;
  max_eta_delta_minutes: number;
  excluded_service_types: string[];
  updated_at: string | null;
}

export const DEFAULT_SETTINGS: RandomizationSettingsRow = { enabled: false, epsilon: 0.5, top_k: 2, max_eta_delta_minutes: 10, excluded_service_types: [], updated_at: null };

export interface AuditRow {
  id: string;
  action: 'insert' | 'update';
  actor: string | null;
  created_at: string;
  before: Partial<RandomizationSettingsRow> | null;
  after: Partial<RandomizationSettingsRow>;
}

const PAGE = 1000;
const MAX_ROWS = 20000;

export async function fetchSettings(ownerId: string): Promise<RandomizationSettingsRow> {
  const { data, error } = await supabase
    .from('dispatch_randomization_settings')
    .select('enabled, epsilon, top_k, max_eta_delta_minutes, excluded_service_types, updated_at')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return DEFAULT_SETTINGS;
  const r = data as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    epsilon: Number(r.epsilon),
    top_k: Number(r.top_k),
    max_eta_delta_minutes: Number(r.max_eta_delta_minutes),
    excluded_service_types: Array.isArray(r.excluded_service_types) ? (r.excluded_service_types as string[]) : [],
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
  };
}

/** Insert-or-update. The server keeps the salt, stamps who/when and writes the audit row. */
export async function saveSettings(ownerId: string, s: Omit<RandomizationSettingsRow, 'updated_at'>): Promise<void> {
  const { error } = await supabase.from('dispatch_randomization_settings').upsert(
    {
      user_id: ownerId,
      enabled: s.enabled,
      epsilon: s.epsilon,
      top_k: s.top_k,
      max_eta_delta_minutes: s.max_eta_delta_minutes,
      excluded_service_types: s.excluded_service_types.map((x) => x.trim().toLowerCase()).filter(Boolean),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

/** Instant kill switch: touches only `enabled`. */
export async function switchOff(ownerId: string): Promise<void> {
  const { data, error } = await supabase.from('dispatch_randomization_settings').update({ enabled: false }).eq('user_id', ownerId).select('user_id');
  if (error) throw error;
  if (!data || data.length === 0) return; // no row => already off
}

export async function fetchAudit(ownerId: string, limit = 25): Promise<AuditRow[]> {
  const { data, error } = await supabase
    .from('dispatch_randomization_audit')
    .select('id, action, actor, created_at, before, after')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as AuditRow[]) ?? [];
}

/** Auto decisions that carry a randomization record since `sinceIso` (paged, capped). */
export async function fetchRandomizedDecisions(ownerId: string, sinceIso: string): Promise<DecisionRow[]> {
  const rows: DecisionRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('dispatch_decisions')
      .select('job_id, created_at, explanation')
      .eq('user_id', ownerId)
      .eq('mode', 'auto')
      .not('explanation->randomization', 'is', null)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as unknown as DecisionRow[]) ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}
