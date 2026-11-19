/* `numberHealth` i18n namespace. English is bundled (fallback); Persian ships too; any other language falls back to English. */
import i18n from '@/i18n';
import en from '@/locales/en/numberHealth.json';
import fa from '@/locales/fa/numberHealth.json';

export const NUMBER_HEALTH_NS = 'numberHealth';

for (const [lng, res] of [['en', en], ['fa', fa]] as const) {
  if (!i18n.hasResourceBundle(lng, NUMBER_HEALTH_NS)) i18n.addResourceBundle(lng, NUMBER_HEALTH_NS, res, true, true);
}
