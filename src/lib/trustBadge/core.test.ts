import { describe, expect, it } from 'vitest';
import {
  BADGE_FRESH_DAYS, BADGE_LOCALES, BADGE_MIN_SAMPLE, PALETTES, STRINGS,
  buildPoweredByHref, buildReactSnippet, buildScriptSnippet, buildView, contrastRatio, decideState,
  hostAllowed, hostFromOrigin, normalizeDomain, parseLocale, parseRel, pickStat, relAttr,
  signBadgeToken, validateDomain, verifyBadgeToken,
  type StatInputs, type ViewInput,
} from './core';

const NOW = new Date('2026-11-01T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const SECRET = 'x'.repeat(40);

describe('host / domain binding (fake-badge defence)', () => {
  const verified = ['example.com'];
  it('allows the apex and real subdomains', () => {
    expect(hostAllowed('example.com', verified)).toBe(true);
    expect(hostAllowed('www.example.com', verified)).toBe(true);
    expect(hostAllowed('shop.example.com', verified)).toBe(true);
    expect(hostAllowed('EXAMPLE.com.', verified)).toBe(true);
  });
  it.each(['evil.com', 'notexample.com', 'example.com.evil.com', 'example.com@evil.com', 'xexample.com', '', 'com'])('rejects %s', (h) => {
    expect(hostAllowed(h, verified)).toBe(false);
  });
  it('rejects everything when the account has no verified domain', () => {
    expect(hostAllowed('example.com', [])).toBe(false);
  });
  it('derives host only from http(s) Origin', () => {
    expect(hostFromOrigin('https://Shop.Example.com:8443')).toBe('shop.example.com');
    expect(hostFromOrigin('null')).toBe('');
    expect(hostFromOrigin('chrome-extension://abc')).toBe('');
    expect(hostFromOrigin(null)).toBe('');
  });
  it('validates domains the customer may claim', () => {
    expect(validateDomain('https://www.Acme-Plumbing.com/about')).toEqual({ ok: true, domain: 'acme-plumbing.com' });
    for (const bad of ['localhost', '10.0.0.1', 'foo', 'vireek.com', 'a.vercel.app', 'bad_domain.com', 'ex ample.com', 'münchen.de']) {
      expect(validateDomain(bad).ok).toBe(false);
    }
    expect(normalizeDomain('WWW.Example.COM:443/x')).toBe('example.com');
  });
});

describe('decideState', () => {
  const base = { enabled: true, profileStatus: 'active', subscriptionStatus: 'active', hostOk: true };
  it('ok for a healthy, enabled account on a verified host', () => expect(decideState(base)).toBe('ok'));
  it('past_due is neutral (no claims)', () => expect(decideState({ ...base, subscriptionStatus: 'past_due' })).toBe('neutral'));
  it.each([
    [{ enabled: false }], [{ hostOk: false }], [{ profileStatus: 'suspended' }], [{ profileStatus: 'canceled' }],
    [{ profileStatus: 'weird' }], [{ subscriptionStatus: 'suspended' }],
  ])('hidden for %j', (o) => expect(decideState({ ...base, ...o })).toBe('hidden'));
});

describe('pickStat (real data only: minimum sample + freshness)', () => {
  const calls = (o: Partial<StatInputs> = {}): StatInputs => ({ metric: 'calls', callCount: 120, latestCallAt: daysAgo(1), timedCount: 0, latestTimedAt: null, avgAnswerMs: null, ...o });
  it('shows calls when sample and freshness are met', () => expect(pickStat(calls(), NOW)).toEqual({ kind: 'calls', value: 120, asOf: daysAgo(1) }));
  it('null below the minimum sample', () => expect(pickStat(calls({ callCount: BADGE_MIN_SAMPLE - 1 }), NOW)).toBeNull());
  it('exactly the minimum is enough', () => expect(pickStat(calls({ callCount: BADGE_MIN_SAMPLE }), NOW)).not.toBeNull());
  it('null when the newest call is stale', () => expect(pickStat(calls({ latestCallAt: daysAgo(BADGE_FRESH_DAYS + 1) }), NOW)).toBeNull());
  it('null when timestamps are in the future or missing', () => {
    expect(pickStat(calls({ latestCallAt: new Date(NOW.getTime() + 3_600_000).toISOString() }), NOW)).toBeNull();
    expect(pickStat(calls({ latestCallAt: null }), NOW)).toBeNull();
  });
  const t = (o: Partial<StatInputs> = {}): StatInputs => ({ metric: 'answer_time', callCount: 500, latestCallAt: daysAgo(0), timedCount: 80, latestTimedAt: daysAgo(2), avgAnswerMs: 2100, ...o });
  it('answer_time needs its own measured samples', () => {
    expect(pickStat(t(), NOW)?.value).toBe(2100);
    expect(pickStat(t({ timedCount: 0, avgAnswerMs: null }), NOW)).toBeNull(); // calls exist, no measurement => no claim
    expect(pickStat(t({ timedCount: 29 }), NOW)).toBeNull();
    expect(pickStat(t({ latestTimedAt: daysAgo(10) }), NOW)).toBeNull();
    expect(pickStat(t({ avgAnswerMs: Number.NaN }), NOW)).toBeNull();
    expect(pickStat(t({ avgAnswerMs: -5 }), NOW)).toBeNull();
  });
});

describe('signed tokens', () => {
  const payload = { s: 'acme', h: 'acme.com', i: Math.floor(NOW.getTime() / 1000), e: Math.floor(NOW.getTime() / 1000) + 3600 };
  it('round-trips', async () => {
    const tok = await signBadgeToken(SECRET, payload);
    const r = await verifyBadgeToken(SECRET, tok, 'acme', NOW);
    expect(r).toEqual({ valid: true, payload });
  });
  it('rejects tampered payload (host swap), tampered signature, other secret, other account, expiry, junk', async () => {
    const tok = await signBadgeToken(SECRET, payload);
    const [body, sig] = tok.split('.');
    const forged = btoa(JSON.stringify({ ...payload, h: 'evil.com' })).replace(/=+$/, '');
    expect((await verifyBadgeToken(SECRET, `${forged}.${sig}`, 'acme', NOW))).toEqual({ valid: false, reason: 'bad_signature' });
    expect((await verifyBadgeToken(SECRET, `${body}.${sig.slice(0, -2)}AA`, 'acme', NOW)).valid).toBe(false);
    expect((await verifyBadgeToken('y'.repeat(40), tok, 'acme', NOW))).toEqual({ valid: false, reason: 'bad_signature' });
    expect((await verifyBadgeToken(SECRET, tok, 'other', NOW))).toEqual({ valid: false, reason: 'wrong_account' });
    expect((await verifyBadgeToken(SECRET, tok, 'acme', new Date(NOW.getTime() + 2 * 3600_000)))).toEqual({ valid: false, reason: 'expired' });
    for (const junk of ['', 'abc', 'a.b.c', '.', 'x'.repeat(700)]) expect((await verifyBadgeToken(SECRET, junk, 'acme', NOW)).valid).toBe(false);
  });
  it('refuses to sign or verify with a weak secret', async () => {
    await expect(signBadgeToken('short', payload)).rejects.toThrow();
    expect((await verifyBadgeToken('short', 'a.b', 'acme', NOW)).valid).toBe(false);
  });
});

describe('palettes are accessible', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    for (const mode of ['l', 'd'] as const) {
      it(`${name}/${mode}: text and accent meet WCAG AA (4.5:1)`, () => {
        const [bg, fg, , accent] = p[mode];
        expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(bg, accent)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('i18n', () => {
  it('every locale has every string and the placeholders it needs', () => {
    const keys = Object.keys(STRINGS.en).sort();
    for (const l of BADGE_LOCALES) {
      expect(Object.keys(STRINGS[l]).sort()).toEqual(keys);
      for (const k of keys) expect(STRINGS[l][k as keyof typeof STRINGS.en].trim().length).toBeGreaterThan(2);
      expect(STRINGS[l].calls).toContain('{n}');
      expect(STRINGS[l].time).toContain('{s}');
      expect(STRINGS[l].period).toContain('{date}');
    }
  });
  it('parses locales safely', () => {
    expect(parseLocale('fa-IR')).toBe('fa');
    expect(parseLocale('pt-BR')).toBe('en');
    expect(parseLocale('<script>')).toBe('en');
    expect(parseLocale(undefined)).toBe('en');
  });
});

describe('buildView', () => {
  const base: ViewInput = {
    state: 'ok', variant: 'tiny', theme: 'auto', palette: 'blue', locale: 'en', stat: null,
    verifyHref: 'https://vireek.com/verify/acme?t=abc', rel: ['nofollow'], card: { phone: null, bookingUrl: null }, poweredByHref: null,
  };
  it('tiny/ok uses the 24/7 claim; neutral never does', () => {
    expect(buildView(base).x).toBe('Calls answered 24/7 by Vireek');
    const n = buildView({ ...base, state: 'neutral' });
    expect(n.x).toBe('Answered by Vireek');
    expect(JSON.stringify(n)).not.toMatch(/24\/7/);
  });
  it('stat variant shows a number + freshness date; without data it degrades to neutral text, never a number', () => {
    const v = buildView({ ...base, variant: 'stat', stat: { kind: 'calls', value: 1234, asOf: '2026-10-30T10:00:00Z' } });
    expect(v.x).toBe('1,234 calls answered');
    expect(v.y).toContain('Oct 30');
    const none = buildView({ ...base, variant: 'stat', stat: null });
    expect(none.x).toBe('Calls answered 24/7 by Vireek');
    expect(none.y).toBeUndefined();
    const t = buildView({ ...base, variant: 'stat', stat: { kind: 'answer_time', value: 2100, asOf: '2026-10-30T10:00:00Z' } });
    expect(t.x).toBe('Avg. answer time 2.1s');
    expect(buildView({ ...base, variant: 'stat', stat: { kind: 'answer_time', value: 400, asOf: '2026-10-30T10:00:00Z' } }).x).toBe('Avg. answer time <1s');
  });
  it('card: only well-formed tel:/https actions survive', () => {
    const ok = buildView({ ...base, variant: 'card', card: { phone: '+15125550123', bookingUrl: 'https://vireek.com/book/acme' } });
    expect(ok.c).toEqual([{ x: 'Call now', h: 'tel:+15125550123' }, { x: 'Book online', h: 'https://vireek.com/book/acme' }]);
    const bad = buildView({ ...base, variant: 'card', card: { phone: 'javascript:alert(1)', bookingUrl: 'http://insecure.example' } });
    expect(bad.c).toBeUndefined();
  });
  it('RTL + locale + accessible name', () => {
    const v = buildView({ ...base, locale: 'fa' });
    expect(v.d).toBe('rtl');
    expect(v.a).toContain(STRINGS.fa.verify);
    expect(buildView({ ...base, locale: 'ar' }).d).toBe('rtl');
    expect(buildView(base).d).toBe('ltr');
  });
  it('emits no structured data / schema and no HTML', () => {
    const s = JSON.stringify(buildView({ ...base, variant: 'card', poweredByHref: 'https://vireek.com/?utm_source=trust_badge', card: { phone: '+15125550123', bookingUrl: null } }));
    expect(s).not.toMatch(/ld\+json|schema\.org|itemprop|itemtype|aggregateRating|<\w+/i);
  });
  it('powered-by only when a link is supplied', () => {
    expect(buildView(base).w).toBeUndefined();
    expect(buildView({ ...base, poweredByHref: 'https://vireek.com/' }).w?.x).toBe('Powered by Vireek');
  });
});

describe('growth link + rel', () => {
  it('partner code -> /r/<code> with UTM; otherwise UTM + slug', () => {
    const p = new URL(buildPoweredByHref({ appUrl: 'https://vireek.com', slug: 'acme', variant: 'card', partnerCode: 'ACME42' }));
    expect(p.pathname).toBe('/r/ACME42');
    expect(Object.fromEntries(p.searchParams)).toMatchObject({ utm_source: 'trust_badge', utm_medium: 'embed', utm_campaign: 'powered_by', utm_content: 'card' });
    const n = new URL(buildPoweredByHref({ appUrl: 'https://vireek.com', slug: 'acme', variant: 'tiny', partnerCode: null }));
    expect(n.pathname).toBe('/');
    expect(n.searchParams.get('utm_term')).toBe('acme');
  });
  it('ignores a malformed partner code instead of injecting it', () => {
    const u = buildPoweredByHref({ appUrl: 'https://vireek.com', slug: 'acme', variant: 'tiny', partnerCode: '../evil?x=1' });
    expect(u).not.toContain('evil');
  });
  it('rel: always noopener, only allow-listed SEO tokens', () => {
    expect(parseRel(['nofollow', 'sponsored', 'follow', 'noreferrer', 'x'])).toEqual(['nofollow', 'sponsored']);
    expect(parseRel('ugc, nofollow')).toEqual(['ugc', 'nofollow']);
    expect(relAttr([])).toBe('noopener');
    expect(relAttr(['nofollow', 'sponsored'])).toBe('noopener nofollow sponsored');
  });
});

describe('install snippets', () => {
  const o = { origin: 'https://vireek.com', slug: 'acme', variant: 'tiny', theme: 'auto', size: 'md', palette: 'blue', lang: 'en', sri: 'sha384-abc' } as const;
  it('script tag is async, SRI + crossorigin when a hash is known', () => {
    const s = buildScriptSnippet(o);
    expect(s).toContain('async');
    expect(s).toContain('integrity="sha384-abc" crossorigin="anonymous"');
    expect(s).toContain('data-slug="acme"');
    expect(buildScriptSnippet({ ...o, sri: null })).not.toContain('integrity');
  });
  it('react snippet loads the same script with the same attributes', () => {
    const r = buildReactSnippet(o);
    expect(r).toContain("s.src = 'https://vireek.com/embed/badge.v1.js'");
    expect(r).toContain("s.dataset.slug = 'acme'");
    expect(r).toContain("s.integrity = 'sha384-abc'");
  });
});
