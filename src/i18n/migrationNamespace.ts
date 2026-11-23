/* `migration` i18n namespace (guided competitor-switching checklist). English is bundled (fallback);     */
/* other languages load on demand from locales/<lng>/migration.json; a missing file => English.          */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enMigration from '@/locales/en/migration.json';

export const MIGRATION_NS = 'migration';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/migration.json', '!../locales/en/migration.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', MIGRATION_NS)) {
  i18n.addResourceBundle('en', MIGRATION_NS, enMigration, true, true);
}

async function loadMigrationLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, MIGRATION_NS)) return;
  const loader = loaders[`../locales/${base}/migration.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, MIGRATION_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${MIGRATION_NS}" for "${base}"`, err);
  }
}

export function useMigrationT() {
  const { t, i18n: instance } = useTranslation(MIGRATION_NS, { useSuspense: false });
  useEffect(() => {
    void loadMigrationLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadMigrationLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
