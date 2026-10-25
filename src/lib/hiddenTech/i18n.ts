// src/lib/hiddenTech/i18n.ts
//
// Registers the `hiddenTech` namespace on the shared i18next instance. English is the fallback for every
// language that does not have its own file yet: add src/locales/<code>/hiddenTech.json and one line below.

import i18n from '@/i18n';
import en from '@/locales/en/hiddenTech.json';
import fa from '@/locales/fa/hiddenTech.json';

export const HIDDEN_TECH_NS = 'hiddenTech';

i18n.addResourceBundle('en', HIDDEN_TECH_NS, en, true, true);
i18n.addResourceBundle('fa', HIDDEN_TECH_NS, fa, true, true);
