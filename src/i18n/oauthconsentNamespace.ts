/* ------------------------------------------------------------------ */
/*  `oauthconsent` i18n namespace: MCP OAuth consent screen (/oauth/authorize).  */
/*  English is bundled (fallback); other languages load on demand.     */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enOauthconsent from '@/locales/en/oauthconsent.json';

export const OAUTHCONSENT_NS = 'oauthconsent';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/oauthconsent.json', '!../locales/en/oauthconsent.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', OAUTHCONSENT_NS)) {
  i18n.addResourceBundle('en', OAUTHCONSENT_NS, enOauthconsent, true, true);
}

async function loadOauthconsentLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, OAUTHCONSENT_NS)) return;
  const loader = loaders[`../locales/${base}/oauthconsent.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, OAUTHCONSENT_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${OAUTHCONSENT_NS}" for "${base}"`, err);
  }
}

export function useOauthconsentT() {
  const { t, i18n: instance } = useTranslation(OAUTHCONSENT_NS, { useSuspense: false });
  useEffect(() => {
    void loadOauthconsentLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadOauthconsentLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
