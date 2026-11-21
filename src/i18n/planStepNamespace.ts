/* ------------------------------------------------------------------ */
/*  `planStep` i18n namespace for /onboarding/plan and its banner.      */
/*  English is bundled (fallback); other languages load on demand. A   */
/*  language without a planStep.json falls back to English.            */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enPlanStep from '@/locales/en/planStep.json';

export const PLAN_STEP_NS = 'planStep';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/planStep.json', '!../locales/en/planStep.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', PLAN_STEP_NS)) {
  i18n.addResourceBundle('en', PLAN_STEP_NS, enPlanStep, true, true);
}

async function loadPlanStepLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PLAN_STEP_NS)) return;
  const loader = loaders[`../locales/${base}/planStep.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, PLAN_STEP_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${PLAN_STEP_NS}" for "${base}"`, err);
  }
}

export function usePlanStepT() {
  const { t, i18n: instance } = useTranslation(PLAN_STEP_NS, { useSuspense: false });
  useEffect(() => {
    void loadPlanStepLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadPlanStepLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
