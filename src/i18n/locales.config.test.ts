import { describe, expect, it } from 'vitest';
import {
  LOCALES, LOCALE_CODES, fallbackChain, isBeta, isHumanReviewRequired, requiredNamespaces, surfaceOfNamespace,
} from './locales.config';

describe('locales.config', () => {
  it('covers exactly the 9 supported locales with English as the only source', () => {
    expect([...LOCALE_CODES].sort()).toEqual(['ar', 'de', 'en', 'es', 'fa', 'fr', 'hi', 'ja', 'zh']);
    expect(LOCALE_CODES.filter((c) => LOCALES[c].tier === 'source')).toEqual(['en']);
  });
  it('tier A is human-reviewed and never beta; tier C is beta and never machine-only', () => {
    for (const c of LOCALE_CODES) {
      const l = LOCALES[c];
      if (l.tier === 'A') { expect(l.review).toBe('human-reviewed'); expect(l.beta).toBe(false); }
      if (l.tier === 'C') { expect(l.beta).toBe(true); expect(l.review).not.toBe('machine-only'); }
    }
  });
  it('every language covers S1 (customer-facing + legal-critical)', () => {
    for (const c of LOCALE_CODES) expect(LOCALES[c].surfaces).toContain('S1');
  });
  it('maps namespaces to surfaces and selects required namespaces per language', () => {
    expect(surfaceOfNamespace('dashboard')).toBe('S3');
    expect(surfaceOfNamespace('unknownNs')).toBe('S4');
    const all = ['common', 'forms', 'trust', 'dashboard', 'retention', 'consent'];
    expect(requiredNamespaces('es', all)).toEqual(['common', 'forms', 'trust', 'dashboard', 'consent']);
    expect(requiredNamespaces('fr', all)).toEqual(['consent']);
  });
  it('flags legal, consent, AI-disclosure, opt-out and commitment keys as human-review-required', () => {
    for (const k of ['consent.recording.title', 'common.aiDisclosure.chatNotice', 'portal.optOut.body', 'x.terms.intro', 'quote.nte.note']) {
      expect(isHumanReviewRequired(k)).toBe(true);
    }
    for (const k of ['common.nav.pricing', 'common.footer.legal', 'forms.help.whyWeAsk', 'dashboard.nav.items.jobs']) {
      expect(isHumanReviewRequired(k)).toBe(false);
    }
  });
  it('fallback chain: regional -> base -> en, unknown -> en', () => {
    expect(fallbackChain('es-MX')).toEqual(['es', 'en']);
    expect(fallbackChain('en-GB')).toEqual(['en']);
    expect(fallbackChain('xx')).toEqual(['en']);
  });
  it('beta flag helper', () => {
    expect(isBeta('fr')).toBe(true);
    expect(isBeta('es')).toBe(false);
    expect(isBeta('nope')).toBe(false);
  });
});
