/**
 * Callback Promise — data access.
 *
 * Thin wrappers over supabase/migrations/20290312000000_callback_promise.sql. All shaping and validation live in
 * callbackPromise.ts (pure, tested). Every function throws an Error with a readable message; the UI decides how to show it.
 */

import { supabase } from '@/lib/supabase';
import {
  UNCONFIGURED_SETTINGS,
  mapSettingsRow,
  mapStatsRow,
  validateSettings,
  type CallbackPromiseSettings,
  type CallbackStats,
} from '@/lib/callbackPromise';

export const CALLBACK_STATS_WINDOW_DAYS = 30;

export async function loadCallbackSettings(): Promise<CallbackPromiseSettings> {
  const { data, error } = await supabase
    .from('callback_promise_settings')
    .select('enabled, window_minutes, escalate_after_minutes, public_stat_opt_in, public_stat_min_cases')
    .maybeSingle();
  if (error) throw new Error(`Could not load the callback promise: ${error.message}`);
  return data ? mapSettingsRow(data) : UNCONFIGURED_SETTINGS;
}

export async function saveCallbackSettings(s: CallbackPromiseSettings): Promise<void> {
  const problems = validateSettings(s);
  if (problems.length > 0) throw new Error(problems[0]);
  const { error } = await supabase.rpc('callback_promise_save_settings', {
    p_enabled: s.enabled,
    p_window_minutes: s.windowMinutes,
    p_escalate_after_minutes: s.escalateAfterMinutes,
    p_public_stat_opt_in: s.publicStatOptIn,
    p_public_stat_min_cases: s.publicStatMinCases,
  });
  if (error) throw new Error(error.message || 'Could not save the callback promise.');
}

export async function loadCallbackStats(days = CALLBACK_STATS_WINDOW_DAYS): Promise<CallbackStats> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc('callback_promise_stats', { p_since: since });
  if (error) throw new Error(`Could not load callback numbers: ${error.message}`);
  return mapStatsRow(data);
}
