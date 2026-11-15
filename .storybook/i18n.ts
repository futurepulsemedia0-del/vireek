// Minimal i18next instance for Storybook only. Components such as Button call useTranslation();
// this gives them a real instance (no "missing instance" warnings) without loading the app's
// lazy locale bundles. Only the keys the ten catalogued components use are defined.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: { translation: { ui: { loading: 'Loading…' } } },
  fa: { translation: { ui: { loading: 'در حال بارگذاری…' } } },
};

export const storybookI18n = i18next.createInstance();

void storybookI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources,
  interpolation: { escapeValue: false },
  initImmediate: false,
});
