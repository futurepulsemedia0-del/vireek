/* `compliance` i18n namespace: internal control dashboard + public Trust Center claims.      */
/* English is bundled (fallback); other languages load on demand; a missing file => English.   */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enCompliance from '@/locales/en/compliance.json';

export const COMPLIANCE_NS = 'compliance';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/compliance.json', '!../locales/en/compliance.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', COMPLIANCE_NS)) {
  i18n.addResourceBundle('en', COMPLIANCE_NS, enCompliance, true, true);
}

async function loadComplianceLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, COMPLIANCE_NS)) return;
  const loader = loaders[`../locales/${base}/compliance.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, COMPLIANCE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${COMPLIANCE_NS}" for "${base}"`, err);
  }
}

export function useComplianceT() {
  const { t, i18n: instance } = useTranslation(COMPLIANCE_NS, { useSuspense: false });
  useEffect(() => {
    void loadComplianceLocale(instance, instance.language);
    const onChange = (lng: string) => {
      void loadComplianceLocale(instance, lng);
    };
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
