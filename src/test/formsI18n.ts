import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en/forms.json';

/** Real i18next with the English forms bundle, for component tests. */
export async function initFormsI18n() {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', ns: ['forms'], defaultNS: 'forms', resources: { en: { forms: en } }, interpolation: { escapeValue: false } });
  }
  return i18n;
}
