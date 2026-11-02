// src/lib/native/textScale.ts — follows the phone's system font size (iOS Dynamic Type /
// Android font scale) by publishing --native-font-scale. index.css multiplies body text by it,
// on top of the in-app accessibility text size.

import { isNative } from './platform';

export function clampFontScale(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(2, Math.max(0.85, Math.round(n * 100) / 100));
}

export async function syncNativeFontScale(): Promise<void> {
  if (!isNative()) return;
  try {
    const { TextZoom } = await import('@capacitor/text-zoom');
    const { value } = await TextZoom.getPreferred();
    document.documentElement.style.setProperty('--native-font-scale', String(clampFontScale(value)));
  } catch {
    /* plugin missing or unsupported: keep the default scale of 1 */
  }
}
