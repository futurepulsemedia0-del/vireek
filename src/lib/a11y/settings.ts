import { DEFAULT_SHORTCUTS, sanitizeShortcuts, type ShortcutMap } from './shortcuts';

export type ColorBlindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export const COLOR_BLIND_MODES: readonly ColorBlindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];

/** Shared palette for the pointer and focus-ring pickers. 'default' keeps the Vireek look. */
export type ColorChoice = 'default' | 'black' | 'white' | 'yellow' | 'blue';
export const COLOR_CHOICES: readonly ColorChoice[] = ['default', 'black', 'white', 'yellow', 'blue'];
export const CHOICE_KEYS = ['cursorColor', 'focusColor'] as const;
export type ChoiceSettingKey = (typeof CHOICE_KEYS)[number];

export interface AccessibilitySettings {
  // Vision
  textSize: number; // 0.875–1.5
  contentScale: number; // 0.9–1.2
  readableFont: boolean;
  simpleFont: boolean;
  dyslexiaFont: boolean;
  largeCursor: boolean;
  highlightLinks: boolean;
  highlightHeadings: boolean;
  strongFocus: boolean;
  magnifier: boolean;
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
  readingMask: boolean;
  readingGuide: boolean;
  ttsRate: number;
  ttsPitch: number;
  ttsVolume: number;
  ttsVoiceURI: string;
  // Motion, media & focus
  reduceMotion: boolean;
  stopAnimations: boolean;
  hideImages: boolean;
  focusMode: boolean;
  // Navigation
  highlightKeyboardFocus: boolean;
  largeTargets: boolean;
  screenReaderMode: boolean;
  // Cognitive support, hearing & audio, cursor & focus
  unstickHeaders: boolean;
  muteMedia: boolean;
  captionsAlways: boolean;
  cursorColor: ColorChoice;
  focusColor: ColorChoice;
  focusWidth: number; // 2–6 px
  shortcuts: ShortcutMap;
}

export const DEFAULT_SETTINGS: AccessibilitySettings = {
  textSize: 1,
  contentScale: 1,
  readableFont: false,
  simpleFont: false,
  dyslexiaFont: false,
  largeCursor: false,
  highlightLinks: false,
  highlightHeadings: false,
  strongFocus: false,
  magnifier: false,
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
  readingMask: false,
  readingGuide: false,
  ttsRate: 1,
  ttsPitch: 1,
  ttsVolume: 1,
  ttsVoiceURI: '',
  reduceMotion: false,
  stopAnimations: false,
  hideImages: false,
  focusMode: false,
  highlightKeyboardFocus: false,
  largeTargets: false,
  screenReaderMode: false,
  unstickHeaders: false,
  muteMedia: false,
  captionsAlways: false,
  cursorColor: 'default',
  focusColor: 'default',
  focusWidth: 3,
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

export const RANGES = {
  textSize: [0.875, 1.5],
  contentScale: [0.9, 1.2],
  lineHeight: [1.4, 2.2],
  letterSpacing: [0, 0.2],
  wordSpacing: [0, 0.3],
  ttsRate: [0.5, 2],
  ttsPitch: [0.5, 1.5],
  ttsVolume: [0, 1],
  focusWidth: [2, 6],
} as const;

export type NumericSettingKey = keyof typeof RANGES;
export type BooleanSettingKey = {
  [K in keyof AccessibilitySettings]: AccessibilitySettings[K] extends boolean ? K : never;
}[keyof AccessibilitySettings];

const NUMERIC_KEYS = Object.keys(RANGES) as NumericSettingKey[];
export const BOOLEAN_KEYS = (Object.keys(DEFAULT_SETTINGS) as (keyof AccessibilitySettings)[]).filter(
  (k): k is BooleanSettingKey => typeof DEFAULT_SETTINGS[k] === 'boolean',
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge untrusted/partial/legacy data over the defaults; clamp numbers, drop unknown keys. */
export function sanitizeSettings(raw: unknown): AccessibilitySettings {
  const next: AccessibilitySettings = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
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
  for (const k of CHOICE_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && (COLOR_CHOICES as readonly string[]).includes(v)) next[k] = v as ColorChoice;
  }
  const voice = raw.ttsVoiceURI;
  if (typeof voice === 'string' && voice.length <= 200) next.ttsVoiceURI = voice;
  if ('shortcuts' in raw) next.shortcuts = sanitizeShortcuts(raw.shortcuts);
  return next;
}
