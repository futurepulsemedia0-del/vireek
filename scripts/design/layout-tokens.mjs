// scripts/design/layout-tokens.mjs
// Single source of truth for the layout-token migration + guard.
// Used by normalize-layout.mjs (codemod) and check-design-system.mjs (guard).
// Pure functions only: no I/O, so it is unit-testable (layout-tokens.test.mjs).

/** Named z-index layers. MUST stay identical to theme.extend.zIndex in tailwind.config.js (a unit test enforces it). */
export const Z_LAYERS = {
  behind: -10,
  base: 0,
  raised: 10,
  dropdown: 20,
  sticky: 30,
  banner: 40,
  overlay: 50,
  modal: 60,
  command: 70,
  popover: 80,
  toast: 90,
  tooltip: 100,
  blocking: 110,
  skip: 120,
  max: 130,
};

/** Non-token shadows -> elevation scale (see docs/design/LAYOUT_TOKENS.md). shadow-card / card-hover / glow-* stay as they are. */
export const SHADOW_MAP = {
  sm: 'elevation-1',
  md: 'elevation-2',
  lg: 'elevation-3',
  xl: 'elevation-4',
  '2xl': 'elevation-4',
};

export const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));

/** Arbitrary shadows that now have a named, pixel-identical token (keys = bracket body as written). */
export const SHADOW_ARB_MAP = {
  '0_0_0_3px_rgb(var(--danger)/0.12)': 'ring-danger-soft',
  '0_0_0_3px_rgb(var(--accent-primary)/0.12)': 'ring-accent-soft',
  '0_0_0_3px_rgb(var(--accent-primary)/0.08)': 'ring-accent-faint',
  '0_10px_30px_-8px_rgb(var(--accent-primary)/0.5)': 'glow-accent-strong',
  '0_0_6px_rgba(0,0,0,0.5)': 'handle',
  '0_0_0_9999px_rgba(0,0,0,0.45)': 'spotlight',
  '0_30px_80px_-30px_rgba(0,0,0,0.65)': 'showcase',
};

/** Exact (pixel-identical) replacements for the most common non-scale values. */
export const EXACT_TOKENS = {
  // property group -> { value -> token }
  size: { '44px': 'touch' }, // w/h/min-w/min-h/size/max-w/max-h
  maxW: {
    '420px': 'panel-xs', '480px': 'panel-sm', '520px': 'panel-md', '560px': 'panel-lg',
    '640px': 'panel-xl', '720px': 'panel-2xl', '820px': 'panel-3xl',
  },
  maxH: { '92vh': 'sheet', '90vh': 'modal', '85vh': 'tall' },
  w: { '92vw': 'fluid-dialog' },
};

/** Tailwind v3.4 spacing keys (px = key*4). */
const SPACING_KEYS = new Set([
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
]);

export const SPACING_PROPS = [
  'min-w', 'min-h', 'max-w', 'max-h', 'gap-x', 'gap-y', 'space-x', 'space-y', 'inset-x', 'inset-y',
  'size', 'inset', 'gap', 'top', 'left', 'right', 'bottom', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'mx', 'my', 'mt', 'mb', 'ml', 'mr',
  'w', 'h', 'p', 'm',
];
const PROP_ALT = SPACING_PROPS.join('|');

