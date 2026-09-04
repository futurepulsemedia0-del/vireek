import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { type LanguageCode, type TranslationKey, TRANSLATIONS, getLanguage, isRTL } from '@/lib/i18n';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AccessibilitySettings {
  // Vision
  textSize: number;          // 0.875–1.5 (rem multiplier)
  contentScale: number;       // 0.9–1.2
  readableFont: boolean;
  dyslexiaFont: boolean;
  largeCursor: boolean;
  highlightLinks: boolean;
  highlightHeadings: boolean;
  strongFocus: boolean;

  // Color & Contrast
  highContrast: boolean;
  invertColors: boolean;
  grayscale: boolean;
  monochrome: boolean;
  highSaturation: boolean;
  lowSaturation: boolean;
  darkContrast: boolean;
  lightContrast: boolean;

  // Reading
  readingMode: boolean;
  lineHeight: number;         // 1.4–2.2
  letterSpacing: number;       // 0–0.2em
  wordSpacing: number;         // 0–0.3em

  // Motion & Media
  reduceMotion: boolean;
  stopAnimations: boolean;
  hideImages: boolean;

  // Navigation
  highlightKeyboardFocus: boolean;
  screenReaderMode: boolean;
}

const DEFAULT_SETTINGS: AccessibilitySettings = {
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

/* ------------------------------------------------------------------ */
/*  Profiles                                                           */
/* ------------------------------------------------------------------ */

export interface AccessibilityProfile {
  id: string;
  name: string;
  description: string;
  icon: string;
  settings: Partial<AccessibilitySettings>;
}

export const PROFILES: AccessibilityProfile[] = [
  {
    id: 'universal',
    name: 'Universal Accessibility',
    description: 'Enable recommended settings for everyone.',
    icon: 'universal',
    settings: { strongFocus: true, highlightLinks: true, lineHeight: 1.7 },
  },
  {
    id: 'low-vision',
    name: 'Low Vision Mode',
    description: 'Increase clarity, contrast, and visibility.',
    icon: 'eye',
    settings: { textSize: 1.15, highContrast: true, highlightLinks: true, strongFocus: true, largeCursor: true },
  },
  {
    id: 'adhd-focus',
    name: 'ADHD Focus Mode',
    description: 'Reduce distractions and improve focus.',
    icon: 'brain',
    settings: { readingMode: true, reduceMotion: true, stopAnimations: true, hideImages: true, highlightHeadings: true },
  },
  {
    id: 'reading-cognitive',
    name: 'Reading & Cognitive Support',
    description: 'Improve reading comfort and comprehension.',
    icon: 'book',
    settings: { readableFont: true, lineHeight: 1.9, letterSpacing: 0.04, wordSpacing: 0.08, textSize: 1.1 },
  },
  {
    id: 'seizure-safe',
    name: 'Seizure Safe Mode',
    description: 'Reduce animations and visual triggers.',
    icon: 'shield',
    settings: { reduceMotion: true, stopAnimations: true, hideImages: true },
  },
  {
    id: 'keyboard-nav',
    name: 'Keyboard Navigation Mode',
    description: 'Improve keyboard browsing experience.',
    icon: 'keyboard',
    settings: { highlightKeyboardFocus: true, strongFocus: true },
  },
  {
    id: 'screen-reader',
    name: 'Screen Reader Mode',
    description: 'Optimize for screen reader compatibility.',
    icon: 'volume',
    settings: { screenReaderMode: true, highlightHeadings: true, highlightLinks: true },
  },
  {
    id: 'senior-friendly',
    name: 'Senior Friendly Mode',
    description: 'Improve readability and overall comfort.',
    icon: 'user',
    settings: { textSize: 1.2, lineHeight: 1.8, readableFont: true, strongFocus: true, highlightLinks: true, largeCursor: true },
  },
];

/* ------------------------------------------------------------------ */
/*  Quick actions                                                      */
/* ------------------------------------------------------------------ */

export interface QuickAction {
  id: string;
  label: string;
  description: string;
  icon: string;
  apply: Partial<AccessibilitySettings>;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'readable-text',
    label: 'Make text easier to read',
    description: 'Increase font size and improve line spacing.',
    icon: 'type',
    apply: { textSize: 1.15, lineHeight: 1.8, readableFont: true },
  },
  {
    id: 'improve-visibility',
    label: 'Improve visibility',
    description: 'Boost contrast and highlight key elements.',
    icon: 'eye',
    apply: { highContrast: true, highlightLinks: true, strongFocus: true },
  },
  {
    id: 'reduce-motion',
    label: 'Reduce motion',
    description: 'Minimize animations and visual effects.',
    icon: 'minimize',
    apply: { reduceMotion: true, stopAnimations: true },
  },
  {
    id: 'improve-focus',
    label: 'Improve focus',
    description: 'Reduce distractions and highlight structure.',
    icon: 'target',
    apply: { readingMode: true, highlightHeadings: true, reduceMotion: true },
  },
];

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface AccessibilityContextValue {
  settings: AccessibilitySettings;
  updateSetting: <K extends keyof AccessibilitySettings>(key: K, value: AccessibilitySettings[K]) => void;
  applyProfile: (profile: AccessibilityProfile) => void;
  resetAll: () => void;
  activeProfile: string | null;
  score: number;
  hasOnboarded: boolean;
  setHasOnboarded: (v: boolean) => void;
  language: LanguageCode;
  setLanguage: (code: LanguageCode) => void;
  recentLanguages: LanguageCode[];
  t: (key: TranslationKey) => string;
  rtl: boolean;
}

