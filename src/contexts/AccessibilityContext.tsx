import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { type LanguageCode, type TranslationKey, TRANSLATIONS, isRTL } from '@/lib/i18n';
import i18n from '@/i18n';
import { applyDocumentLanguage, clearUrlLanguage, resolveInitialLanguage, storeLanguage } from '@/lib/languageSync';
import { DEFAULT_SETTINGS, sanitizeSettings, type AccessibilitySettings } from '@/lib/a11y/settings';
import { MotionConfig } from 'framer-motion';
import { SkipLinks } from '@/components/a11y/SkipLinks';
import { applyToDocument } from '@/lib/a11y/apply';
import { detectSystemPreferences } from '@/lib/a11y/system';
export type { AccessibilitySettings, ColorBlindMode } from '@/lib/a11y/settings';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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
  replaceSettings: (s: AccessibilitySettings) => void;
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
const RECENT_LANG_KEY = 'vireek-a11y-recent-langs';

function loadSettings(): AccessibilitySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch {
    /* storage blocked or corrupt JSON → fall through to defaults */
  }
  return sanitizeSettings(detectSystemPreferences(window));
}

function loadOnboarded(): boolean {
  return localStorage.getItem(ONBOARD_KEY) === 'true';
}

function loadLanguage(): LanguageCode {
  return resolveInitialLanguage();
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

  const replaceSettings = useCallback((s: AccessibilitySettings) => setSettings(sanitizeSettings(s)), []);
  const resetAll = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const setHasOnboarded = useCallback((v: boolean) => {
    setHasOnboardedState(v);
    localStorage.setItem(ONBOARD_KEY, String(v));
  }, []);

  const setLanguage = useCallback((code: LanguageCode) => {
    setLanguageState(code);
    storeLanguage(code);
    clearUrlLanguage();
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

   // Persist + apply (only --a11y-* vars and managed classes are touched)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode / quota: settings still apply for this session */
    }
    applyToDocument(settings);
  }, [settings]);

    // Keep <html lang/dir> and react-i18next in sync with the single language state.
  useEffect(() => {
    applyDocumentLanguage(language);
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [language]);

  const score = calculateScore(settings);
  const activeProfile = detectActiveProfile(settings);

  return (
    <AccessibilityContext.Provider
      value={{ settings, updateSetting, applyProfile, resetAll, replaceSettings, activeProfile, score, hasOnboarded, setHasOnboarded, language, setLanguage, recentLanguages, t, rtl }}
    >
      <MotionConfig reducedMotion={settings.reduceMotion || settings.stopAnimations ? 'always' : 'user'}>
        <SkipLinks language={language} />
        {children}
      </MotionConfig>
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error('useAccessibility must be used within AccessibilityProvider');
  return ctx;
}
