import { describe, it, expect } from 'vitest';
import {
  buildTrackedLink,
  conversionRate,
  emptyDraft,
  formatRate,
  getPageUrl,
  hasAttribution,
  isCustomLandingHost,
  mapSubmitError,
  normalizeDomain,
  parseAttributionFromSearch,
  parseStoredAttribution,
  readableTextColor,
  resolveAttribution,
  sanitizeReferrer,
  serializeStoredAttribution,
  slugify,
  validateCustomDomain,
  validateDraft,
} from './landingPageUtils';

describe('slugify', () => {
  it('lowercases, hyphenates and trims', () => {
    expect(slugify('  Spring AC Tune-Up!! ')).toBe('spring-ac-tune-up');
  });
  it('strips diacritics', () => {
    expect(slugify('Café Sévérin')).toBe('cafe-severin');
  });
  it('caps at 60 chars and never ends with a hyphen', () => {
    const s = slugify('a'.repeat(80));
    expect(s).toHaveLength(60);
    expect(slugify(`${'a'.repeat(59)} b`).endsWith('-')).toBe(false);
  });
  it('returns an empty string when nothing usable remains', () => {
    expect(slugify('---')).toBe('');
    expect(slugify('هیچ')).toBe('');
  });
});

describe('domains', () => {
  it('normalizes URLs to a bare hostname', () => {
    expect(normalizeDomain('HTTPS://WWW.Example.com:8080/path?x=1')).toBe('www.example.com');
  });
  it('accepts a normal domain', () => {
    expect(validateCustomDomain('shop.example.com', ['vireek.com'])).toEqual({ ok: true, domain: 'shop.example.com' });
  });
  it('rejects malformed input, IPs and single labels', () => {
    expect(validateCustomDomain('localhost', [])).toEqual({ ok: false, reason: 'invalid' });
    expect(validateCustomDomain('1.2.3.4', [])).toEqual({ ok: false, reason: 'invalid' });
    expect(validateCustomDomain('example.c', [])).toEqual({ ok: false, reason: 'invalid' });
  });
  it('rejects app hosts, their subdomains and platform domains', () => {
    expect(validateCustomDomain('vireek.com', ['vireek.com'])).toEqual({ ok: false, reason: 'reserved' });
    expect(validateCustomDomain('app.vireek.com', ['vireek.com'])).toEqual({ ok: false, reason: 'reserved' });
    expect(validateCustomDomain('foo.vercel.app', [])).toEqual({ ok: false, reason: 'reserved' });
  });
});

describe('isCustomLandingHost', () => {
  const apps = ['vireek.com'];
  it('is true only for foreign hosts', () => {
    expect(isCustomLandingHost('shop.acme.com', apps)).toBe(true);
    expect(isCustomLandingHost('notvireek.com', apps)).toBe(true);
  });
  it('is false for the app, its subdomains, localhost and previews', () => {
    for (const h of ['vireek.com', 'www.vireek.com', 'app.vireek.com', 'localhost', 'x.vercel.app']) {
      expect(isCustomLandingHost(h, apps)).toBe(false);
    }
  });
  it('is disabled (fail-safe) when no app hosts are configured', () => {
    expect(isCustomLandingHost('shop.acme.com', [])).toBe(false);
  });
});

