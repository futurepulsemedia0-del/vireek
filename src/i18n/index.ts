/* ------------------------------------------------------------------ */
/*  i18next core setup for site-wide (marketing + dashboard) content.  */
/*                                                                      */
/*  This is deliberately SEPARATE from src/lib/i18n.ts, which remains  */
/*  the dictionary powering only the Accessibility widget's own UI.    */
/*  This module drives react-i18next's `useTranslation()` hook, used   */
/*  across pages and shared components (Header, Footer, etc.).         */
/*                                                                      */
/*  Language selection itself still has ONE source of truth:           */
/*  AccessibilityContext's `language` state (localStorage key          */
/*  'vireek-a11y-lang'). AccessibilityContext calls `i18n.changeLanguage`*/
/*  whenever that state changes, so this file never manages its own    */
/*  persistence or a competing language switcher.                      */
/* ------------------------------------------------------------------ */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enCommon from '@/locales/en/common.json';
import esCommon from '@/locales/es/common.json';
import zhCommon from '@/locales/zh/common.json';
import hiCommon from '@/locales/hi/common.json';
import frCommon from '@/locales/fr/common.json';
import deCommon from '@/locales/de/common.json';
import arCommon from '@/locales/ar/common.json';
import faCommon from '@/locales/fa/common.json';
import jaCommon from '@/locales/ja/common.json';
import enForms from '@/locales/en/forms.json';
import esForms from '@/locales/es/forms.json';
import esTrust from '@/locales/es/trust.json';
import zhForms from '@/locales/zh/forms.json';
import hiForms from '@/locales/hi/forms.json';
import frForms from '@/locales/fr/forms.json';
import deForms from '@/locales/de/forms.json';
import arForms from '@/locales/ar/forms.json';
import faForms from '@/locales/fa/forms.json';
import jaForms from '@/locales/ja/forms.json';
import { resolveInitialLanguage } from '@/lib/languageSync';
import enDashboard from '@/locales/en/dashboard.json';
import enTrust from '@/locales/en/trust.json';
import faTrust from '@/locales/fa/trust.json';
import { registerLazyLocales } from '@/i18n/lazyLocales';
import { registerProductivityLocales } from '@/i18n/productivityLocales';

function getInitialLanguage(): string {
  return resolveInitialLanguage();
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon, dashboard: enDashboard, trust: enTrust, forms: enForms },
    es: { common: esCommon, forms: esForms, trust: esTrust },
    zh: { common: zhCommon, forms: zhForms },
    hi: { common: hiCommon, forms: hiForms },
    fr: { common: frCommon, forms: frForms },
    de: { common: deCommon, forms: deForms },
    ar: { common: arCommon, forms: arForms },
    fa: { common: faCommon, trust: faTrust, forms: faForms },
    ja: { common: jaCommon, forms: jaForms },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  ns: ['common', 'dashboard', 'trust', 'forms'],
  defaultNS: 'common',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  returnEmptyString: false,
  react: { bindI18nStore: 'added' },
});

registerLazyLocales(i18n);
registerProductivityLocales(i18n);
export default i18n;
