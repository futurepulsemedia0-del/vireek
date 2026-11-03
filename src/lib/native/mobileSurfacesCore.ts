// src/lib/native/mobileSurfacesCore.ts — pure settings model for glanceable mobile surfaces
// (lock screen, widgets, watch, voice). No I/O so it is unit tested without a backend.

export interface MobileSurfacePrefs {
  hide_customer_names: boolean;
  time_sensitive_enabled: boolean;
  live_activities_enabled: boolean;
  widgets_enabled: boolean;
  watch_enabled: boolean;
  voice_assistant_enabled: boolean;
}

export type MobileSurfaceKey = keyof MobileSurfacePrefs;

/** Privacy-first: customer names stay off lock screens until the person opts in. */
export const DEFAULT_MOBILE_SURFACE_PREFS: MobileSurfacePrefs = {
  hide_customer_names: true,
  time_sensitive_enabled: true,
  live_activities_enabled: true,
  widgets_enabled: true,
  watch_enabled: true,
  voice_assistant_enabled: true,
};

export const MOBILE_SURFACE_KEYS = Object.keys(DEFAULT_MOBILE_SURFACE_PREFS) as MobileSurfaceKey[];

/** Accepts anything a database row / network response might contain; only real booleans win. */
export function normalizeMobileSurfacePrefs(row: unknown): MobileSurfacePrefs {
  const out = { ...DEFAULT_MOBILE_SURFACE_PREFS };
  if (typeof row !== 'object' || row === null) return out;
  const r = row as Record<string, unknown>;
  for (const k of MOBILE_SURFACE_KEYS) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  }
  return out;
}
