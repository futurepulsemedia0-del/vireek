/* ------------------------------------------------------------------ */
/*  `churnSave` i18n namespace: churn-save offers (cancel flow) and    */
/*  the staff /staff/churn-save page. English is bundled; other        */
/*  languages are lazy chunks and fall back to English when missing.   */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enChurnSave from '@/locales/en/churnSave.json';

export const CHURN_SAVE_NS = 'churnSave';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/churnSave.json', '!../locales/en/churnSave.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', CHURN_SAVE_NS)) {
  i18n.addResourceBundle('en', CHURN_SAVE_NS, enChurnSave, true, true);
}

async function loadChurnSaveLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, CHURN_SAVE_NS)) return;
  const loader = loaders[`../locales/${base}/churnSave.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, CHURN_SAVE_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${CHURN_SAVE_NS}" for "${base}"`, err);
  }
}

export function useChurnSaveT() {
  const { t, i18n: instance } = useTranslation(CHURN_SAVE_NS, { useSuspense: false });
  useEffect(() => {
    void loadChurnSaveLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadChurnSaveLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
