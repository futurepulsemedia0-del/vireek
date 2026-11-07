// scripts/a11y/icon-scale.mjs — single source of truth for the codemod/audit. Mirrored (and parity-tested) by
// src/lib/ui/iconScale.ts. If you change one, change the other; the Vitest parity test fails otherwise.
export const ICON_TOKENS = { micro: 12, sm: 16, md: 20, lg: 24 };
export const DISPLAY_MIN_PX = 25; // anything larger is a "display" icon (illustration / empty state): exempt, never codemodded

/** Pixel size (from size={N}) -> token, or null for display icons. */
export function tokenForPx(px) {
  if (!Number.isFinite(px) || px <= 0) return null;
  if (px <= 12) return 'micro';
  if (px <= 17) return 'sm';
  if (px <= 21) return 'md';
  if (px <= 25) return 'lg';
  return null;
}
/** Tailwind spacing unit (h-N) -> token. 1 unit = 4px. */
export function tokenForTw(n) {
  const px = Number(n) * 4;
  return px <= 24 ? tokenForPx(px) : null;
}
