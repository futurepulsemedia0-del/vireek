import { useCallback, useSyncExternalStore } from 'react';
import {
  acceptAll,
  getConsentSnapshot,
  hasConsent,
  openConsentPreferences,
  rejectNonEssential,
  saveChoices,
  subscribeConsent,
  type ConsentCategory,
  type ConsentChoices,
  type ConsentSnapshot,
} from '@/lib/consent/engine';

export interface UseConsent extends ConsentSnapshot {
  hasConsent: (category: ConsentCategory) => boolean;
  acceptAll: () => void;
  rejectNonEssential: () => void;
  saveChoices: (choices: ConsentChoices) => void;
  openPreferences: () => void;
}

/** React binding for the consent engine. No provider needed: the engine is a module-level store. */
export function useConsent(): UseConsent {
  const snapshot = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  const check = useCallback((category: ConsentCategory) => snapshot.choices[category], [snapshot]);
  return {
    ...snapshot,
    hasConsent: check,
    acceptAll: () => void acceptAll(),
    rejectNonEssential: () => void rejectNonEssential(),
    saveChoices: (choices) => void saveChoices(choices),
    openPreferences: openConsentPreferences,
  };
}

export { hasConsent };
