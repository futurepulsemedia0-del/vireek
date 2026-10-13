/* ------------------------------------------------------------------ */
/*  Lazy-loads the `dashboard` namespace for non-English languages.    */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected.              */
/* ------------------------------------------------------------------ */

import type { i18n as I18n } from 'i18next';

type Loader = () => Promise<Record<string, unknown>>;

const loaders = import.meta.glob('../locales/*/dashboard.json', { import: 'default' }) as Record<string, Loader>;

export const DASHBOARD_NS = 'dashboard';

export async function loadDashboardLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || instance.hasResourceBundle(base, DASHBOARD_NS)) return;
  const loader = loaders[`../locales/${base}/dashboard.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, DASHBOARD_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English for this namespace.
    console.warn(`[i18n] Could not load "${DASHBOARD_NS}" for "${base}"`, err);
  }
}

export function registerLazyLocales(instance: I18n): void {
  void loadDashboardLocale(instance, instance.language);
  instance.on('languageChanged', (lng) => {
    void loadDashboardLocale(instance, lng);
  });
}
