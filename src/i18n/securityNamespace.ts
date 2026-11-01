/* `security` i18n namespace: step-up dialog, account Activity, security banner.            */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enSecurity from '@/locales/en/security.json';

export const SECURITY_NS = 'security';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/security.json', '!../locales/en/security.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', SECURITY_NS)) {
  i18n.addResourceBundle('en', SECURITY_NS, enSecurity, true, true);
}

async function loadSecurityLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, SECURITY_NS)) return;
  const loader = loaders[`../locales/${base}/security.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, SECURITY_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${SECURITY_NS}" for "${base}"`, err);
  }
}

export function useSecurityT() {
  const { t, i18n: instance } = useTranslation(SECURITY_NS, { useSuspense: false });
  useEffect(() => {
    void loadSecurityLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadSecurityLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