const AccessibilityContext = createContext<AccessibilityContextValue | undefined>(undefined);

const STORAGE_KEY = 'vireek-a11y-settings';
const ONBOARD_KEY = 'vireek-a11y-onboarded';
const LANG_KEY = 'vireek-a11y-lang';
const RECENT_LANG_KEY = 'vireek-a11y-recent-langs';

function loadSettings(): AccessibilitySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadOnboarded(): boolean {
  return localStorage.getItem(ONBOARD_KEY) === 'true';
}

function loadLanguage(): LanguageCode {
  try {
    const stored = localStorage.getItem(LANG_KEY) as LanguageCode | null;
    if (stored) return stored;
    const browser = navigator.language.slice(0, 2) as LanguageCode;
    const valid: LanguageCode[] = ['en','es','zh','hi','fr','de','ar','fa','ja'];
    if (valid.includes(browser)) return browser;
  } catch { /* noop */ }
  return 'en';
}

function loadRecentLanguages(): LanguageCode[] {
  try {
    const raw = localStorage.getItem(RECENT_LANG_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as LanguageCode[];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  CSS application                                                    */
/* ------------------------------------------------------------------ */

function buildCSSVars(s: AccessibilitySettings): string {
  const filters: string[] = [];
  if (s.invertColors) filters.push('invert(1) hue-rotate(180deg)');
  if (s.grayscale) filters.push('grayscale(1)');
  if (s.monochrome) filters.push('grayscale(1) contrast(1.1)');
  if (s.highSaturation) filters.push('saturate(1.8)');
  if (s.lowSaturation) filters.push('saturate(0.5)');

  const parts: string[] = [];

  parts.push(`--a11y-font-scale: ${s.textSize}`);
  parts.push(`--a11y-content-scale: ${s.contentScale}`);
  parts.push(`--a11y-line-height: ${s.lineHeight}`);
  parts.push(`--a11y-letter-spacing: ${s.letterSpacing}em`);
  parts.push(`--a11y-word-spacing: ${s.wordSpacing}em`);

  if (filters.length > 0) {
    parts.push(`--a11y-filter: ${filters.join(' ')}`);
  } else {
    parts.push(`--a11y-filter: none`);
  }

  return parts.join('; ');
}

function buildSettingsClass(s: AccessibilitySettings): string {
  const classes: string[] = [];
  if (s.readableFont) classes.push('a11y-readable-font');
  if (s.dyslexiaFont) classes.push('a11y-dyslexia-font');
  if (s.largeCursor) classes.push('a11y-large-cursor');
  if (s.highlightLinks) classes.push('a11y-highlight-links');
  if (s.highlightHeadings) classes.push('a11y-highlight-headings');
  if (s.strongFocus || s.highlightKeyboardFocus) classes.push('a11y-strong-focus');
  if (s.highContrast) classes.push('a11y-high-contrast');
  if (s.darkContrast) classes.push('a11y-dark-contrast');
  if (s.lightContrast) classes.push('a11y-light-contrast');
  if (s.readingMode) classes.push('a11y-reading-mode');
  if (s.reduceMotion || s.stopAnimations) classes.push('a11y-reduce-motion');
  if (s.hideImages) classes.push('a11y-hide-images');
  if (s.screenReaderMode) classes.push('a11y-screen-reader');
  return classes.join(' ');
}

function calculateScore(s: AccessibilitySettings): number {
  let score = 60;
  if (s.strongFocus || s.highlightKeyboardFocus) score += 8;
  if (s.highlightLinks) score += 5;
  if (s.highlightHeadings) score += 5;
  if (s.lineHeight >= 1.7) score += 5;
  if (s.textSize > 1) score += 4;
  if (s.reduceMotion) score += 4;
  if (s.readableFont || s.dyslexiaFont) score += 3;
  if (s.highContrast) score += 3;
  if (s.readingMode) score += 3;
  return Math.min(100, score);
}

function detectActiveProfile(s: AccessibilitySettings): string | null {
  for (const p of PROFILES) {
    const keys = Object.keys(p.settings) as (keyof AccessibilitySettings)[];
    const matches = keys.every((k) => s[k] === p.settings[k]);
    if (matches && keys.length > 0) return p.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AccessibilitySettings>(loadSettings);
  const [hasOnboarded, setHasOnboardedState] = useState<boolean>(loadOnboarded);
  const [language, setLanguageState] = useState<LanguageCode>(loadLanguage);
  const [recentLanguages, setRecentLanguages] = useState<LanguageCode[]>(loadRecentLanguages);

  const updateSetting = useCallback(
    <K extends keyof AccessibilitySettings>(key: K, value: AccessibilitySettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const applyProfile = useCallback((profile: AccessibilityProfile) => {
    setSettings((prev) => ({ ...prev, ...profile.settings }));
  }, []);

  const resetAll = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const setHasOnboarded = useCallback((v: boolean) => {
    setHasOnboardedState(v);
    localStorage.setItem(ONBOARD_KEY, String(v));
  }, []);

  const setLanguage = useCallback((code: LanguageCode) => {
    setLanguageState(code);
    localStorage.setItem(LANG_KEY, code);
    setRecentLanguages((prev) => {
      const updated = [code, ...prev.filter((l) => l !== code)].slice(0, 3);
      localStorage.setItem(RECENT_LANG_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const t = useCallback((key: TranslationKey) => {
    return TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key;
  }, [language]);

  const rtl = isRTL(language);

  // Persist + apply CSS
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    const root = document.documentElement;
    root.setAttribute('style', buildCSSVars(settings));
    const cls = buildSettingsClass(settings);
    root.classList.remove(
      'a11y-readable-font', 'a11y-dyslexia-font', 'a11y-large-cursor',
      'a11y-highlight-links', 'a11y-highlight-headings', 'a11y-strong-focus',
      'a11y-high-contrast', 'a11y-dark-contrast', 'a11y-light-contrast',
      'a11y-reading-mode', 'a11y-reduce-motion', 'a11y-hide-images',
      'a11y-screen-reader'
    );
    if (cls) {
      cls.split(' ').forEach((c) => root.classList.add(c));
    }
  }, [settings]);

  // Apply RTL/LTR direction
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    root.setAttribute('lang', language);
    if (rtl) root.classList.add('a11y-rtl');
    else root.classList.remove('a11y-rtl');
  }, [language, rtl]);

  const score = calculateScore(settings);
  const activeProfile = detectActiveProfile(settings);

  return (
    <AccessibilityContext.Provider
      value={{ settings, updateSetting, applyProfile, resetAll, activeProfile, score, hasOnboarded, setHasOnboarded, language, setLanguage, recentLanguages, t, rtl }}
    >
      {children}
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error('useAccessibility must be used within AccessibilityProvider');
  return ctx;
}
