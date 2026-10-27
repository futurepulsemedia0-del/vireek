import { describe, expect, it } from 'vitest';
import { findEmails, findPhones, formatPhone, phoneFromTelHref, toE164 } from './phone.js';

describe('toE164', () => {
  it.each([
    ['(555) 123-4567', null], // 555 is not a valid NANP exchange start? 123 starts with 1 -> invalid
    ['(212) 555-0123', '+12125550123'],
    ['1-212-555-0123', '+12125550123'],
    ['+44 20 7946 0958', '+442079460958'],
    ['0044 20 7946 0958', '+442079460958'],
    ['+12125550123', '+12125550123'],
  ])('%s', (i, o) => expect(toE164(i)).toBe(o));
  it.each(['', 'abc', '123456', '+0123456789', null, undefined, 12125550123])('rejects %s', (i) =>
    expect(toE164(i)).toBeNull(),
  );
});

describe('findPhones', () => {
  it('finds formatted numbers with positions', () => {
    const text = 'Call us: (212) 555-0123 or +44 20 7946 0958 today';
    const r = findPhones(text);
    expect(r.map((x) => x.e164)).toEqual(['+12125550123', '+442079460958']);
    expect(text.slice(r[0].start, r[0].end).trim()).toBe('(212) 555-0123');
  });
  it('ignores dates, prices, ids, urls and emails', () => {
    for (const s of [
      'Posted 2026-10-27 and 12/31/2026',
      'Order #123456789012',
      'Price $1,234,567.89',
      'https://x.com/212-555-0123',
      'a212.555.0123@x.com',
      '3.14159265358979',
    ]) {
      expect(findPhones(s)).toEqual([]);
    }
  });
  it('respects limit and rejects oversized input', () => {
    expect(findPhones('(212) 555-0123, (212) 555-0124, (212) 555-0125', 2)).toHaveLength(2);
    expect(findPhones('x'.repeat(30000))).toEqual([]);
    expect(findPhones(null)).toEqual([]);
  });
});

describe('helpers', () => {
  it('parses tel: links', () => {
    expect(phoneFromTelHref('tel:+1-212-555-0123')).toBe('+12125550123');
    expect(phoneFromTelHref('tel:%2B442079460958;ext=1')).toBe('+442079460958');
    expect(phoneFromTelHref('mailto:a@b.com')).toBeNull();
    expect(phoneFromTelHref('tel:%E0%A4%A')).toBeNull();
  });
  it('formats and finds emails', () => {
    expect(formatPhone('+12125550123')).toBe('(212) 555-0123');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
    expect(findEmails('a@b.com, A@B.com; c.d@e.io')).toEqual(['a@b.com', 'A@B.com', 'c.d@e.io']);
  });
});
