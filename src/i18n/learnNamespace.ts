/* `learn` i18n namespace (role courses). English is bundled (fallback);     */
/* other languages load on demand from locales/<lng>/learn.json; a missing file => English.          */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enLearn from '@/locales/en/learn.json';

export const LEARN_NS = 'learn';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/learn.json', '!../locales/en/learn.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', LEARN_NS)) {
  i18n.addResourceBundle('en', LEARN_NS, enLearn, true, true);
}

async function loadLearnLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, LEARN_NS)) return;
  const loader = loaders[`../locales/${base}/learn.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, LEARN_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${LEARN_NS}" for "${base}"`, err);
  }
}

export function useLearnT() {
  const { t, i18n: instance } = useTranslation(LEARN_NS, { useSuspense: false });
  useEffect(() => {
    void loadLearnLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLearnLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
