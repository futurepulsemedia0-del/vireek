import type { AccessibilitySettings } from './settings';

/** OS-level preferences used only as first-visit defaults (no stored settings yet). */
export function detectSystemPreferences(
  win: Pick<Window, 'matchMedia'> | undefined,
): Partial<AccessibilitySettings> {
  if (!win || typeof win.matchMedia !== 'function') return {};
  const q = (query: string): boolean => {
    try {
      return win.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const out: Partial<AccessibilitySettings> = {};
  if (q('(prefers-reduced-motion: reduce)')) out.reduceMotion = true;
  if (q('(prefers-contrast: more)')) out.highContrast = true;
  return out;
}
