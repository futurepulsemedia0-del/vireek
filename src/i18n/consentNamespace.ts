/* ------------------------------------------------------------------ */
/*  `consent` i18n namespace for the cookie banner + preference center. */
/*  English is bundled (fallback); other languages load on demand.      */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enConsent from '@/locales/consent/en.json';

export const CONSENT_NS = 'consent';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/consent/*.json', '!../locales/consent/en.json'], {
  import: 'default',
}) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', CONSENT_NS)) {
  i18n.addResourceBundle('en', CONSENT_NS, enConsent, true, true);
}

async function loadConsentLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, CONSENT_NS)) return;
  const loader = loaders[`../locales/consent/${base}.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, CONSENT_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${CONSENT_NS}" for "${base}"`, err);
  }
}

export function useConsentT() {
  const { t, i18n: instance } = useTranslation(CONSENT_NS, { useSuspense: false });
  useEffect(() => {
    void loadConsentLocale(instance, instance.language);
    const onChange = (lng: string) => {
      void loadConsentLocale(instance, lng);
    };
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
