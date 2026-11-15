// Self-registers the "sarahHub" i18n namespace (same pattern as sarahLearn) so no
// central i18n file has to change. Import this module for its side effect.
// Safe even if the module is evaluated before i18n.init() has finished.
import i18n from 'i18next';
import enHub from '@/locales/en/sarahHub.json';
import esHub from '@/locales/es/sarahHub.json';

export const HUB_NS = 'sarahHub';

function register(): void {
  if (!i18n.hasResourceBundle('en', HUB_NS)) i18n.addResourceBundle('en', HUB_NS, enHub, true, true);
  if (!i18n.hasResourceBundle('es', HUB_NS)) i18n.addResourceBundle('es', HUB_NS, esHub, true, true);
}

if (i18n.isInitialized) register();
else i18n.on('initialized', register);
