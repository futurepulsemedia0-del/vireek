/* `consumerAgent` i18n namespace: owner page for AI-agent requests.                              */
/* English is bundled (fallback); other languages load on demand; a missing file => English.      */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enConsumerAgent from '@/locales/en/consumerAgent.json';

export const CONSUMER_AGENT_NS = 'consumerAgent';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/consumerAgent.json', '!../locales/en/consumerAgent.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', CONSUMER_AGENT_NS)) {
  i18n.addResourceBundle('en', CONSUMER_AGENT_NS, enConsumerAgent, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, CONSUMER_AGENT_NS)) return;
  const loader = loaders[`../locales/${base}/consumerAgent.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, CONSUMER_AGENT_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${CONSUMER_AGENT_NS}" for "${base}"`, err);
  }
}

export function useConsumerAgentT() {
  const { t, i18n: instance } = useTranslation(CONSUMER_AGENT_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
