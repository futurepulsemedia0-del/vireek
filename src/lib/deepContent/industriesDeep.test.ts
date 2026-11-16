import { describe, expect, it } from 'vitest';
import { INDUSTRIES } from '@/lib/industries';
import { INDUSTRY_DEEP } from './industriesDeep';
import { BANNED_CLAIMS, deepText, uniquenessStrings } from './guards';

describe('industry deep content', () => {
  it('covers every industry exactly once', () => {
    expect(Object.keys(INDUSTRY_DEEP).sort()).toEqual(INDUSTRIES.map((i) => i.slug).sort());
  });

  for (const [slug, data] of Object.entries(INDUSTRY_DEEP)) {
    describe(slug, () => {
      it('is substantial', () => {
        expect(deepText(data).split(/\s+/).filter(Boolean).length).toBeGreaterThan(450);
      });
      it('makes no unverifiable claims or hardcoded prices', () => {
        for (const re of BANNED_CLAIMS) expect(deepText(data)).not.toMatch(re);
      });
      it('has unique section ids and consistent tables', () => {
        const ids = data.sections.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const s of data.sections) {
          for (const b of s.blocks) {
            if (b.kind === 'table') for (const r of b.rows) expect(r.length).toBe(b.headers.length);
          }
        }
      });
    });
  }

  it('does not repeat the same sentence across trades (duplicate-content guard)', () => {
    const seen = new Map<string, string>();
    for (const [slug, data] of Object.entries(INDUSTRY_DEEP)) {
      for (const s of uniquenessStrings(data)) {
        const prev = seen.get(s);
        if (prev && prev !== slug) throw new Error(`Duplicate text in ${prev} and ${slug}: "${s.slice(0, 80)}"`);
        seen.set(s, slug);
      }
    }
  });
});
