/* `marketplaceVetting` i18n namespace: staff marketplace app vetting page.                  */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/marketplaceVetting.json';

export const MARKETPLACE_VETTING_NS = 'marketplaceVetting';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/marketplaceVetting.json', '!../locales/en/marketplaceVetting.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', MARKETPLACE_VETTING_NS)) {
  i18n.addResourceBundle('en', MARKETPLACE_VETTING_NS, enNs, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, MARKETPLACE_VETTING_NS)) return;
  const loader = loaders[`../locales/${base}/marketplaceVetting.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, MARKETPLACE_VETTING_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${MARKETPLACE_VETTING_NS}" for "${base}"`, err);
  }
}

export function useMarketplaceVettingT() {
  const { t, i18n: instance } = useTranslation(MARKETPLACE_VETTING_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
