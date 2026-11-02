// src/lib/native/hapticsPolicy.ts — pure rules for "should this tap vibrate?" (unit tested).
// The device call itself lives in haptics.ts; this file has no imports so it is trivially testable.

export type HapticKind = 'selection' | 'impact' | 'success' | 'warning' | 'error' | 'info';

export const HAPTICS_SETTING_KEY = 'vireek:haptics';

/** Pull-to-refresh / swipe thresholds fire often; never let them buzz more than ~12 times a second. */
export const HAPTIC_MIN_GAP_MS = 80;

export interface HapticContext {
  native: boolean;
  /** User toggle in settings. Missing value = on. */
  enabled: boolean;
  reducedMotion: boolean;
  now: number;
  lastFiredAt: number | null;
}

/** Warnings and errors still fire under reduced motion: they carry meaning, not decoration. */
const ESSENTIAL: ReadonlySet<HapticKind> = new Set(['warning', 'error']);

export function shouldFireHaptic(kind: HapticKind, ctx: HapticContext): boolean {
  if (!ctx.native || !ctx.enabled) return false;
  if (ctx.reducedMotion && !ESSENTIAL.has(kind)) return false;
  if (ctx.lastFiredAt !== null && ctx.now - ctx.lastFiredAt < HAPTIC_MIN_GAP_MS) return false;
  return true;
}

export function parseHapticsSetting(raw: string | null | undefined): boolean {
  return raw !== '0';
}
