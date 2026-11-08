/* ------------------------------------------------------------------ */
/*  `photoProvenance` i18n namespace (job photo provenance + public   */
/*  evidence verification page). English is bundled as the fallback;  */
/*  every other language is its own chunk, fetched when selected.     */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enPhotoProvenance from '@/locales/en/photoProvenance.json';

export const PHOTO_PROVENANCE_NS = 'photoProvenance';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/photoProvenance.json', '!../locales/en/photoProvenance.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', PHOTO_PROVENANCE_NS)) {
  i18n.addResourceBundle('en', PHOTO_PROVENANCE_NS, enPhotoProvenance, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PHOTO_PROVENANCE_NS)) return;
  const loader = loaders[`../locales/${base}/photoProvenance.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, PHOTO_PROVENANCE_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${PHOTO_PROVENANCE_NS}" for "${base}"`, err);
  }
}

export function usePhotoProvenanceT() {
  const { t, i18n: instance } = useTranslation(PHOTO_PROVENANCE_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
