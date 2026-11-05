/* `autopilot` i18n namespace: A/B experiments, Voice Autopilot, weekly report, staff QA.              */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enAutopilot from '@/locales/en/autopilot.json';

export const AUTOPILOT_NS = 'autopilot';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/autopilot.json', '!../locales/en/autopilot.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', AUTOPILOT_NS)) {
  i18n.addResourceBundle('en', AUTOPILOT_NS, enAutopilot, true, true);
}

async function loadAutopilotLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, AUTOPILOT_NS)) return;
  const loader = loaders[`../locales/${base}/autopilot.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, AUTOPILOT_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${AUTOPILOT_NS}" for "${base}"`, err);
  }
}

export function useAutopilotT() {
  const { t, i18n: instance } = useTranslation(AUTOPILOT_NS, { useSuspense: false });
  useEffect(() => {
    void loadAutopilotLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadAutopilotLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
