// scripts/type/type-scale.mjs
//
// SINGLE SOURCE OF TRUTH for the Vireek type scale.
// Consumed by: tailwind.config.js, scripts/type/check-text-sizes.mjs, the /dev/design-system page, and the tests.
// Change a number here and every consumer follows; nothing else may define a font size.
//
// Rules baked in (and enforced at import time by assertScale):
//   • rem units only, at a 16px root (the root is never overridden in px — see src/index.css);
//   • nothing below MIN_REM (0.75rem = 12px), in any density mode;
//   • `alias` is the stock Tailwind key that is guaranteed to carry the SAME size + line-height, so the ~20,000
//     existing text-xs/sm/base/… call sites and the semantic names cannot drift apart.

export const ROOT_PX = 16;
export const MIN_REM = 0.75; // 12px

/**
 * @typedef {Object} TypeToken
 * @property {string} name        semantic name → `text-<name>`
 * @property {string|null} alias  stock Tailwind key with identical size/line-height (null = semantic only)
 * @property {number} rem         font-size in rem
 * @property {string} lineHeight  rem string or unitless number (string)
 * @property {string} [tracking]  letter-spacing (em). Reset to 0 under fa/ar by the Tailwind plugin.
 * @property {string} [weight]    only on tokens that are new classes (never on aliases — see toTailwindFontSize)
 * @property {string} role        what it is for (rendered on /dev/design-system)
 * @property {string} guidance    usage guidance (rendered on /dev/design-system)
 * @property {'dashboard'|'marketing'|'both'} surface
 */

/** @type {TypeToken[]} */
export const TYPE_SCALE = [
  { name: 'eyebrow', alias: null, rem: 0.75, lineHeight: '1rem', tracking: '0.08em', weight: '600', surface: 'both',
    role: 'Section kicker / overline', guidance: 'Short (≤3 words). Pair with uppercase only in Latin scripts. Never smaller than caption.' },
  { name: 'caption', alias: 'xs', rem: 0.75, lineHeight: '1rem', tracking: '0.01em', surface: 'both',
    role: 'Metadata, badges, chart axis labels, helper/error text, table meta',
    guidance: 'The floor: 12px. Use text-secondary for hierarchy, never a smaller size. Truncate with a tooltip rather than shrinking.' },
  { name: 'small', alias: 'sm', rem: 0.875, lineHeight: '1.25rem', surface: 'dashboard',
    role: 'Dashboard default: table cells, form controls, card body', guidance: '14/20. Default for dense product UI.' },
  { name: 'body', alias: 'base', rem: 1, lineHeight: '1.5rem', surface: 'marketing',
    role: 'Marketing and long-form default, mobile inputs (16px prevents iOS zoom)', guidance: '16/24. Keep measure under ~75 characters.' },
  { name: 'lead', alias: 'lg', rem: 1.125, lineHeight: '1.75rem', surface: 'both',
    role: 'Intro paragraph, emphasised summary', guidance: '18/28.' },
  { name: 'h4', alias: 'xl', rem: 1.25, lineHeight: '1.75rem', tracking: '-0.005em', weight: '600', surface: 'both',
    role: 'Card and section title', guidance: '20/28.' },
  { name: 'h3', alias: '2xl', rem: 1.5, lineHeight: '2rem', tracking: '-0.01em', weight: '600', surface: 'both',
    role: 'Subsection heading', guidance: '24/32.' },
  { name: 'h2', alias: '3xl', rem: 1.875, lineHeight: '2.25rem', tracking: '-0.015em', weight: '600', surface: 'both',
    role: 'Section heading', guidance: '30/36.' },
  { name: 'h1', alias: '4xl', rem: 2.25, lineHeight: '2.5rem', tracking: '-0.02em', weight: '700', surface: 'both',
    role: 'Page title', guidance: '36/40. One per page.' },
  { name: 'display', alias: '5xl', rem: 3, lineHeight: '1', tracking: '-0.03em', weight: '700', surface: 'marketing',
    role: 'Marketing hero', guidance: '48/1.' },
  { name: 'display-lg', alias: '6xl', rem: 3.75, lineHeight: '1', tracking: '-0.04em', weight: '700', surface: 'marketing',
    role: 'Hero, large screens', guidance: '60/1.' },
];

/** Utilities that are NOT sizes but complete the typographic system (rendered on /dev/design-system). */
export const TYPE_UTILITIES = [
  { className: 'type-figure', role: 'Figures: money, counts, durations, numeric table columns', css: 'lining-nums tabular-nums; letter-spacing: 0' },
  { className: 'type-inline', role: 'Inline code / relative-sized text inside prose; follows the parent but never below 12px', css: 'font-size: max(0.9em, 0.75rem)' },
  { className: 'type-id', role: 'IDs, phone numbers, hashes (always LTR, isolated from RTL text)', css: 'monospace; tabular-nums slashed-zero; direction: ltr; unicode-bidi: isolate' },
];

export const toPx = (rem) => rem * ROOT_PX;

/** Throws if the scale violates the programme's invariants. Runs at import time. */
export function assertScale(scale = TYPE_SCALE) {
  const names = new Set();
  const aliases = new Set();
  for (const t of scale) {
    if (names.has(t.name)) throw new Error(`type-scale: duplicate token "${t.name}"`);
    names.add(t.name);
    if (t.alias) {
      if (aliases.has(t.alias)) throw new Error(`type-scale: duplicate alias "${t.alias}"`);
      aliases.add(t.alias);
    }
    if (!(t.rem >= MIN_REM)) throw new Error(`type-scale: "${t.name}" is ${toPx(t.rem)}px, below the ${toPx(MIN_REM)}px floor`);
    if (!/^[0-9.]+(rem)?$/.test(String(t.lineHeight).trim())) throw new Error(`type-scale: "${t.name}" line-height must be rem or unitless`);
    // Line height must never be smaller than the font size (clipping, WCAG 1.4.12 headroom).
    const lh = String(t.lineHeight).endsWith('rem') ? parseFloat(t.lineHeight) : parseFloat(t.lineHeight) * t.rem;
    if (lh < t.rem) throw new Error(`type-scale: "${t.name}" line-height ${lh}rem < font-size ${t.rem}rem`);
  }
  return scale;
}
assertScale();

/**
 * Tailwind `fontSize` map. Semantic tokens carry size + line-height (+ tracking/weight where defined).
 * Stock aliases (xs…6xl) carry ONLY size + line-height — exactly Tailwind's own values — so that adding the
 * scale changes nothing for existing call sites (a forced weight/tracking would silently override inherited values).
 */
export function toTailwindFontSize(scale = TYPE_SCALE) {
  const out = {};
  for (const t of scale) {
    const opts = { lineHeight: t.lineHeight };
    if (t.tracking) opts.letterSpacing = t.tracking;
    if (t.weight) opts.fontWeight = t.weight;
    out[t.name] = [`${t.rem}rem`, opts];
    if (t.alias) out[t.alias] = [`${t.rem}rem`, { lineHeight: t.lineHeight }];
  }
  return out;
}
