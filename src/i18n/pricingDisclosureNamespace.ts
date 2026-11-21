/* `pricingDisclosure` i18n namespace: personalized-pricing notice. English is bundled (fallback);   */
/* other languages load on demand; a language without a file falls back to English.                  */
/* Same pattern as pricePolicyNamespace.ts / voiceResilienceNamespace.ts.                            */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/pricingDisclosure.json';

export const PRICING_DISCLOSURE_NS = 'pricingDisclosure';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/pricingDisclosure.json', '!../locales/en/pricingDisclosure.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', PRICING_DISCLOSURE_NS)) {
  i18n.addResourceBundle('en', PRICING_DISCLOSURE_NS, enNs, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PRICING_DISCLOSURE_NS)) return;
  const loader = loaders[`../locales/${base}/pricingDisclosure.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, PRICING_DISCLOSURE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${PRICING_DISCLOSURE_NS}" for "${base}"`, err);
  }
}

export function usePricingDisclosureT() {
  const { t, i18n: instance } = useTranslation(PRICING_DISCLOSURE_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
