// src/lib/native/haptics.ts — tactile feedback in the installed app; a silent no-op on the web.

import { isNative } from './platform';

import {
  HAPTICS_SETTING_KEY, parseHapticsSetting, shouldFireHaptic, type HapticKind,
} from './hapticsPolicy';

export type { HapticKind };

let lastFiredAt: number | null = null;

export function isHapticsEnabled(): boolean {
  try { return parseHapticsSetting(window.localStorage.getItem(HAPTICS_SETTING_KEY)); } catch { return true; }
}

export function setHapticsEnabled(on: boolean): void {
  try { window.localStorage.setItem(HAPTICS_SETTING_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export async function haptic(kind: HapticKind = 'info'): Promise<void> {
  const now = Date.now();
  if (!shouldFireHaptic(kind, { native: isNative(), enabled: isHapticsEnabled(), reducedMotion: prefersReducedMotion(), now, lastFiredAt })) return;
  lastFiredAt = now;
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
    if (kind === 'selection') { await Haptics.selectionStart(); await Haptics.selectionChanged(); await Haptics.selectionEnd(); }
    else if (kind === 'impact') await Haptics.impact({ style: ImpactStyle.Medium });
    else if (kind === 'info') await Haptics.impact({ style: ImpactStyle.Light });
    else if (kind === 'success') await Haptics.notification({ type: NotificationType.Success });
    else if (kind === 'warning') await Haptics.notification({ type: NotificationType.Warning });
    else await Haptics.notification({ type: NotificationType.Error });
  } catch {
    /* device without a haptic engine */
  }
}
