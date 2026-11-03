/* `agentCallers` i18n namespace. English is bundled (fallback); Persian ships too; any other language falls back to English. */
import i18n from '@/i18n';
import en from '@/locales/en/agentCallers.json';
import fa from '@/locales/fa/agentCallers.json';

export const AGENT_CALLERS_NS = 'agentCallers';

for (const [lng, res] of [['en', en], ['fa', fa]] as const) {
  if (!i18n.hasResourceBundle(lng, AGENT_CALLERS_NS)) i18n.addResourceBundle(lng, AGENT_CALLERS_NS, res, true, true);
}
