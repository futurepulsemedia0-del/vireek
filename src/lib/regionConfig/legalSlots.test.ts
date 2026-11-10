import { describe, it, expect } from 'vitest';
import { LEGAL_SLOTS, LEGAL_SLOT_KEYS, activeVersion, slotCoverage, validateLegalDocVersion, type LegalDocVersion } from './legalSlots';

const v = (o: Partial<LegalDocVersion> = {}): LegalDocVersion => ({
  slotKey: 'privacy_notice', country: 'DE', locale: 'de-DE', version: 1, status: 'draft', title: 'Datenschutz', body: 'text',
  counselReviewer: null, counselReviewedOn: null, ...o,
});
const TODAY = '2026-11-10';

describe('every slot is marked REQUIRES COUNSEL and ships no legal text', () => {
  it('all slots', () => {
    expect(LEGAL_SLOT_KEYS.length).toBeGreaterThanOrEqual(7);
    for (const k of LEGAL_SLOT_KEYS) expect(LEGAL_SLOTS[k].requiresCounsel).toBe(true);
  });
});

describe('validateLegalDocVersion', () => {
  it('drafts need no reviewer', () => expect(validateLegalDocVersion(v(), TODAY)).toEqual([]));
  it('approved/published need text, a named reviewer and a valid, non-future review date', () => {
    for (const status of ['counsel_approved', 'published'] as const) {
      const f = validateLegalDocVersion(v({ status }), TODAY).map((i) => i.field);
      expect(f).toEqual(['counselReviewer', 'counselReviewedOn']);
      expect(validateLegalDocVersion(v({ status, body: '  ', counselReviewer: 'Kanzlei X', counselReviewedOn: '2026-01-01' }), TODAY).map((i) => i.field)).toEqual(['body']);
      expect(validateLegalDocVersion(v({ status, counselReviewer: 'Kanzlei X', counselReviewedOn: '2027-01-01' }), TODAY).map((i) => i.field)).toEqual(['counselReviewedOn']);
      expect(validateLegalDocVersion(v({ status, counselReviewer: 'Kanzlei X', counselReviewedOn: '2026-01-01' }), TODAY)).toEqual([]);
    }
  });
  it('rejects malformed identifiers and oversize text', () => {
    const f = validateLegalDocVersion(v({ slotKey: 'nope' as never, country: 'DEU', locale: '!!', version: 0, title: '', body: 'x'.repeat(200_001) }), TODAY).map((i) => i.field);
    expect(f).toEqual(['slotKey', 'country', 'locale', 'version', 'title', 'body']);
  });
});

describe('activeVersion / slotCoverage', () => {
  const ok = { counselReviewer: 'Kanzlei X', counselReviewedOn: '2026-01-01' };
  it('only a PUBLISHED latest version is ever active; a newer draft hides the old one', () => {
    const vs = [v({ version: 1, status: 'published', ...ok }), v({ version: 2, status: 'draft' })];
    expect(activeVersion(vs, 'privacy_notice', 'DE', 'de-DE')).toBeNull();
    expect(activeVersion([vs[0]], 'privacy_notice', 'de', 'DE-de')?.version).toBe(1);
  });
  it('never crosses country or locale', () => {
    const vs = [v({ version: 1, status: 'published', ...ok })];
    expect(activeVersion(vs, 'privacy_notice', 'FR', 'de-DE')).toBeNull();
    expect(activeVersion(vs, 'privacy_notice', 'DE', 'en-GB')).toBeNull();
  });
  it('retired and unconfigured slots are reported honestly', () => {
    const cov = slotCoverage([v({ status: 'retired' })], 'DE', 'de-DE');
    expect(cov.find((c) => c.slotKey === 'privacy_notice')).toEqual({ slotKey: 'privacy_notice', status: 'retired', published: false });
    expect(cov.find((c) => c.slotKey === 'cookie_notice')).toEqual({ slotKey: 'cookie_notice', status: 'unconfigured', published: false });
  });
});
