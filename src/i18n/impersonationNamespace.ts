/* ------------------------------------------------------------------ */
/*  `impersonation` i18n namespace: Vireek Support session banner. */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a impersonation.json simply falls back to English.                    */
/* ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enImpersonation from '@/locales/en/impersonation.json';

export const IMPERSONATION_NS = 'impersonation';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/impersonation.json', '!../locales/en/impersonation.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', IMPERSONATION_NS)) {
  i18n.addResourceBundle('en', IMPERSONATION_NS, enImpersonation, true, true);
}

async function loadImpersonationLocale(instance: I18n, lng: string | undefined): Promise<boolean> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, IMPERSONATION_NS)) return false;
  const loader = loaders[`../locales/${base}/impersonation.json`];
  if (!loader) return false;
  try {
    instance.addResourceBundle(base, IMPERSONATION_NS, await loader(), true, true);
    return true;
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${IMPERSONATION_NS}" for "${base}"`, err);
    return false;
  }
}

export function useImpersonationT() {
  const { t, i18n: instance } = useTranslation(IMPERSONATION_NS, { useSuspense: false });
  const [, setLoadedTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = (lng: string | undefined) => {
      void loadImpersonationLocale(instance, lng).then((added) => { if (added && alive) setLoadedTick((n) => n + 1); });
    };
    run(instance.language);
    const onChange = (lng: string) => run(lng);
    instance.on('languageChanged', onChange);
    return () => { alive = false; instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
