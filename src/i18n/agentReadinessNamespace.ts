/* `agentReadiness` i18n namespace. English is bundled (it is the fallback); every other language is its own
   chunk (src/locales/<lng>/agentReadiness.json), fetched the first time it is selected. */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enAgentReadiness from '@/locales/en/agentReadiness.json';

export const AGENT_READINESS_NS = 'agentReadiness';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/agentReadiness.json', '!../locales/en/agentReadiness.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', AGENT_READINESS_NS)) i18n.addResourceBundle('en', AGENT_READINESS_NS, enAgentReadiness, true, true);

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, AGENT_READINESS_NS)) return;
  const loader = loaders[`../locales/${base}/agentReadiness.json`];
  if (!loader) return;
  try { instance.addResourceBundle(base, AGENT_READINESS_NS, await loader(), true, true); }
  catch (err) { console.warn(`[i18n] Could not load "${AGENT_READINESS_NS}" for "${base}"`, err); }
}

export function useAgentReadinessT() {
  const { t, i18n: instance } = useTranslation(AGENT_READINESS_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
