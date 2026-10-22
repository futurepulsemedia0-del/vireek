/**
 * Rescue Loop — data access.
 *
 * Thin wrappers over the owner-scoped RPCs in
 * supabase/migrations/20271011000000_rescue_loop_sla.sql. All shaping lives
 * in rescueLoop.ts (pure, tested). Every function throws an Error with a
 * readable message on failure; the page decides how to show it.
 */

import { supabase } from '@/lib/supabase';
import {
  DEFAULT_SLA_SETTINGS,
  mapCaseRow,
  mapEventRow,
  mapSettingsRow,
  normalizeSlaLimit,
  type RescueCase,
  type RescueEvent,
  type RescueSlaSettings,
} from '@/lib/rescueLoop';

export const RESCUE_WINDOW_DAYS = 30;
const MAX_EVENT_IDS = 100;

export async function loadRescueSettings(): Promise<RescueSlaSettings> {
  const { data, error } = await supabase
    .from('rescue_sla_settings')
    .select('first_response_limit_seconds, alerts_enabled, excuse_quiet_hours')
    .maybeSingle();
  if (error) throw new Error(`Could not load SLA settings: ${error.message}`);
  return data ? mapSettingsRow(data as Record<string, unknown>) : DEFAULT_SLA_SETTINGS;
}

export async function saveRescueSettings(s: RescueSlaSettings): Promise<void> {
  const { error } = await supabase.rpc('rescue_save_sla_settings', {
    p_limit_seconds: normalizeSlaLimit(s.firstResponseLimitSeconds),
    p_alerts_enabled: s.alertsEnabled,
    p_excuse_quiet_hours: s.excuseQuietHours,
  });
  if (error) throw new Error(error.message || 'Could not save the SLA settings.');
}

export async function loadRescueCases(days = RESCUE_WINDOW_DAYS, limit = 200): Promise<RescueCase[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc('rescue_loop_cases', { p_since: since, p_limit: limit });
  if (error) throw new Error(`Could not load missed calls: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return rows.map(mapCaseRow).filter((c): c is RescueCase => c !== null);
}

export async function loadRescueEvents(callIds: string[]): Promise<RescueEvent[]> {
  const ids = [...new Set(callIds)].slice(0, MAX_EVENT_IDS);
  if (ids.length === 0) return [];
  const { data, error } = await supabase.rpc('rescue_loop_events', { p_call_ids: ids });
  if (error) throw new Error(`Could not load the timeline: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return rows.map(mapEventRow).filter((e): e is RescueEvent => e !== null);
}
