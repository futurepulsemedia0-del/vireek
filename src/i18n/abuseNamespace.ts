/* `abuse` i18n namespace: staff abuse dashboard, restriction notice, auth challenge copy.   */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enAbuse from '@/locales/en/abuse.json';

export const ABUSE_NS = 'abuse';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/abuse.json', '!../locales/en/abuse.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', ABUSE_NS)) {
  i18n.addResourceBundle('en', ABUSE_NS, enAbuse, true, true);
}

async function loadAbuseLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, ABUSE_NS)) return;
  const loader = loaders[`../locales/${base}/abuse.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, ABUSE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${ABUSE_NS}" for "${base}"`, err);
  }
}

export function useAbuseT() {
  const { t, i18n: instance } = useTranslation(ABUSE_NS, { useSuspense: false });
  useEffect(() => {
    void loadAbuseLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadAbuseLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
