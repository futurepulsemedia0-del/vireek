import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enFair from '@/locales/fairSale/en.json';

export const FAIR_SALE_NS = 'fairSale';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/fairSale/*.json', '!../locales/fairSale/en.json'], {
  import: 'default',
}) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', FAIR_SALE_NS)) {
  i18n.addResourceBundle('en', FAIR_SALE_NS, enFair, true, true);
}

async function loadFairSaleLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, FAIR_SALE_NS)) return;
  const loader = loaders[`../locales/fairSale/${base}.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, FAIR_SALE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${FAIR_SALE_NS}" for "${base}"`, err);
  }
}

export function useFairSaleT() {
  const { t, i18n: instance } = useTranslation(FAIR_SALE_NS, { useSuspense: false });
  useEffect(() => {
    void loadFairSaleLocale(instance, instance.language);
    const onChange = (lng: string) => {
      void loadFairSaleLocale(instance, lng);
    };
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
