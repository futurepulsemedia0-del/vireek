import { haptic } from '@/lib/native/haptics';
import { isNative } from '@/lib/native/platform';

/**
 * Light tap feedback. Native app → Capacitor haptics; Android browsers/PWA →
 * Vibration API. iOS Safari has no web haptics, so this is a silent no-op there.
 * Respects prefers-reduced-motion. Must be called from a user gesture.
 */
export function tapHaptic(): void {
  if (isNative()) {
    void haptic('info');
    return;
  }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    navigator.vibrate(8);
  } catch {
    /* blocked by browser policy */
  }
}
