/* ------------------------------------------------------------------ */
/*  `fmcheck` i18n namespace: portal pre-submission check, money at    */
/*  risk and rejection patterns in Work-Order Guard. English is        */
/*  bundled (fallback); other languages load on demand.                */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enFmcheck from '@/locales/en/fmcheck.json';

export const FMCHECK_NS = 'fmcheck';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/fmcheck.json', '!../locales/en/fmcheck.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', FMCHECK_NS)) {
  i18n.addResourceBundle('en', FMCHECK_NS, enFmcheck, true, true);
}

async function loadFmcheckLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, FMCHECK_NS)) return;
  const loader = loaders[`../locales/${base}/fmcheck.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, FMCHECK_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${FMCHECK_NS}" for "${base}"`, err);
  }
}

export function useFmcheckT() {
  const { t, i18n: instance } = useTranslation(FMCHECK_NS, { useSuspense: false });
  useEffect(() => {
    void loadFmcheckLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadFmcheckLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
