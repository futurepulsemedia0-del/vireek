import { DEFAULT_SETTINGS, type AccessibilitySettings } from './settings';
import type { A11yKey } from './strings';

export type ProfileId = 'blind' | 'lowVision' | 'colorBlind' | 'dyslexia' | 'adhd' | 'seizure' | 'senior' | 'motor' | 'autism';

export interface ProfileDef {
  id: ProfileId;
  nameKey: A11yKey;
  descKey: A11yKey;
  settings: Partial<AccessibilitySettings>;
}

export const PROFILE_DEFS: readonly ProfileDef[] = [
  { id: 'blind', nameKey: 'prof_blind', descKey: 'prof_blind_d', settings: { screenReaderMode: true, strongFocus: true, highlightLinks: true, highlightHeadings: true, stopAnimations: true, largeTargets: true } },
  { id: 'lowVision', nameKey: 'prof_lowVision', descKey: 'prof_lowVision_d', settings: { textSize: 1.25, contentScale: 1.1, highContrast: true, strongFocus: true, largeCursor: true, highlightLinks: true, magnifier: true, lineHeight: 1.8, largeTargets: true } },
  { id: 'colorBlind', nameKey: 'prof_colorBlind', descKey: 'prof_colorBlind_d', settings: { colorBlind: 'deuteranopia', highlightLinks: true, strongFocus: true } },
  { id: 'dyslexia', nameKey: 'prof_dyslexia', descKey: 'prof_dyslexia_d', settings: { dyslexiaFont: true, lineHeight: 1.9, letterSpacing: 0.06, wordSpacing: 0.12, readingGuide: true, readingMode: true } },
  { id: 'adhd', nameKey: 'prof_adhd', descKey: 'prof_adhd_d', settings: { focusMode: true, readingGuide: true, readingMode: true, reduceMotion: true, stopAnimations: true, highlightHeadings: true } },
  { id: 'seizure', nameKey: 'prof_seizure', descKey: 'prof_seizure_d', settings: { reduceMotion: true, stopAnimations: true, lowSaturation: true } },
  { id: 'senior', nameKey: 'prof_senior', descKey: 'prof_senior_d', settings: { textSize: 1.25, lineHeight: 1.8, simpleFont: true, strongFocus: true, highlightLinks: true, largeCursor: true, largeTargets: true } },
  { id: 'motor', nameKey: 'prof_motor', descKey: 'prof_motor_d', settings: { largeTargets: true, strongFocus: true, largeCursor: true, stopAnimations: true, reduceMotion: true } },
  { id: 'autism', nameKey: 'prof_autism', descKey: 'prof_autism_d', settings: { reduceMotion: true, stopAnimations: true, lowSaturation: true, focusMode: true, simpleFont: true } },
];

/** Keys a profile must never wipe: personal speech/shortcut preferences. */
const PRESERVED = ['shortcuts', 'ttsVoiceURI', 'ttsRate', 'ttsPitch', 'ttsVolume'] as const;

export function buildProfileSettings(current: AccessibilitySettings, def: ProfileDef): AccessibilitySettings {
  const kept: Partial<AccessibilitySettings> = {};
  for (const k of PRESERVED) Object.assign(kept, { [k]: current[k] });
  return { ...DEFAULT_SETTINGS, ...kept, ...def.settings };
}

const near = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b;

/** A profile is active when every key it defines matches AND no other feature flag deviates from default. */
export function detectActiveProfile(s: AccessibilitySettings): ProfileId | null {
  for (const def of PROFILE_DEFS) {
    const target = buildProfileSettings(s, def);
    const keys = Object.keys(DEFAULT_SETTINGS) as (keyof AccessibilitySettings)[];
    if (keys.every((k) => k === 'shortcuts' || near(s[k], target[k]))) return def.id;
  }
  return null;
}
