/* ------------------------------------------------------------------ */
/*  `renewalDisclosure` i18n namespace: auto-renewal terms shown at    */
/*  purchase time. English is bundled; other languages are lazy        */
/*  chunks and fall back to English when missing.                      */
/*  [COUNSEL] approve the English copy before translating further.     */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enRenewal from '@/locales/en/renewalDisclosure.json';

export const RENEWAL_DISCLOSURE_NS = 'renewalDisclosure';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/renewalDisclosure.json', '!../locales/en/renewalDisclosure.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', RENEWAL_DISCLOSURE_NS)) {
  i18n.addResourceBundle('en', RENEWAL_DISCLOSURE_NS, enRenewal, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, RENEWAL_DISCLOSURE_NS)) return;
  const loader = loaders[`../locales/${base}/renewalDisclosure.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, RENEWAL_DISCLOSURE_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${RENEWAL_DISCLOSURE_NS}" for "${base}"`, err);
  }
}

export function useRenewalDisclosureT() {
  const { t, i18n: instance } = useTranslation(RENEWAL_DISCLOSURE_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
