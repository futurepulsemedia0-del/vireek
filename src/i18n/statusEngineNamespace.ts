/* ------------------------------------------------------------------ */
/*  `statusEngine` i18n namespace (custom job statuses).               */
/*  English is bundled (fallback); other languages load on demand.     */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enStatusEngine from '@/locales/en/statusEngine.json';
import { SYSTEM_DEFINITION_DEFAULTS, definitionLabel, type StatusDefinition } from '@/lib/statusEngine';

export const STATUS_ENGINE_NS = 'statusEngine';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/statusEngine.json', '!../locales/en/statusEngine.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', STATUS_ENGINE_NS)) {
  i18n.addResourceBundle('en', STATUS_ENGINE_NS, enStatusEngine, true, true);
}

async function loadStatusEngineLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, STATUS_ENGINE_NS)) return;
  const loader = loaders[`../locales/${base}/statusEngine.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, STATUS_ENGINE_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${STATUS_ENGINE_NS}" for "${base}"`, err);
  }
}

export function useStatusEngineT() {
  const { t, i18n: instance } = useTranslation(STATUS_ENGINE_NS, { useSuspense: false });
  useEffect(() => {
    void loadStatusEngineLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadStatusEngineLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);

  /**
   * Display name of a definition. Untouched built-in statuses use the translated canonical name;
   * renamed ones use the owner's own text (with per-locale overrides when present).
   */
  const statusLabel = useCallback(
    (def: StatusDefinition): string => {
      const seed = SYSTEM_DEFINITION_DEFAULTS.find((d) => d.key === def.key);
      if (def.is_system && seed && seed.label === def.label) return t(`canonical.${def.key}`);
      return definitionLabel(def, instance.language || 'en');
    },
    [t, instance.language],
  );
  return { t, statusLabel, language: instance.language || 'en' };
}
