/* ------------------------------------------------------------------ */
/*  `voiceLog` i18n namespace for the Technician Voice Log.    */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a voiceLog.json simply falls back to English.             */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enVoiceLog from '@/locales/en/voiceLog.json';

export const VOICE_LOG_NS = 'voiceLog';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/voiceLog.json', '!../locales/en/voiceLog.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', VOICE_LOG_NS)) {
  i18n.addResourceBundle('en', VOICE_LOG_NS, enVoiceLog, true, true);
}

async function loadVoiceLogLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, VOICE_LOG_NS)) return;
  const loader = loaders[`../locales/${base}/voiceLog.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, VOICE_LOG_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${VOICE_LOG_NS}" for "${base}"`, err);
  }
}

export function useVoiceLogT() {
  const { t, i18n: instance } = useTranslation(VOICE_LOG_NS, { useSuspense: false });
  useEffect(() => {
    void loadVoiceLogLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadVoiceLogLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
