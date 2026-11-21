/* ------------------------------------------------------------------ */
/*  `outcomeProof` i18n namespace for the customer outcome cases page.    */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a outcomeProof.json simply falls back to English.             */
/* ------------------------------------------------------------------ */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enOutcomeProof from '@/locales/en/outcomeProof.json';

export const OUTCOME_PROOF_NS = 'outcomeProof';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/outcomeProof.json', '!../locales/en/outcomeProof.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', OUTCOME_PROOF_NS)) {
  i18n.addResourceBundle('en', OUTCOME_PROOF_NS, enOutcomeProof, true, true);
}

async function loadOutcomeProofLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, OUTCOME_PROOF_NS)) return;
  const loader = loaders[`../locales/${base}/outcomeProof.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, OUTCOME_PROOF_NS, await loader(), true, true);
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${OUTCOME_PROOF_NS}" for "${base}"`, err);
  }
}

export function useOutcomeProofT() {
  const { t, i18n: instance } = useTranslation(OUTCOME_PROOF_NS, { useSuspense: false });
  useEffect(() => {
    void loadOutcomeProofLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadOutcomeProofLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
