/* ------------------------------------------------------------------ */
/*  `changeCalendar` i18n namespace: staff /staff/change-calendar.      */
/*  English is bundled; other languages are lazy chunks and fall back   */
/*  to English when missing.                                            */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enChangeCalendar from '@/locales/en/changeCalendar.json';

export const CHANGE_CALENDAR_NS = 'changeCalendar';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/changeCalendar.json', '!../locales/en/changeCalendar.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', CHANGE_CALENDAR_NS)) {
  i18n.addResourceBundle('en', CHANGE_CALENDAR_NS, enChangeCalendar, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, CHANGE_CALENDAR_NS)) return;
  const loader = loaders[`../locales/${base}/changeCalendar.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, CHANGE_CALENDAR_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${CHANGE_CALENDAR_NS}" for "${base}"`, err);
  }
}

export function useChangeCalendarT() {
  const { t, i18n: instance } = useTranslation(CHANGE_CALENDAR_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
