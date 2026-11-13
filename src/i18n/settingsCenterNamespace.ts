// Recreated: verify against original intent
/* `settingsCenter` i18n namespace (Settings Center page). English is bundled (fallback); other languages  */
/* load on demand from src/locales/<lng>/settingsCenter.json; a missing file falls back to English.        */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enSettingsCenter from '@/locales/en/settingsCenter.json';

export const SETTINGS_CENTER_NS = 'settingsCenter';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/settingsCenter.json', '!../locales/en/settingsCenter.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', SETTINGS_CENTER_NS)) {
  i18n.addResourceBundle('en', SETTINGS_CENTER_NS, enSettingsCenter, true, true);
}

async function loadSettingsCenterLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, SETTINGS_CENTER_NS)) return;
  const loader = loaders[`../locales/${base}/settingsCenter.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, SETTINGS_CENTER_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${SETTINGS_CENTER_NS}" for "${base}"`, err);
  }
}

export function useSettingsCenterT() {
  const { t, i18n: instance } = useTranslation(SETTINGS_CENTER_NS, { useSuspense: false });
  useEffect(() => {
    void loadSettingsCenterLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadSettingsCenterLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
