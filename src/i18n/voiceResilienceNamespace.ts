/* `voiceResilience` i18n namespace. English is bundled (fallback); other languages load on demand,
   and a language without a voiceResilience.json falls back to English. Same pattern as retentionNamespace.ts. */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/voiceResilience.json';

export const VOICE_RESILIENCE_NS = 'voiceResilience';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/voiceResilience.json', '!../locales/en/voiceResilience.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', VOICE_RESILIENCE_NS)) {
  i18n.addResourceBundle('en', VOICE_RESILIENCE_NS, enNs, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, VOICE_RESILIENCE_NS)) return;
  const loader = loaders[`../locales/${base}/voiceResilience.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, VOICE_RESILIENCE_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${VOICE_RESILIENCE_NS}" for "${base}"`, err);
  }
}

export function useVoiceResilienceT() {
  const { t, i18n: instance } = useTranslation(VOICE_RESILIENCE_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
