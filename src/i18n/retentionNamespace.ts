/* ------------------------------------------------------------------ */
/*  `retention` i18n namespace for the Technician Retention Engine.    */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a retention.json simply falls back to English.             */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enRetention from '@/locales/en/retention.json';

export const RETENTION_NS = 'retention';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/retention.json', '!../locales/en/retention.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', RETENTION_NS)) {
  i18n.addResourceBundle('en', RETENTION_NS, enRetention, true, true);
}

async function loadRetentionLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, RETENTION_NS)) return;
  const loader = loaders[`../locales/${base}/retention.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, RETENTION_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${RETENTION_NS}" for "${base}"`, err);
  }
}

export function useRetentionT() {
  const { t, i18n: instance } = useTranslation(RETENTION_NS, { useSuspense: false });
  useEffect(() => {
    void loadRetentionLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadRetentionLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
