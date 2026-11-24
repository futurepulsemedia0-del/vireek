/* ------------------------------------------------------------------ */
/*  `salesPipeline` i18n namespace for the sales pipeline page (/dashboard/sales-pipeline).    */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a salesPipeline.json simply falls back to English.             */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enSalesPipeline from '@/locales/en/salesPipeline.json';

export const SALES_PIPELINE_NS = 'salesPipeline';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/salesPipeline.json', '!../locales/en/salesPipeline.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', SALES_PIPELINE_NS)) {
  i18n.addResourceBundle('en', SALES_PIPELINE_NS, enSalesPipeline, true, true);
}

async function loadSalesPipelineLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, SALES_PIPELINE_NS)) return;
  const loader = loaders[`../locales/${base}/salesPipeline.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, SALES_PIPELINE_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${SALES_PIPELINE_NS}" for "${base}"`, err);
  }
}

export function useSalesPipelineT() {
  const { t, i18n: instance } = useTranslation(SALES_PIPELINE_NS, { useSuspense: false });
  useEffect(() => {
    void loadSalesPipelineLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadSalesPipelineLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
