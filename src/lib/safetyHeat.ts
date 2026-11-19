// src/lib/safetyHeat.ts
// Thin client for the heat-index reminders (migration 20290310000000_safety_heat_index.sql, edge function safety-heat-tick).
// All decisions live in src/lib/safety/heat.ts; all writes go through SECURITY DEFINER RPCs that check the caller.

import { supabase } from '@/lib/supabase';
import { HEAT_TIERS, type HeatIntervals, type HeatTier } from '@/lib/safety/heat';

export interface HeatSettings {
  enabled: boolean;
  water_every_min: Record<HeatTier, number>;
  rest_every_min: Record<HeatTier, number>;
  my_opted_in: boolean;
  is_team_member: boolean;
  can_manage: boolean;
}

export interface HeatWatchView {
  id: string;
  zip: string;
  tier: HeatTier;
  started_at: string;
  last_checked_at: string | null;
  last_observed_at: string | null;
  temp_f: number | null;
  rh: number | null;
  heat_index_f: number | null;
  error: string | null;
  last_water_at: string;
  last_rest_at: string;
}

export interface HeatEventView {
  id: string;
  kind: 'water_prompt' | 'rest_prompt' | 'tier_change';
  tier: HeatTier | null;
  heat_index_f: number | null;
  created_at: string;
}

export interface MyHeat {
  watch: HeatWatchView | null;
  events: HeatEventView[];
  /** Official NWS heat alert already stored for the account by weather-surge-check, if any. */
  alert: string | null;
}

export type StartHeatError = 'bad_zip' | 'heat_disabled' | 'not_opted_in';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const fetchHeatSettings = () => rpc<HeatSettings>('heat_get_settings');

export function saveHeatSettings(input: { enabled: boolean; intervals: HeatIntervals }): Promise<HeatSettings> {
  return rpc<HeatSettings>('heat_save_settings', {
    p: { enabled: input.enabled, water_every_min: input.intervals.waterEveryMin, rest_every_min: input.intervals.restEveryMin },
  });
}

export const setHeatOptIn = (optedIn: boolean) => rpc<HeatSettings>('heat_set_optin', { p_opted_in: optedIn });

export async function startHeatWatch(zip: string): Promise<{ ok: true; watchId: string } | { ok: false; error: StartHeatError }> {
  const r = await rpc<{ success: boolean; error?: StartHeatError; watch_id?: string }>('heat_start_watch', { p_zip: zip });
  if (r.success && r.watch_id) {
    void pokeHeat(r.watch_id);
    return { ok: true, watchId: r.watch_id };
  }
  return { ok: false, error: r.error ?? 'bad_zip' };
}

export const endHeatWatch = (watchId: string) => rpc<{ success: boolean }>('heat_end_watch', { p_watch: watchId });
export const fetchMyHeat = () => rpc<MyHeat>('heat_my_watch');
export const ackHeatEvent = (eventId: string) => rpc<{ success: boolean; changed: boolean }>('heat_ack', { p_event: eventId });

/** Asks the engine to take the first reading now. Best effort: the cron run is the safety net. */
export async function pokeHeat(watchId: string): Promise<void> {
  try {
    await supabase.functions.invoke('safety-heat-tick', { body: { mode: 'watch', watch_id: watchId } });
  } catch {
    /* the 10-minute cron run will pick it up */
  }
}

export function intervalsFromSettings(s: HeatSettings): HeatIntervals {
  return { waterEveryMin: s.water_every_min, restEveryMin: s.rest_every_min };
}

export { HEAT_TIERS };
export type { HeatIntervals, HeatTier };
