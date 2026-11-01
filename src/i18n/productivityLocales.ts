/* ------------------------------------------------------------------ */
/*  `productivity` i18n namespace: Cmd+K palette, keyboard shortcuts,  */
/*  and (later phases) notification center / onboarding strings.       */
/*  English is bundled (the fallback); other languages are lazy        */
/*  chunks. A language without productivity.json falls back to English. */
/*  Components import ONLY PRODUCTIVITY_NS from here; the instance is  */
/*  wired once in src/i18n/index.ts via registerProductivityLocales.   */
/* ------------------------------------------------------------------ */

import type { i18n as I18n } from 'i18next';
import enProductivity from '@/locales/en/productivity.json';

export const PRODUCTIVITY_NS = 'productivity';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/productivity.json', '!../locales/en/productivity.json'], {
  import: 'default',
}) as Record<string, Loader>;

async function loadProductivityLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PRODUCTIVITY_NS)) return;
  const loader = loaders[`../locales/${base}/productivity.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, PRODUCTIVITY_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${PRODUCTIVITY_NS}" for "${base}"`, err);
  }
}

export function registerProductivityLocales(instance: I18n): void {
  if (!instance.hasResourceBundle('en', PRODUCTIVITY_NS)) {
    instance.addResourceBundle('en', PRODUCTIVITY_NS, enProductivity, true, true);
  }
  void loadProductivityLocale(instance, instance.language);
  instance.on('languageChanged', (lng) => {
    void loadProductivityLocale(instance, lng);
  });
}