// A class token with optional variants, optional "-" and an arbitrary bracket value.
// (?<![\w\[\]-]) stops us matching inside another token (e.g. "min-h" is not "h").
export const ARB_RE = new RegExp(
  `(?<![\\w\\[\\]-])((?:[a-z0-9-]+:)*)(-?)(${PROP_ALT})-\\[([^\\]\\s]+)\\](?![\\w\\[-])`,
  'g',
);
export const Z_ARB_RE = /(?<![\w\[\]-])((?:[a-z0-9-]+:)*)(-?)z-\[(-?\d+)\](?![\w\[-])/g;
export const Z_NUM_RE = /(?<![\w\[\]-])((?:[a-z0-9-]+:)*)(-?)z-(0|10|20|30|40|50)(?![\w\[-])/g;
export const SHADOW_RE = /(?<![\w\[\]-])((?:[a-z0-9-]+:)*)(?:drop-)?shadow-(sm|md|lg|xl|2xl|inner)(?![\w\[-])/g;
export const SHADOW_ARB_RE = /(?<![\w\[\]-])((?:[a-z0-9-]+:)*)shadow-\[[^\]\s]+\](?![\w\[-])/g;

/** Values that are legitimately dynamic / environment-driven and therefore allowed (see ARBITRARY_VALUES policy). */
export function isAllowedArbitraryValue(raw) {
  return (
    /var\(--/.test(raw) || // CSS-variable driven (data-driven values)
    /env\(/.test(raw) || // safe-area insets
    /\b(calc|clamp|min|max)\(/.test(raw) || // fluid / composite
    /^-?[\d.]+(em|cqw|cqi|cqh|cqb|lh|ch)$/.test(raw) || // font- or container-relative
    /^-?[\d.]+%$/.test(raw) // percentages of the parent
  );
}

function propGroup(prop) {
  if (prop === 'max-w' || prop === 'min-w') return 'maxW';
  if (prop === 'max-h') return 'maxH';
  if (prop === 'w') return 'w';
  return null;
}

/** Returns the replacement token suffix for an arbitrary value, or null when no EXACT equivalent exists. */
export function exactToken(prop, value) {
  const group = propGroup(prop);
  if (group && EXACT_TOKENS[group][value]) return EXACT_TOKENS[group][value];
  if (['w', 'h', 'min-w', 'min-h', 'max-w', 'max-h', 'size'].includes(prop) && EXACT_TOKENS.size[value]) return EXACT_TOKENS.size[value];
  const m = /^(-?[\d.]+)(px|rem)$/.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const key = m[2] === 'px' ? n / 4 : n * 4;
  if (Number.isFinite(key) && key >= 0 && SPACING_KEYS.has(key)) return String(key);
  return null;
}

// ---------------------------------------------------------------- z-index context classifier

/** (file-suffix, value) -> layer. Reviewed by hand against real usage; value null = any value in that file. */
export const Z_OVERRIDES = [
  ['loading/Overlay.tsx', null, 'max'],
  ['loading/PullToRefresh.tsx', null, 'max'],
  ['pages/dev/LoadingDemo.tsx', null, 'max'],
  ['ui/Tooltip.tsx', 400, 'tooltip'],
  ['session/ReauthModal.tsx', 400, 'blocking'],
  ['native/AppLockGate.tsx', 300, 'blocking'],
  ['native/UpdateGate.tsx', 310, 'blocking'],
  ['native/UpdateGate.tsx', 90, 'banner'],
  ['contexts/ToastContext.tsx', 300, 'toast'],
  ['contexts/UndoContext.tsx', 130, 'toast'],
  ['nav/RouteProgress.tsx', 300, 'toast'],
  ['a11y/SkipToContent.tsx', 200, 'skip'],
  ['components/GlobalSearchPalette.tsx', null, 'command'],
  ['components/CommandPalette.tsx', null, 'command'],
  ['consent/ConsentBanner.tsx', 70, 'banner'],
  ['bulk/BulkActionBar.tsx', 90, 'banner'],
  ['system/NetworkStatusStrip.tsx', 90, 'banner'],
  ['system/DegradedBanner.tsx', 99, 'banner'],
  ['system/OfflineBanner.tsx', 100, 'banner'],
  ['system/UpdatePrompt.tsx', 95, 'banner'],
  ['tour/TourResumePrompt.tsx', 65, 'banner'],
  ['tour/TourOverlay.tsx', 70, 'overlay'],
  ['components/ProductTour.tsx', 70, 'overlay'],
  ['components/Header.tsx', 60, 'sticky'],
  ['blog/ArticleChrome.tsx', 60, 'sticky'],
  ['components/AccessibilityWidget.tsx', 75, 'banner'],
  ['components/AccessibilityWidget.tsx', 73, 'overlay'],
  ['components/AccessibilityWidget.tsx', 74, 'modal'],
  ['schedule/ScheduleDnd.tsx', 90, 'popover'],
];

/**
 * Decide the layer for a z utility from the element's class string. Returns a layer name or null (=> needs human review).
 * Heuristic, deliberately conservative: anything not clearly a backdrop/panel/menu/sticky bar is left alone.
 */
export function classifyLayer(cls, n, file) {
  const norm = file.replace(/\\/g, '/');
  for (const [suffix, val, layer] of Z_OVERRIDES) {
    if (norm.endsWith(suffix) && (val === null || val === n)) return layer;
  }
  const fixed = /(?<![\w-])fixed(?![\w-])/.test(cls);
  const absolute = /(?<![\w-])absolute(?![\w-])/.test(cls);
  const sticky = /(?<![\w-])sticky(?![\w-])/.test(cls);
  const has = (re) => re.test(cls);
  const bottom0 = has(/(?<![\w-])bottom-0(?![\w-])/);
  if (n === 10 && !fixed) return 'raised'; // local lift inside a component
  if (has(/(?<![\w-])relative(?![\w-])/) && !fixed && n <= 30) return 'raised';
  if (n >= 60 && has(/max-h-(\[(85|90|92)vh\]|sheet|modal|tall)/)) return 'modal'; // dialog / sheet panel
  if (fixed && has(/(?<![\w-])inset-0(?![\w-])/)) return has(/(?<![\w-])(flex|grid)(?![\w-])/) ? 'modal' : 'overlay';
  if (fixed && has(/-translate-/) && has(/(?<![\w-])top-(1\/2|\[)/)) return 'modal'; // centred panel
  if (fixed && has(/inset-x-0/) && bottom0 && has(/(?<![\w-])top-/)) return 'modal'; // full-height sheet
  if (fixed && has(/(?<![\w-])(left|right|start|end)-0(?![\w-])/) && (has(/inset-y-0/) || (has(/(?<![\w-])top-0(?![\w-])/) && has(/(?<![\w-])h-full/)))) {
    return has(/(?<![\w-])hidden(?![\w-])/) ? 'sticky' : 'modal'; // responsive-hidden fixed sidebar vs. drawer
  }
  if (fixed && has(/inset-x-0/) && bottom0) return n >= 70 ? 'banner' : 'sticky'; // bottom bars / mobile nav
  if (fixed && has(/inset-x-0/) && has(/(?<![\w-])top-0(?![\w-])/) && !bottom0) return 'sticky'; // fixed top bar
  if (fixed && has(/inset-x-(?!0(?![\w.-]))[\w.\[\]-]+/) && has(/(?<![\w-])(top|bottom)-/)) return 'banner'; // inline alert / prompt
  if (fixed && has(/(?<![\w-])(right|left|start|end)-[\d[]/) && has(/(?<![\w-])(top|bottom)-[\d[]/)) return 'banner'; // floating widget
  if (absolute && n >= 20) return 'dropdown';
  if (sticky) return n >= 90 ? 'banner' : 'sticky';
  return null;
}

// ---------------------------------------------------------------- transform

/** The class-list-ish string segment around `idx`, found on the same line (immune to quote mis-pairing elsewhere in the file). */
export function contextAt(str, idx) {
  const lineStart = str.lastIndexOf('\n', idx - 1) + 1;
  const seg = str.slice(lineStart, idx);
  const m = Math.max(seg.lastIndexOf('"'), seg.lastIndexOf("'"), seg.lastIndexOf('`'));
  if (m < 0) return '';
  const q = seg[m];
  const from = lineStart + m + 1;
  let end = str.indexOf(q, idx);
  if (q !== '`') {
    const lineEnd = str.indexOf('\n', idx);
    if (end < 0 || (lineEnd >= 0 && end > lineEnd)) end = lineEnd < 0 ? str.length : lineEnd;
  } else if (end < 0) end = str.length;
  return str.slice(from, end);
}

const isCommentLine = (str, idx) => /^\s*(\/\/|\*|\/\*)/.test(str.slice(str.lastIndexOf('\n', idx - 1) + 1, idx + 1));

/**
 * Transforms one source file. Works token-by-token (no whole-file string parsing), skips comment lines.
 * @returns {{ code: string, changes: {kind:string, from:string, to:string}[], review: {kind:string, token:string, line:number}[] }}
 */
export function transformSource(source, file, opts = {}) {
  const { z = true, shadow = true, spacing = true } = opts;
  const changes = [];
  const review = [];
  let code = source;
  const lineAt = (str, idx) => str.slice(0, idx).split('\n').length;
  const run = (re, fn) => {
    code = code.replace(re, (...a) => {
      const offset = a[a.length - 2];
      if (isCommentLine(code, offset)) return a[0];
      return fn(a, offset);
    });
  };
  const keep = (kind, tok, offset) => { review.push({ kind, token: tok, line: lineAt(code, offset) }); return tok; };
  const swap = (kind, tok, to) => { changes.push({ kind, from: tok, to }); return to; };

  if (z) {
    const zFn = (numFromMatch) => ([tok, variants, neg, num], offset) => {
      const n = Number(num);
      if (neg) return numFromMatch === 'num' && n === 10 ? swap('z', tok, `${variants}z-behind`) : tok;
      const layer = numFromMatch === 'num' && n === 0 ? 'base' : classifyLayer(contextAt(code, offset), n, file);
      return layer ? swap('z', tok, `${variants}z-${layer}`) : keep('z', tok, offset);
    };
    run(Z_ARB_RE, zFn('arb'));
    run(Z_NUM_RE, zFn('num'));
  }
  if (shadow) {
    run(SHADOW_RE, ([tok, variants, size], offset) => {
      if (tok.includes('drop-') || size === 'inner') return keep('shadow', tok, offset);
      return swap('shadow', tok, `${variants}shadow-${SHADOW_MAP[size]}`);
    });
    run(SHADOW_ARB_RE, ([tok, variants], offset) => {
      const name = SHADOW_ARB_MAP[tok.slice(tok.indexOf('[') + 1, -1)];
      return name ? swap('shadow', tok, `${variants}shadow-${name}`) : keep('shadow', tok, offset);
    });
  }
  if (spacing) {
    run(ARB_RE, ([tok, variants, neg, prop, raw], offset) => {
      if (isAllowedArbitraryValue(raw)) return tok;
      const t = exactToken(prop, raw);
      if (t === null || (neg && t === 'touch')) return keep('spacing', tok, offset);
      return swap('spacing', tok, `${variants}${neg}${prop}-${t}`);
    });
  }
  return { code, changes, review };
}
