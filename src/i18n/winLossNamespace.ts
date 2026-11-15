/* ------------------------------------------------------------------ */
/*  `winLoss` i18n namespace for the staff win/loss analysis page.    */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a winLoss.json simply falls back to English.             */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enWinLoss from '@/locales/en/winLoss.json';

export const WIN_LOSS_NS = 'winLoss';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/winLoss.json', '!../locales/en/winLoss.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', WIN_LOSS_NS)) {
  i18n.addResourceBundle('en', WIN_LOSS_NS, enWinLoss, true, true);
}

async function loadWinLossLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, WIN_LOSS_NS)) return;
  const loader = loaders[`../locales/${base}/winLoss.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, WIN_LOSS_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${WIN_LOSS_NS}" for "${base}"`, err);
  }
}

export function useWinLossT() {
  const { t, i18n: instance } = useTranslation(WIN_LOSS_NS, { useSuspense: false });
  useEffect(() => {
    void loadWinLossLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadWinLossLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
