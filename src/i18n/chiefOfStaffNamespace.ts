/* `chiefOfStaff` i18n namespace. English is bundled (fallback); other languages load on demand;     */
/* a missing file => English. Shipped languages: en, es, fr, de, ar, fa, hi, ja, zh.*/

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enChief from '@/locales/en/chiefOfStaff.json';

export const CHIEF_NS = 'chiefOfStaff';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/chiefOfStaff.json', '!../locales/en/chiefOfStaff.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', CHIEF_NS)) {
  i18n.addResourceBundle('en', CHIEF_NS, enChief, true, true);
}

async function loadChiefLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, CHIEF_NS)) return;
  const loader = loaders[`../locales/${base}/chiefOfStaff.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, CHIEF_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${CHIEF_NS}" for "${base}"`, err);
  }
}

export function useChiefT() {
  const { t, i18n: instance } = useTranslation(CHIEF_NS, { useSuspense: false });
  useEffect(() => {
    void loadChiefLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadChiefLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
