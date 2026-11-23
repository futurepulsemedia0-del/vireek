/* `legalAcceptance` i18n namespace: the terms re-acceptance screen. English is bundled (fallback); the other   */
/* eight languages load on demand; a missing file falls back to English.                                          */
/* [COUNSEL] Every string in locales/*/legalAcceptance.json is user-facing legal-adjacent wording. The fa/ar/de/   */
/* es/fr/hi/ja/zh versions are machine-assisted drafts and must be reviewed by counsel / a native legal reviewer   */
/* before this feature is enabled for customers.                                                                  */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enLegal from '@/locales/en/legalAcceptance.json';

export const LEGAL_ACCEPTANCE_NS = 'legalAcceptance';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/legalAcceptance.json', '!../locales/en/legalAcceptance.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', LEGAL_ACCEPTANCE_NS)) {
  i18n.addResourceBundle('en', LEGAL_ACCEPTANCE_NS, enLegal, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, LEGAL_ACCEPTANCE_NS)) return;
  const loader = loaders[`../locales/${base}/legalAcceptance.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, LEGAL_ACCEPTANCE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${LEGAL_ACCEPTANCE_NS}" for "${base}"`, err);
  }
}

export function useLegalAcceptanceT() {
  const { t, i18n: instance } = useTranslation(LEGAL_ACCEPTANCE_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
