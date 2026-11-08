// scripts/color/tailwind-colors.mjs — Tailwind theme fragment derived from palette.mjs (do not hand-edit).
// Usage in tailwind.config.js:  import { tailwindTheme } from './scripts/color/tailwind-colors.mjs'
//   theme.extend = { ...tailwindTheme, ...your other extensions }
import { FAMILY_NAMES, FAMILY_DEFS, buildScale, NEUTRAL_SCALE } from './palette.mjs';

const v = (n) => `rgb(var(--${n}) / <alpha-value>)`;

function family(name) {
  const shades = buildScale({ ...FAMILY_DEFS[name] });
  const semantic = (def) => ({
    DEFAULT: v(def),
    hover: v(`${name}-hover`),
    active: v(`${name}-active`),
    subtle: v(`${name}-subtle`),
    'subtle-border': v(`${name}-subtle-border`),
    strong: v(`${name}-strong`),
    graphic: v(`${name}-graphic`),
    text: v(`${name}-text`),
    fill: v(`${name}-fill`),
    on: v(`on-${name}`),
  });
  return { bg: { ...shades, ...semantic(`${name}-fill`) }, text: { ...shades, ...semantic(`${name}-text`) }, graphic: { ...shades, ...semantic(`${name}-graphic`) } };
}

const fams = Object.fromEntries(FAMILY_NAMES.map((n) => [n, family(n)]));
const pick = (kind) => Object.fromEntries(FAMILY_NAMES.map((n) => [n, fams[n][kind]]));

const neutrals = {
  'bg-primary': v('bg-primary'),
  'bg-secondary': v('bg-secondary'),
  'bg-tertiary': v('bg-tertiary'),
  surface: v('bg-primary'),
  'surface-raised': v('bg-secondary'),
  'surface-overlay': v('surface-overlay'),
  'surface-inverse': v('surface-inverse'),
  'on-inverse': v('on-inverse'),
  'on-inverse-muted': v('on-inverse-muted'),
  'text-primary': v('text-primary'),
  'text-secondary': v('text-secondary'),
  'text-muted': v('text-muted'),
  'text-placeholder': v('text-placeholder'),
  'text-disabled': v('text-disabled'),
  'graphic-muted': v('graphic-muted'),
  'text-inverse': v('text-inverse'),
  'focus-ring': v('focus-ring'),
  overlay: v('overlay'),
  selection: v('selection-bg'),
  'disabled-bg': v('disabled-bg'),
  'disabled-fg': v('disabled-fg'),
  'static-white': v('static-white'),
  'static-black': v('static-black'),
  graphite: NEUTRAL_SCALE,
  // legacy aliases kept so existing class names keep resolving
  text: { primary: v('text-primary'), secondary: v('text-secondary'), muted: v('text-muted'), inverse: v('text-inverse') },
  ai: v('cta-fill'),
  // brand gradient: `bg-gradient-to-br from-brand-from to-brand-to text-on-brand` (contrast-solved in both themes)
  'brand-from': v('brand-from'),
  'brand-to': v('brand-to'),
  'on-brand': v('on-brand'),
  viz: Object.fromEntries([...Array(8)].map((_, i) => [i + 1, v(`viz-${i + 1}`)])),
};
for (const [p, n] of [['on', FAMILY_NAMES]]) for (const f of n) neutrals[`${p}-${f}`] = v(`on-${f}`);

const borderTokens = { DEFAULT: v('border-default'), subtle: v('border-default'), strong: v('border-strong'), inverse: v('border-inverse') };

const graphicUtilities = ['borderColor', 'ringColor', 'outlineColor', 'divideColor', 'fill', 'stroke', 'caretColor', 'accentColor', 'decorationColor'];

export const tailwindTheme = {
  colors: { ...neutrals, ...pick('bg'), border: borderTokens },
  textColor: { ...pick('text') },
  ...Object.fromEntries(graphicUtilities.map((u) => [u, { ...pick('graphic'), border: borderTokens, 'focus-ring': v('focus-ring'), 'graphic-muted': v('graphic-muted') }
  ...Object.fromEntries(graphicUtilities.map((u) => [u, ])),
  placeholderColor: { 'text-muted': v('text-muted'), 'text-placeholder': v('text-placeholder') },
};
