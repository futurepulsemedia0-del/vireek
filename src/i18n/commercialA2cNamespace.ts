/* ------------------------------------------------------------------ */
/*  `commercialA2c` i18n namespace: Approval-to-Cash v2 (rules editor, */
/*  gate banner, NTE meter, packet, rejection fix flow). English is    */
/*  bundled; other languages are lazy chunks and fall back to English. */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enCommercialA2c from '@/locales/en/commercialA2c.json';

export const COMMERCIAL_A2C_NS = 'commercialA2c';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/commercialA2c.json', '!../locales/en/commercialA2c.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', COMMERCIAL_A2C_NS)) {
  i18n.addResourceBundle('en', COMMERCIAL_A2C_NS, enCommercialA2c, true, true);
}

async function loadCommercialA2cLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, COMMERCIAL_A2C_NS)) return;
  const loader = loaders[`../locales/${base}/commercialA2c.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, COMMERCIAL_A2C_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${COMMERCIAL_A2C_NS}" for "${base}"`, err);
  }
}

/** Use in every Approval-to-Cash v2 component. */
export function useCommercialA2cT() {
  const { t, i18n: instance } = useTranslation(COMMERCIAL_A2C_NS, { useSuspense: false });
  useEffect(() => {
    void loadCommercialA2cLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadCommercialA2cLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
