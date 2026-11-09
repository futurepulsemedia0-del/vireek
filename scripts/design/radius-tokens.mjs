// scripts/design/radius-tokens.mjs
//
// SINGLE SOURCE OF TRUTH for the border-radius scale. Imported by
// tailwind.config.js, scripts/design/radius-audit.mjs, the codemod and the
// design-system guard, so the scale can never drift between them.
//
// Scale is strictly monotonic: none < sm < md < lg < xl < 2xl < 3xl < full.

/** Numeric scale in px. `full` is a sentinel for 9999px. */
export const RADIUS_PX = Object.freeze({
  none: 0,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  '3xl': 24,
  full: 9999,
});

/** Semantic aliases -> scale step. New code uses these, not the raw steps. */
export const RADIUS_ROLES = Object.freeze({
  control: 'lg', // interactive: buttons, inputs, selects, tabs, menu items
  inset: 'lg', // non-interactive things nested in a surface: callouts, icon tiles, code/table wrappers, thumbnails
  chip: 'md', // badges, tags, kbd, counters (pills keep `full`)
  surface: 'xl', // cards, panels, popovers, dropdowns
  overlay: '2xl', // modals, sheets, command palette
});

/**
 * One-release compatibility alias. Before this change `rounded-md` rendered
 * 12px. The codemod rewrites every existing `rounded-md` to
 * `rounded-legacy-md` in the SAME commit that redefines `md` to 6px, so
 * nothing on screen moves. Phase 2 then migrates `legacy-md` by role, and the
 * next release deletes it (the guard bans it in new code immediately).
 */
export const LEGACY_ALIASES = Object.freeze({ 'legacy-md': '12px' });

const px = (n) => (n === 9999 ? '9999px' : `${n}px`);

/** Value for tailwind.config.js `theme.extend.borderRadius`. */
export function tailwindBorderRadius() {
  const out = {};
  for (const [k, v] of Object.entries(RADIUS_PX)) out[k] = px(v);
  out.DEFAULT = px(RADIUS_PX.sm); // bare `rounded` stays 4px (unchanged)
  for (const [role, step] of Object.entries(RADIUS_ROLES)) out[role] = px(RADIUS_PX[step]);
  return { ...out, ...LEGACY_ALIASES };
}

/** Rank used for monotonicity / nesting checks. */
export const RADIUS_RANK = Object.freeze({
  none: 0, sm: 1, DEFAULT: 1, chip: 2, md: 2, control: 3, inset: 3, lg: 3, surface: 4, xl: 4, overlay: 5, '2xl': 5, '3xl': 6, full: 7, 'legacy-md': 4,
});

/** What each token renders as TODAY (before the fix): Tailwind defaults + the md=12px override. */
export const BEFORE_PX = Object.freeze({ none: 0, sm: 2, DEFAULT: 4, md: 12, lg: 8, xl: 12, '2xl': 16, '3xl': 24, full: 9999 });
