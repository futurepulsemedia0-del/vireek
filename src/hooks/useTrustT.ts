import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import en from '@/locales/en/trust.json';

type Vars = Record<string, string | number>;

function lookup(path: string): string | undefined {
  let cur: unknown = en;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * `t` for the `trust` namespace. English text comes from locales/en/trust.json
 * (single source) and is passed as `defaultValue`, which keeps components
 * readable in tests that mock react-i18next and guarantees an English fallback
 * for languages that have no `trust.json` yet.
 */
export function useTrustT() {
  const { t, i18n } = useTranslation('trust');
  const tt = useCallback((key: string, vars: Vars = {}): string => t(key, { defaultValue: lookup(key) ?? key, ...vars }) as string, [t]);
  /** "job" / "jobs" in the current language, chosen explicitly (no reliance on plural resolution). */
  const noun = useCallback((name: string, count: number): string => tt(`nouns.${name}_${count === 1 ? 'one' : 'other'}`), [tt]);
  return { t: tt, noun, language: i18n?.language ?? 'en' };
}