describe('attribution', () => {
  it('parses and lowercases UTM params and click ids', () => {
    expect(
      parseAttributionFromSearch('?utm_source=Google&utm_medium=CPC&utm_campaign=Spring%20Sale&gclid=abc123'),
    ).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring sale',
      click_id: 'gclid:abc123',
    });
  });
  it('ignores empty values, caps length and strips control characters', () => {
    expect(parseAttributionFromSearch('?utm_source=')).toEqual({});
    expect(parseAttributionFromSearch(`?utm_source=${'x'.repeat(500)}`).utm_source).toHaveLength(200);
    expect(parseAttributionFromSearch('?utm_source=a%00b').utm_source).toBe('ab');
  });
  it('prefers fresh attribution, falls back to stored, else empty', () => {
    expect(resolveAttribution({ utm_source: 'new' }, { utm_source: 'old' })).toEqual({ utm_source: 'new' });
    expect(resolveAttribution({}, { utm_source: 'old' })).toEqual({ utm_source: 'old' });
    expect(resolveAttribution({}, null)).toEqual({});
    expect(hasAttribution({})).toBe(false);
  });
  it('round-trips stored attribution and expires it after 30 days', () => {
    const raw = serializeStoredAttribution({ utm_source: 'x' }, 1000);
    expect(parseStoredAttribution(raw, 1000 + 24 * 3600 * 1000)).toEqual({ utm_source: 'x' });
    expect(parseStoredAttribution(raw, 1000 + 31 * 24 * 3600 * 1000)).toBeNull();
  });
  it('rejects garbage and drops unknown / non-string stored keys', () => {
    expect(parseStoredAttribution(null, 1)).toBeNull();
    expect(parseStoredAttribution('garbage', 1)).toBeNull();
    expect(parseStoredAttribution(JSON.stringify({ a: { utm_source: 5, evil: 'x' }, t: 1 }), 2)).toBeNull();
  });
  it('reduces referrers to host/path and drops own-site traffic', () => {
    expect(sanitizeReferrer('https://www.google.com/search?q=x', 'acme.com')).toBe('google.com/search');
    expect(sanitizeReferrer('https://t.co/', 'acme.com')).toBe('t.co');
    expect(sanitizeReferrer('https://acme.com/x', 'acme.com')).toBeUndefined();
    expect(sanitizeReferrer('not a url', 'acme.com')).toBeUndefined();
  });
  it('builds tracked links with clean lowercase params', () => {
    expect(buildTrackedLink('https://a.com/lp/x', { source: 'Google', medium: 'CPC', campaign: '' })).toBe(
      'https://a.com/lp/x?utm_source=google&utm_medium=cpc',
    );
  });
});

describe('analytics math', () => {
  it('computes safe conversion rates', () => {
    expect(conversionRate(5, 100)).toBe(0.05);
    expect(conversionRate(0, 0)).toBe(0);
    expect(conversionRate(10, 5)).toBe(1);
    expect(formatRate(0.05)).toBe('5.0%');
  });
});

describe('readableTextColor', () => {
  it('picks readable text for light, dark and invalid backgrounds', () => {
    expect(readableTextColor('#ffffff')).toBe('#0f172a');
    expect(readableTextColor('#facc15')).toBe('#0f172a');
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('bad')).toBe('#ffffff');
  });
});

describe('validateDraft', () => {
  const valid = { ...emptyDraft(), title: 'Spring promo', slug: 'spring-promo', headline: 'Fast, fair HVAC repair' };
  it('passes a minimal valid draft', () => {
    expect(validateDraft(valid)).toEqual({});
  });
  it('flags required and malformed fields', () => {
    const errors = validateDraft({ ...valid, headline: ' ', slug: 'Bad Slug', accent_color: 'blue' });
    expect(Object.keys(errors).sort()).toEqual(['accent_color', 'headline', 'slug']);
  });
  it('limits sections to six', () => {
    const sections = Array.from({ length: 7 }, () => ({ title: 't', body: 'b' }));
    expect(validateDraft({ ...valid, sections }).sections).toBeDefined();
  });
});

describe('getPageUrl', () => {
  const page = { id: 'p1', slug: 'spring' };
  it('uses the verified custom domain when assigned', () => {
    const domains = [{ domain: 'shop.acme.com', status: 'verified' as const, landing_page_id: 'p1' }];
    expect(getPageUrl(page, domains, 'https://app.vireek.com')).toBe('https://shop.acme.com');
  });
  it('ignores unverified domains', () => {
    const domains = [{ domain: 'shop.acme.com', status: 'pending' as const, landing_page_id: 'p1' }];
    expect(getPageUrl(page, domains, 'https://app.vireek.com')).toBe('https://app.vireek.com/lp/spring');
  });
});

describe('mapSubmitError', () => {
  it('maps known database error codes', () => {
    expect(mapSubmitError('slot_taken')).toBe('slot_taken');
    expect(mapSubmitError('too_soon')).toBe('too_soon');
    expect(mapSubmitError('booking_not_available')).toBe('unavailable');
    expect(mapSubmitError('rate_limited')).toBe('rate_limited');
    expect(mapSubmitError('contact_required')).toBe('invalid_contact');
    expect(mapSubmitError('invalid_email')).toBe('invalid_contact');
    expect(mapSubmitError('boom')).toBe('unknown');
    expect(mapSubmitError(undefined)).toBe('unknown');
  });
});
