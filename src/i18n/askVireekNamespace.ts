/* ------------------------------------------------------------------ */
/*  `askVireek` i18n namespace for the unified help assistant.          */
/*  Same pattern as consentNamespace.ts: English is bundled (fallback), */
/*  other languages load on demand so the main bundle stays small.      */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enAskVireek from '@/locales/askVireek/en.json';

export const ASK_VIREEK_NS = 'askVireek';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/askVireek/*.json', '!../locales/askVireek/en.json'], {
  import: 'default',
}) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', ASK_VIREEK_NS)) {
  i18n.addResourceBundle('en', ASK_VIREEK_NS, enAskVireek, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, ASK_VIREEK_NS)) return;
  const loader = loaders[`../locales/askVireek/${base}.json`];
  if (!loader) return; // language without a bundle falls back to English
  try {
    instance.addResourceBundle(base, ASK_VIREEK_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${ASK_VIREEK_NS}" for "${base}"`, err);
  }
}

export function useAskT() {
  const { t, i18n: instance } = useTranslation(ASK_VIREEK_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => void loadLocale(instance, lng);
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language, dir: instance.dir(instance.language) };
}
