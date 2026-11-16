import { correctionMatrix, toFeColorMatrix } from './colorBlind';
import { DEFAULT_SETTINGS, type AccessibilitySettings, type ColorBlindMode, type ColorChoice } from './settings';

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Keyboard focus ring colors: [ring, halo]. The halo is the contrasting outer glow, so the ring stays visible on any background. */
export const FOCUS_COLORS: Record<ColorChoice, { ring: string; halo: string }> = {
  default: { ring: 'rgb(var(--accent-primary))', halo: 'rgb(var(--accent-primary) / 0.2)' },
  black: { ring: '#000000', halo: '#ffffff' },
  white: { ring: '#ffffff', halo: '#000000' },
  yellow: { ring: '#ffd400', halo: '#000000' },
  blue: { ring: '#0050ff', halo: '#ffffff' },
};

/** Single source of truth for html classes (mirrored by public/a11y-boot.js; parity-tested). */
const CLASS_RULES: ReadonlyArray<readonly [string, (s: AccessibilitySettings) => boolean]> = [
  ['a11y-readable-font', (s) => s.readableFont],
  ['a11y-dyslexia-font', (s) => s.dyslexiaFont],
  ['a11y-large-cursor', (s) => s.largeCursor],
  ['a11y-highlight-links', (s) => s.highlightLinks],
  ['a11y-highlight-headings', (s) => s.highlightHeadings],
  ['a11y-strong-focus', (s) => s.strongFocus || s.highlightKeyboardFocus],
  ['a11y-high-contrast', (s) => s.highContrast],
  ['a11y-dark-contrast', (s) => s.darkContrast],
  ['a11y-light-contrast', (s) => s.lightContrast],
  ['a11y-reading-mode', (s) => s.readingMode],
  ['a11y-reduce-motion', (s) => s.reduceMotion],
  ['a11y-stop-animations', (s) => s.stopAnimations],
  ['a11y-hide-images', (s) => s.hideImages],
  ['a11y-screen-reader', (s) => s.screenReaderMode],
  ['a11y-text-scaled', (s) => !near(s.textSize, 1)],
  ['a11y-zoomed', (s) => !near(s.contentScale, 1)],
  ['a11y-lh', (s) => !near(s.lineHeight, DEFAULT_SETTINGS.lineHeight)],
  ['a11y-ls', (s) => s.letterSpacing > 0],
  ['a11y-ws', (s) => s.wordSpacing > 0],
  ['a11y-unstick', (s) => s.unstickHeaders],
  ['a11y-custom-focus', (s) => s.focusColor !== 'default' || !near(s.focusWidth, DEFAULT_SETTINGS.focusWidth)],
  ['a11y-cursor-black', (s) => s.cursorColor === 'black'],
  ['a11y-cursor-white', (s) => s.cursorColor === 'white'],
  ['a11y-cursor-yellow', (s) => s.cursorColor === 'yellow'],
  ['a11y-cursor-blue', (s) => s.cursorColor === 'blue'],
];

export const MANAGED_CLASSES: readonly string[] = CLASS_RULES.map(([c]) => c);

export interface RenderState {
  vars: Record<string, string>;
  classes: string[];
}

const CB_ID = (m: ColorBlindMode): string => `vk-a11y-cb-${m}`;

export function computeRenderState(s: AccessibilitySettings): RenderState {
  const f: string[] = [];
  if (s.colorBlind !== 'none') f.push(`url(#${CB_ID(s.colorBlind)})`);
  if (s.invertColors) f.push('invert(1) hue-rotate(180deg)');
  if (s.grayscale) f.push('grayscale(1)');
  if (s.monochrome) f.push('grayscale(1) contrast(1.1)');
  if (s.highSaturation) f.push('saturate(1.8)');
  if (s.lowSaturation) f.push('saturate(0.5)');
  return {
    vars: {
      '--a11y-font-scale': String(s.textSize),
      '--a11y-content-scale': String(s.contentScale),
      '--a11y-line-height': String(s.lineHeight),
      '--a11y-letter-spacing': `${s.letterSpacing}em`,
      '--a11y-word-spacing': `${s.wordSpacing}em`,
      '--a11y-filter': f.length ? f.join(' ') : 'none',
      '--a11y-focus-width': `${s.focusWidth}px`,
      '--a11y-focus-color': FOCUS_COLORS[s.focusColor].ring,
      '--a11y-focus-halo': FOCUS_COLORS[s.focusColor].halo,
    },
    classes: CLASS_RULES.filter(([, test]) => test(s)).map(([c]) => c),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HOST_ID = 'vk-a11y-filters';

function syncColorBlindFilter(doc: Document, mode: ColorBlindMode): void {
  const existing = doc.getElementById(HOST_ID);
  if (mode === 'none') {
    existing?.remove();
    return;
  }
  if (existing?.getAttribute('data-mode') === mode) return;
  existing?.remove();
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('id', HOST_ID);
  svg.setAttribute('data-mode', mode);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.overflow = 'hidden';
  svg.style.pointerEvents = 'none';
  const filter = doc.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', CB_ID(mode));
  filter.setAttribute('color-interpolation-filters', 'linearRGB');
  const matrix = doc.createElementNS(SVG_NS, 'feColorMatrix');
  matrix.setAttribute('type', 'matrix');
  matrix.setAttribute('values', toFeColorMatrix(correctionMatrix(mode)));
  filter.appendChild(matrix);
  svg.appendChild(filter);
  doc.body.appendChild(svg);
}

/** Idempotent. Only touches --a11y-* properties and managed classes (never wipes other inline styles). */
export function applyToDocument(s: AccessibilitySettings, doc: Document = document): void {
  const root = doc.documentElement;
  const { vars, classes } = computeRenderState(s);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  const active = new Set(classes);
  for (const c of MANAGED_CLASSES) root.classList.toggle(c, active.has(c));
  syncColorBlindFilter(doc, s.colorBlind);
}
