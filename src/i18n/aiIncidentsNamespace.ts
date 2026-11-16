/* `aiIncidents` i18n namespace: staff AI incident register page.                           */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enAiIncidents from '@/locales/en/aiIncidents.json';

export const AI_INCIDENTS_NS = 'aiIncidents';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/aiIncidents.json', '!../locales/en/aiIncidents.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', AI_INCIDENTS_NS)) {
  i18n.addResourceBundle('en', AI_INCIDENTS_NS, enAiIncidents, true, true);
}

async function loadAiIncidentsLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, AI_INCIDENTS_NS)) return;
  const loader = loaders[`../locales/${base}/aiIncidents.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, AI_INCIDENTS_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${AI_INCIDENTS_NS}" for "${base}"`, err);
  }
}

export function useAiIncidentsT() {
  const { t, i18n: instance } = useTranslation(AI_INCIDENTS_NS, { useSuspense: false });
  useEffect(() => {
    void loadAiIncidentsLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadAiIncidentsLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
