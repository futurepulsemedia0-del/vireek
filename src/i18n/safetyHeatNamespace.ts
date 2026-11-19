/* `safetyHeat` i18n namespace. English is bundled (fallback); Persian ships too; any other language falls back to English. */
import i18n from '@/i18n';
import en from '@/locales/en/safetyHeat.json';
import fa from '@/locales/fa/safetyHeat.json';

export const SAFETY_HEAT_NS = 'safetyHeat';

for (const [lng, res] of [['en', en], ['fa', fa]] as const) {
  if (!i18n.hasResourceBundle(lng, SAFETY_HEAT_NS)) i18n.addResourceBundle(lng, SAFETY_HEAT_NS, res, true, true);
}
