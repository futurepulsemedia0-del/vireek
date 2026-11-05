/* ------------------------------------------------------------------ */
/*  `exitReady` i18n namespace for Exit-Ready evidence, multiples and   */
/*  secure sharing. English is bundled (fallback); other languages      */
/*  load on demand from src/locales/exitReady/<lng>.json when present.  */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enExit from '@/locales/exitReady/en.json';

export const EXIT_NS = 'exitReady';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/exitReady/*.json', '!../locales/exitReady/en.json'], {
  import: 'default',
}) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', EXIT_NS)) {
  i18n.addResourceBundle('en', EXIT_NS, enExit, true, true);
}

async function loadExitLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, EXIT_NS)) return;
  const loader = loaders[`../locales/exitReady/${base}.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, EXIT_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${EXIT_NS}" for "${base}"`, err);
  }
}

export function useExitT() {
  const { t, i18n: instance } = useTranslation(EXIT_NS, { useSuspense: false });
  useEffect(() => {
    void loadExitLocale(instance, instance.language);
    const onChange = (lng: string) => {
      void loadExitLocale(instance, lng);
    };
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
