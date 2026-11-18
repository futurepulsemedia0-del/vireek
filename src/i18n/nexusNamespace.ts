/* `nexus` i18n namespace for the staff nexus tracker. English is bundled (fallback); other languages load on demand when added. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNexus from '@/locales/nexus/en.json';

export const NEXUS_NS = 'nexus';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/nexus/*.json', '!../locales/nexus/en.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', NEXUS_NS)) {
  i18n.addResourceBundle('en', NEXUS_NS, enNexus, true, true);
}

async function loadNexusLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, NEXUS_NS)) return;
  const loader = loaders[`../locales/nexus/${base}.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, NEXUS_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${NEXUS_NS}" for "${base}"`, err);
  }
}

export function useNexusT() {
  const { t, i18n: instance } = useTranslation(NEXUS_NS, { useSuspense: false });
  useEffect(() => {
    void loadNexusLocale(instance, instance.language);
    const onChange = (lng: string) => void loadNexusLocale(instance, lng);
    instance.on('languageChanged', onChange);
    return () => {
      instance.off('languageChanged', onChange);
    };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
