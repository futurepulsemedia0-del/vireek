// Registers the `capacityGuard` namespace. English is the fallback for languages without their own file.
import i18n from '@/i18n';
import en from '@/locales/en/capacityGuard.json';
import fa from '@/locales/fa/capacityGuard.json';

export const CAPACITY_GUARD_NS = 'capacityGuard';

i18n.addResourceBundle('en', CAPACITY_GUARD_NS, en, true, true);
i18n.addResourceBundle('fa', CAPACITY_GUARD_NS, fa, true, true);
