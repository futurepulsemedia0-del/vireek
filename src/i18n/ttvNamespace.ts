/* ------------------------------------------------------------------ */
/*  `ttv` i18n namespace: staff onboarding time-to-value card (TtvCard). */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a ttv.json simply falls back to English.                    */
/* ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enTtv from '@/locales/en/ttv.json';

export const TTV_NS = 'ttv';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/ttv.json', '!../locales/en/ttv.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', TTV_NS)) {
  i18n.addResourceBundle('en', TTV_NS, enTtv, true, true);
}

async function loadTtvLocale(instance: I18n, lng: string | undefined): Promise<boolean> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, TTV_NS)) return false;
  const loader = loaders[`../locales/${base}/ttv.json`];
  if (!loader) return false;
  try {
    instance.addResourceBundle(base, TTV_NS, await loader(), true, true);
    return true;
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${TTV_NS}" for "${base}"`, err);
    return false;
  }
}

export function useTtvT() {
  const { t, i18n: instance } = useTranslation(TTV_NS, { useSuspense: false });
  const [, setLoadedTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = (lng: string | undefined) => {
      void loadTtvLocale(instance, lng).then((added) => { if (added && alive) setLoadedTick((n) => n + 1); });
    };
    run(instance.language);
    const onChange = (lng: string) => run(lng);
    instance.on('languageChanged', onChange);
    return () => { alive = false; instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
