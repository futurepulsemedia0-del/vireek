import { supabase } from '@/lib/supabase';

/**
 * Weather-Triggered Surge Intelligence — dashboard client library.
 *
 * The actual detection runs server-side in the weather-surge-check Edge
 * Function (checks api.weather.gov against the account's zip code) and
 * two RPCs (see supabase/migrations/20260929000000_weather_surge_intelligence.sql).
 * This module is the thin read/settings/manual-trigger layer for the
 * dashboard page.
 */

export interface WeatherSurgeSettings {
  weather_surge_enabled: boolean;
  weather_zip_code: string | null;
  weather_surge_last_checked_at: string | null;
  surge_mode_active: boolean;
  surge_mode_source: 'manual' | 'weather' | null;
  surge_mode_note: string | null;
}

export interface WeatherSurgeEvent {
  id: string;
  user_id: string;
  nws_alert_id: string;
  event_type: string;
  severity: string | null;
  headline: string | null;
  area_desc: string | null;
  triggered_surge: boolean;
  effective_at: string | null;
  expires_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export async function fetchWeatherSurgeSettings(userId: string): Promise<WeatherSurgeSettings | null> {
  const { data, error } = await supabase
    .from('business_profile')
    .select('weather_surge_enabled, weather_zip_code, weather_surge_last_checked_at, surge_mode_active, surge_mode_source, surge_mode_note')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as WeatherSurgeSettings | null) ?? null;
}

export async function updateWeatherSurgeSettings(
  userId: string,
  updates: { weather_surge_enabled?: boolean; weather_zip_code?: string | null }
): Promise<void> {
  const { error } = await supabase.from('business_profile').update(updates).eq('user_id', userId);
  if (error) throw error;
}

export async function fetchWeatherSurgeHistory(limit = 20): Promise<WeatherSurgeEvent[]> {
  const { data, error } = await supabase
    .from('weather_surge_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as WeatherSurgeEvent[]) ?? [];
}

/**
 * Manually trigger a check right now (calls the weather-surge-check Edge
 * Function for just this account) — used by the "Check now" button so an
 * owner doesn't have to wait for the next scheduled sweep.
 */
export async function checkWeatherSurgeNow(): Promise<{ alerts_seen: number; alerts_triggered: number } | { error: string }> {
  const { data, error } = await supabase.functions.invoke('weather-surge-check');
  if (error) return { error: error.message };
  return data;
}

/**
 * Ends an active weather-triggered surge immediately, regardless of
 * whether its underlying alerts have expired yet. Manual surges aren't
 * touched — turn those off from the same surge control, not this one.
 */
export async function endWeatherSurgeNow(userId: string): Promise<void> {
  const { error } = await supabase
    .from('business_profile')
    .update({ surge_mode_active: false, surge_mode_enabled: false, surge_mode_source: null })
    .eq('user_id', userId)
    .eq('surge_mode_source', 'weather');
  if (error) throw error;
}
