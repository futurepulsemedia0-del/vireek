// src/lib/ui/iconScale.ts
//
// THE icon scale. Four sizes, one stroke width, one touch-target contract.
// Mirrors scripts/a11y/icon-scale.mjs (the codemod/audit copy); src/lib/ui/iconScale.test.ts fails if they drift.
// Docs: docs/design/ICON_SCALE.md

/** Pixel sizes at the default 16px root. The CSS tokens use rem, so they follow the user's font-size setting. */
export const ICON_SIZE_PX = { micro: 12, sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof ICON_SIZE_PX;
export const ICON_SIZES = Object.keys(ICON_SIZE_PX) as readonly IconSize[];

/** Constant stroke width (lucide viewBox units) for every icon on every size. Enforced in CSS (.icon-*). */
export const ICON_STROKE = 2;

/** Class implemented in src/index.css. Use this (or <Icon>) instead of h-N w-N / size={N}. */
export const iconClass = (size: IconSize): `icon-${IconSize}` => `icon-${size}`;

/** Anything above this is a "display" icon (illustrations, empty states): exempt from the scale. */
export const DISPLAY_ICON_MIN_PX = 25;

/** Touch-target contract (CSS px). WCAG 2.2 SC 2.5.8 = 24 minimum; 44 is the comfortable mobile target. */
export const TARGET_PX = { minimum: 24, denseDesktop: 32, comfortable: 44 } as const;

/** Nearest token for a legacy pixel size, or null for display icons. Same mapping the codemod uses. */
export function iconSizeForPx(px: number): IconSize | null {
  if (!Number.isFinite(px) || px <= 0) return null;
  if (px <= 12) return 'micro';
  if (px <= 17) return 'sm';
  if (px <= 21) return 'md';
  if (px <= 25) return 'lg';
  return null;
}
