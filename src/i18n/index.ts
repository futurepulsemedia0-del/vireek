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

const LANG_KEY = 'vireek-a11y-lang';

function getInitialLanguage(): string {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored) return stored;
    const browser = navigator.language.slice(0, 2);
    const supported = ['en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja'];
    if (supported.includes(browser)) return browser;
  } catch {
    /* noop — SSR / privacy mode */
  }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon },
    es: { common: esCommon },
    zh: { common: zhCommon },
    hi: { common: hiCommon },
    fr: { common: frCommon },
    de: { common: deCommon },
    ar: { common: arCommon },
    fa: { common: faCommon },
    ja: { common: jaCommon },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  returnEmptyString: false,
});

export default i18n;
