/* `invoiceOutcome` i18n namespace (Task E). English bundled as fallback; Persian loads on demand. Same pattern as abuseNamespace.ts. */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/invoiceOutcome.json';

export const INVOICE_OUTCOME_NS = 'invoiceOutcome';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/invoiceOutcome.json', '!../locales/en/invoiceOutcome.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', INVOICE_OUTCOME_NS)) i18n.addResourceBundle('en', INVOICE_OUTCOME_NS, enNs, true, true);

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, INVOICE_OUTCOME_NS)) return;
  const loader = loaders[`../locales/${base}/invoiceOutcome.json`];
  if (!loader) return;
  try { instance.addResourceBundle(base, INVOICE_OUTCOME_NS, await loader(), true, true); }
  catch (err) { console.warn(`[i18n] Could not load "${INVOICE_OUTCOME_NS}" for "${base}"`, err); }
}

export function useInvoiceOutcomeT() {
  const { t, i18n: instance } = useTranslation(INVOICE_OUTCOME_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
