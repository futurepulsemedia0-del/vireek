import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/offboarding.json';

const get = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
const PAGES = ['src/pages/OffboardingPage.tsx', 'src/pages/WinbackUnsubscribePage.tsx', 'src/pages/StaffOffboardingPage.tsx'];

describe('offboarding i18n keys', () => {
  it('every static t("...") key used by the pages exists in en/offboarding.json', () => {
    const missing: string[] = [];
    for (const f of PAGES) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) if (typeof get(m[1]) !== 'string') missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('has title + text for every timeline step variant the library can emit', () => {
    const variants: Record<string, string[]> = {
      cancellation: ['scheduled'],
      accessEnd: ['upcoming', 'ended'],
      export: ['todo', 'started'],
      deletion: ['none', 'grace', 'processing', 'blocked', 'completed'],
    };
    for (const [key, vs] of Object.entries(variants)) {
      for (const v of vs) {
        expect(typeof get(`timeline.${key}.${v}.title`), `${key}.${v}.title`).toBe('string');
        expect(typeof get(`timeline.${key}.${v}.text`), `${key}.${v}.text`).toBe('string');
      }
    }
  });

  it('labels every cancellation reason the database allows', () => {
    for (const r of ['too_expensive', 'missing_features', 'not_using', 'switching', 'closing_business', 'technical_issues', 'other', 'unknown']) {
      expect(typeof get(`reasons.${r}`), r).toBe('string');
    }
  });
});
