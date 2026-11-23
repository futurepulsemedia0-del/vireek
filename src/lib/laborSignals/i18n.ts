// Registers the `laborSignals` namespace. English is the fallback for languages without their own file.
// Keys under `disclaimer.*` are legal-adjacent: they stay "awaiting human review" for non-English locales
// until listed in docs/i18n/reviewed-keys.json (see scripts/i18n-coverage.mjs). [COUNSEL]
import i18n from '@/i18n';
import en from '@/locales/en/laborSignals.json';
import fa from '@/locales/fa/laborSignals.json';

export const LABOR_SIGNALS_NS = 'laborSignals';

i18n.addResourceBundle('en', LABOR_SIGNALS_NS, en, true, true);
i18n.addResourceBundle('fa', LABOR_SIGNALS_NS, fa, true, true);
