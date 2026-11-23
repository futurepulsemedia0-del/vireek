/* ------------------------------------------------------------------ */
/*  `offboarding` i18n namespace: post-cancellation guide, win-back    */
/*  unsubscribe page and /staff/offboarding. English is bundled; other */
/*  languages are lazy chunks and fall back to English when missing.   */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enOffboarding from '@/locales/en/offboarding.json';

export const OFFBOARDING_NS = 'offboarding';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/offboarding.json', '!../locales/en/offboarding.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', OFFBOARDING_NS)) {
  i18n.addResourceBundle('en', OFFBOARDING_NS, enOffboarding, true, true);
}

async function loadOffboardingLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, OFFBOARDING_NS)) return;
  const loader = loaders[`../locales/${base}/offboarding.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, OFFBOARDING_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${OFFBOARDING_NS}" for "${base}"`, err);
  }
}

export function useOffboardingT() {
  const { t, i18n: instance } = useTranslation(OFFBOARDING_NS, { useSuspense: false });
  useEffect(() => {
    void loadOffboardingLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadOffboardingLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
