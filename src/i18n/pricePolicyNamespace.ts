/* `pricePolicy` i18n namespace: Price-First Playbook dashboard.                              */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enPricePolicy from '@/locales/en/pricePolicy.json';

export const PRICE_POLICY_NS = 'pricePolicy';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/pricePolicy.json', '!../locales/en/pricePolicy.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', PRICE_POLICY_NS)) {
  i18n.addResourceBundle('en', PRICE_POLICY_NS, enPricePolicy, true, true);
}

async function loadPricePolicyLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PRICE_POLICY_NS)) return;
  const loader = loaders[`../locales/${base}/pricePolicy.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, PRICE_POLICY_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${PRICE_POLICY_NS}" for "${base}"`, err);
  }
}

export function usePricePolicyT() {
  const { t, i18n: instance } = useTranslation(PRICE_POLICY_NS, { useSuspense: false });
  useEffect(() => {
    void loadPricePolicyLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadPricePolicyLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
