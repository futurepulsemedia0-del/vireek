// Registers the `accessLog` namespace. English is the fallback for languages without their own file.
import i18n from '@/i18n';
import en from '@/locales/en/accessLog.json';
import fa from '@/locales/fa/accessLog.json';

export const ACCESS_LOG_NS = 'accessLog';

i18n.addResourceBundle('en', ACCESS_LOG_NS, en, true, true);
i18n.addResourceBundle('fa', ACCESS_LOG_NS, fa, true, true);
