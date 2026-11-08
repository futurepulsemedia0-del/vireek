/* `growth` i18n namespace for the staff growth analytics dashboard. English is bundled (fallback); other languages load on demand. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enGrowth from '@/locales/growth/en.json';

export const GROWTH_NS = 'growth';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/growth/*.json', '!../locales/growth/en.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', GROWTH_NS)) {
  i18n.addResourceBundle('en', GROWTH_NS, enGrowth, true, true);
}

async function loadGrowthLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, GROWTH_NS)) return;
  const loader = loaders[`../locales/growth/${base}.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, GROWTH_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${GROWTH_NS}" for "${base}"`, err);
  }
}

export function useGrowthT() {
  const { t, i18n: instance } = useTranslation(GROWTH_NS, { useSuspense: false });
  useEffect(() => {
    void loadGrowthLocale(instance, instance.language);
    const onChange = (lng: string) => void loadGrowthLocale(instance, lng);
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
