/* `transparency` i18n namespace: staff transparency report staff page.                           */
/* English is bundled (fallback); other languages load on demand; a missing file => English. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enTransparency from '@/locales/en/transparency.json';

export const TRANSPARENCY_NS = 'transparency';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/transparency.json', '!../locales/en/transparency.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', TRANSPARENCY_NS)) {
  i18n.addResourceBundle('en', TRANSPARENCY_NS, enTransparency, true, true);
}

async function loadTransparencyLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, TRANSPARENCY_NS)) return;
  const loader = loaders[`../locales/${base}/transparency.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, TRANSPARENCY_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${TRANSPARENCY_NS}" for "${base}"`, err);
  }
}

export function useTransparencyT() {
  const { t, i18n: instance } = useTranslation(TRANSPARENCY_NS, { useSuspense: false });
  useEffect(() => {
    void loadTransparencyLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadTransparencyLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
