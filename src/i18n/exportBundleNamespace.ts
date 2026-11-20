/* ------------------------------------------------------------------ */
/*  `exportBundle` i18n namespace: self-serve whole-account export (FullExportButton). */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a exportBundle.json simply falls back to English.                    */
/* ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enExportBundle from '@/locales/en/exportBundle.json';

export const EXPORT_BUNDLE_NS = 'exportBundle';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/exportBundle.json', '!../locales/en/exportBundle.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', EXPORT_BUNDLE_NS)) {
  i18n.addResourceBundle('en', EXPORT_BUNDLE_NS, enExportBundle, true, true);
}

async function loadExportBundleLocale(instance: I18n, lng: string | undefined): Promise<boolean> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, EXPORT_BUNDLE_NS)) return false;
  const loader = loaders[`../locales/${base}/exportBundle.json`];
  if (!loader) return false;
  try {
    instance.addResourceBundle(base, EXPORT_BUNDLE_NS, await loader(), true, true);
    return true;
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${EXPORT_BUNDLE_NS}" for "${base}"`, err);
    return false;
  }
}

export function useExportBundleT() {
  const { t, i18n: instance } = useTranslation(EXPORT_BUNDLE_NS, { useSuspense: false });
  const [, setLoadedTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = (lng: string | undefined) => {
      void loadExportBundleLocale(instance, lng).then((added) => { if (added && alive) setLoadedTick((n) => n + 1); });
    };
    run(instance.language);
    const onChange = (lng: string) => run(lng);
    instance.on('languageChanged', onChange);
    return () => { alive = false; instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
