/* `revenueRealization` i18n namespace. English is bundled (fallback); other languages load on demand
   (same mechanism as retentionNamespace.ts). A language without a revenueRealization.json falls back to English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/revenueRealization.json';

export const RR_NS = 'revenueRealization';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/revenueRealization.json', '!../locales/en/revenueRealization.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', RR_NS)) i18n.addResourceBundle('en', RR_NS, enNs, true, true);

async function load(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, RR_NS)) return;
  const loader = loaders[`../locales/${base}/revenueRealization.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, RR_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${RR_NS}" for "${base}"`, err); // non-fatal: English fallback
  }
}

export function useRealizationT() {
  const { t, i18n: instance } = useTranslation(RR_NS, { useSuspense: false });
  useEffect(() => {
    void load(instance, instance.language);
    const onChange = (lng: string) => { void load(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
