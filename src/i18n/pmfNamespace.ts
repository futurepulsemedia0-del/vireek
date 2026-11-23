/* ------------------------------------------------------------------ */
/*  `pmf` i18n namespace: the in-app PMF survey and the staff          */
/*  /staff/pmf page. English is bundled; other languages are lazy      */
/*  chunks and fall back to English when missing.                      */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enPmf from '@/locales/en/pmf.json';

export const PMF_NS = 'pmf';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/pmf.json', '!../locales/en/pmf.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', PMF_NS)) {
  i18n.addResourceBundle('en', PMF_NS, enPmf, true, true);
}

async function loadPmfLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PMF_NS)) return;
  const loader = loaders[`../locales/${base}/pmf.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, PMF_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${PMF_NS}" for "${base}"`, err);
  }
}

export function usePmfT() {
  const { t, i18n: instance } = useTranslation(PMF_NS, { useSuspense: false });
  useEffect(() => {
    void loadPmfLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadPmfLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
