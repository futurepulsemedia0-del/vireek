/* ------------------------------------------------------------------ */
/*  `storedValue` i18n namespace. English is bundled; other languages are lazy  */
/*  chunks (src/locales/<lng>/storedValue.json) and fall back to English.        */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import en from '@/locales/en/storedValue.json';

export const STORED_VALUE_NS = 'storedValue';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/storedValue.json', '!../locales/en/storedValue.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', STORED_VALUE_NS)) {
  i18n.addResourceBundle('en', STORED_VALUE_NS, en, true, true);
}

async function loadStoredValueLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, STORED_VALUE_NS)) return;
  const loader = loaders[`../locales/${base}/storedValue.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, STORED_VALUE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${STORED_VALUE_NS}" for "${base}"`, err); // non-fatal: falls back to English
  }
}

export function useStoredValueT() {
  const { t, i18n: instance } = useTranslation(STORED_VALUE_NS, { useSuspense: false });
  useEffect(() => {
    void loadStoredValueLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadStoredValueLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
