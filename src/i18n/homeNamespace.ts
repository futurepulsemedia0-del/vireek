/* ------------------------------------------------------------------ */
/*  `home` i18n namespace for the marketing homepage sections.         */
/*  English is bundled (it is the fallback); every other language is   */
/*  its own chunk, fetched the first time it is selected. A language   */
/*  without a home.json simply falls back to English.                  */
/*                                                                     */
/*  Facts that must never drift (trial length, card policy, setup      */
/*  time, FAQ answers that quote prices) are NOT typed into the JSON:  */
/*  they come from src/lib/homeContent.ts through HOME_VARS and        */
/*  HOME_FAQS, the same single source the FAQPage JSON-LD uses.        */
/* ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enHome from '@/locales/en/home.json';
import { HOME_FAQS, SETUP_MINUTES, TRIAL, TRIAL_REQUIRES_CARD, type FaqItem } from '@/lib/homeContent';

export const HOME_NS = 'home';

/**
 * Interpolation values shared by every homepage string that states the trial or setup time.
 * Flip TRIAL_REQUIRES_CARD in homeContent.ts and every sentence follows. Avoid i18next's reserved option
 * names (count, context, ns, lng, defaultValue, replace) when adding keys here.
 */
export const HOME_VARS = {
  days: TRIAL.days,
  setupMinutes: SETUP_MINUTES,
  /** Sentence-case phrase used inside "14-day free trial · … · Cancel anytime". */
  cardPolicy: TRIAL_REQUIRES_CARD ? 'Card required' : 'No credit card required',
  /** Short detail line under the hero "Trial" proof point. */
  cardDetail: TRIAL_REQUIRES_CARD ? 'Card required, no contract' : 'No card, no contract',
} as const;

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/home.json', '!../locales/en/home.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', HOME_NS)) {
  i18n.addResourceBundle('en', HOME_NS, enHome, true, true);
}

async function loadHomeLocale(instance: I18n, lng: string | undefined): Promise<boolean> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, HOME_NS)) return false;
  const loader = loaders[`../locales/${base}/home.json`];
  if (!loader) return false;
  try {
    instance.addResourceBundle(base, HOME_NS, await loader(), true, true);
    return true;
  } catch (err) {
    // Non-fatal: the UI falls back to English.
    console.warn(`[i18n] Could not load "${HOME_NS}" for "${base}"`, err);
    return false;
  }
}

export function useHomeT() {
  const { t, i18n: instance } = useTranslation(HOME_NS, { useSuspense: false });
  const [, setLoadedTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = (lng: string | undefined) => {
      void loadHomeLocale(instance, lng).then((added) => { if (added && alive) setLoadedTick((n) => n + 1); });
    };
    run(instance.language);
    const onChange = (lng: string) => run(lng);
    instance.on('languageChanged', onChange);
    return () => { alive = false; instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}

/* ---------------- typed readers for `returnObjects` results ---------------- */

/** Keeps only the string entries of an array. Anything else (missing key, wrong shape) becomes []. */
export function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

/**
 * Keeps only the array entries that are objects whose `keys` are all non-empty strings, so a half-translated
 * list renders fewer cards instead of crashing or printing "undefined".
 */
export function asRecords<K extends string>(value: unknown, keys: readonly K[]): Record<K, string>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<K, string>[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    if (keys.every((k) => typeof row[k] === 'string' && row[k] !== '')) {
      out.push(Object.fromEntries(keys.map((k) => [k, row[k] as string])) as Record<K, string>);
    }
  }
  return out;
}

/**
 * FAQ entries for the homepage. English always comes from HOME_FAQS (the same list that feeds the FAQPage
 * JSON-LD, so what search engines read equals what visitors read). Another language can ship its own
 * `faq.items` [{ q, a }] in its home.json; without it the English list is shown.
 */
export function useHomeFaqs(): FaqItem[] {
  const { language } = useHomeT();
  const base = language.slice(0, 2).toLowerCase();
  if (base !== 'en') {
    const bundle = i18n.getResourceBundle(base, HOME_NS) as { faq?: { items?: unknown } } | undefined;
    const items = asRecords(bundle?.faq?.items, ['q', 'a'] as const);
    if (items.length > 0) return items;
  }
  return HOME_FAQS;
}
