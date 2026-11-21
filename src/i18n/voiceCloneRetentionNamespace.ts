/* `voiceCloneRetention` i18n namespace: retention picker + summary on the voice-clone consent card.   */
/* English is bundled (fallback); other languages load on demand; a missing file falls back to English. */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/voiceCloneRetention.json';

export const VOICE_CLONE_RETENTION_NS = 'voiceCloneRetention';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/voiceCloneRetention.json', '!../locales/en/voiceCloneRetention.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', VOICE_CLONE_RETENTION_NS)) {
  i18n.addResourceBundle('en', VOICE_CLONE_RETENTION_NS, enNs, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, VOICE_CLONE_RETENTION_NS)) return;
  const loader = loaders[`../locales/${base}/voiceCloneRetention.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, VOICE_CLONE_RETENTION_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${VOICE_CLONE_RETENTION_NS}" for "${base}"`, err);
  }
}

export function useVoiceCloneRetentionT() {
  const { t, i18n: instance } = useTranslation(VOICE_CLONE_RETENTION_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
