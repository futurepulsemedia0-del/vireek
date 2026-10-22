import { describe, expect, it } from 'vitest';
import { appendBookingLink, buildTrackedBookingLink, wantsBookingLink } from './bookingLink';

const TOKEN = 'abcdef0123456789abcd';

describe('buildTrackedBookingLink', () => {
  it('builds the link on the site origin', () => {
    expect(buildTrackedBookingLink({ siteUrl: 'https://app.vireek.com/', slug: 'acme-plumbing', token: TOKEN })).toBe(
      `https://app.vireek.com/book/acme-plumbing?src=text_back&rl=${TOKEN}`,
    );
  });
  it('uses a safe custom source and falls back otherwise', () => {
    expect(buildTrackedBookingLink({ siteUrl: 'https://a.co', slug: 'abc', token: TOKEN, source: 'followup' })).toContain('src=followup');
    expect(buildTrackedBookingLink({ siteUrl: 'https://a.co', slug: 'abc', token: TOKEN, source: 'bad value&x=1' })).toContain('src=text_back');
  });
  it('refuses anything invalid', () => {
    expect(buildTrackedBookingLink({ siteUrl: 'https://a.co', slug: null, token: TOKEN })).toBeNull();
    expect(buildTrackedBookingLink({ siteUrl: 'https://a.co', slug: 'Bad Slug', token: TOKEN })).toBeNull();
    expect(buildTrackedBookingLink({ siteUrl: 'https://a.co', slug: 'abc', token: 'short' })).toBeNull();
    expect(buildTrackedBookingLink({ siteUrl: 'not a url', slug: 'abc', token: TOKEN })).toBeNull();
    expect(buildTrackedBookingLink({ siteUrl: 'javascript:alert(1)', slug: 'abc', token: TOKEN })).toBeNull();
  });
});

describe('appendBookingLink', () => {
  const link = `https://a.co/book/abc?src=text_back&rl=${TOKEN}`;
  it('appends once', () => {
    const once = appendBookingLink('Sorry we missed you!  ', link);
    expect(once).toBe(`Sorry we missed you! Book online: ${link}`);
    expect(appendBookingLink(once, link)).toBe(once);
  });
  it('is a no-op without a link', () => {
    expect(appendBookingLink('Hi', null)).toBe('Hi');
    expect(appendBookingLink('Hi', undefined)).toBe('Hi');
  });
});

describe('wantsBookingLink', () => {
  it('detects the flag and the template variable', () => {
    expect(wantsBookingLink({ include_booking_link: true })).toBe(true);
    expect(wantsBookingLink({ body: 'Book: {{ booking_link }}' })).toBe(true);
    expect(wantsBookingLink({ body: 'Hello' })).toBe(false);
    expect(wantsBookingLink({})).toBe(false);
  });
});
