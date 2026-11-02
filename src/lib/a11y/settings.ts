export type ColorBlindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export const COLOR_BLIND_MODES: readonly ColorBlindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];

export interface AccessibilitySettings {
  // Vision
  textSize: number; // 0.875–1.5
  contentScale: number; // 0.9–1.2
  readableFont: boolean;
  dyslexiaFont: boolean;
  largeCursor: boolean;
  highlightLinks: boolean;
  highlightHeadings: boolean;
  strongFocus: boolean;
  // Color & contrast
  highContrast: boolean;
  invertColors: boolean;
  grayscale: boolean;
  monochrome: boolean;
  highSaturation: boolean;
  lowSaturation: boolean;
  darkContrast: boolean;
  lightContrast: boolean;
  colorBlind: ColorBlindMode;
  // Reading
  readingMode: boolean;
  lineHeight: number; // 1.4–2.2
  letterSpacing: number; // 0–0.2em
  wordSpacing: number; // 0–0.3em
  // Motion & media
  reduceMotion: boolean;
  stopAnimations: boolean;
  hideImages: boolean;
  // Navigation
  highlightKeyboardFocus: boolean;
  screenReaderMode: boolean;
}

export const DEFAULT_SETTINGS: AccessibilitySettings = {
  textSize: 1,
  contentScale: 1,
  readableFont: false,
  dyslexiaFont: false,
  largeCursor: false,
  highlightLinks: false,
  highlightHeadings: false,
  strongFocus: false,
  highContrast: false,
  invertColors: false,
  grayscale: false,
  monochrome: false,
  highSaturation: false,
  lowSaturation: false,
  darkContrast: false,
  lightContrast: false,
  colorBlind: 'none',
  readingMode: false,
  lineHeight: 1.6,
  letterSpacing: 0,
  wordSpacing: 0,
  reduceMotion: false,
  stopAnimations: false,
  hideImages: false,
  highlightKeyboardFocus: false,
  screenReaderMode: false,
};

export const RANGES = {
  textSize: [0.875, 1.5],
  contentScale: [0.9, 1.2],
  lineHeight: [1.4, 2.2],
  letterSpacing: [0, 0.2],
  wordSpacing: [0, 0.3],
} as const;

type NumericKey = keyof typeof RANGES;
type BooleanKey = {
  [K in keyof AccessibilitySettings]: AccessibilitySettings[K] extends boolean ? K : never;
}[keyof AccessibilitySettings];

const NUMERIC_KEYS = Object.keys(RANGES) as NumericKey[];
const BOOLEAN_KEYS = (Object.keys(DEFAULT_SETTINGS) as (keyof AccessibilitySettings)[]).filter(
  (k): k is BooleanKey => typeof DEFAULT_SETTINGS[k] === 'boolean',
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge untrusted/partial/legacy data over the defaults; clamp numbers, drop unknown keys. */
export function sanitizeSettings(raw: unknown): AccessibilitySettings {
  const next: AccessibilitySettings = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return next;
  for (const k of BOOLEAN_KEYS) {
    const v = raw[k];
    if (typeof v === 'boolean') next[k] = v;
  }
  for (const k of NUMERIC_KEYS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const [lo, hi] = RANGES[k];
      next[k] = Math.min(hi, Math.max(lo, v));
    }
  }
  const cb = raw.colorBlind;
  if (typeof cb === 'string' && (COLOR_BLIND_MODES as readonly string[]).includes(cb)) {
    next.colorBlind = cb as ColorBlindMode;
  }
  return next;
}
