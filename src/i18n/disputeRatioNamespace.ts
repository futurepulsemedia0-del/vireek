/* ------------------------------------------------------------------ */
/*  `disputeRatio` i18n namespace. English is bundled; other languages are lazy  */
/*  chunks (src/locales/<lng>/disputeRatio.json) and fall back to English.        */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import en from '@/locales/en/disputeRatio.json';

export const DISPUTE_RATIO_NS = 'disputeRatio';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/disputeRatio.json', '!../locales/en/disputeRatio.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', DISPUTE_RATIO_NS)) {
  i18n.addResourceBundle('en', DISPUTE_RATIO_NS, en, true, true);
}

async function loadDisputeRatioLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, DISPUTE_RATIO_NS)) return;
  const loader = loaders[`../locales/${base}/disputeRatio.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, DISPUTE_RATIO_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${DISPUTE_RATIO_NS}" for "${base}"`, err); // non-fatal: falls back to English
  }
}

export function useDisputeRatioT() {
  const { t, i18n: instance } = useTranslation(DISPUTE_RATIO_NS, { useSuspense: false });
  useEffect(() => {
    void loadDisputeRatioLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadDisputeRatioLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
