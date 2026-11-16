import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubSentryEvent, scrubText, scrubValue } from './sentryScrub';

describe('sentryScrub', () => {
  it('removes phone numbers, emails, card numbers (Luhn) and tokens from text', () => {
    const s = scrubText('call +1 555-123-4567 or a.b@x.com card 4242 4242 4242 4242 Bearer abcdefghijkl123 ?token=abc123');
    expect(s).not.toMatch(/555-123-4567/);
    expect(s).not.toMatch(/a\.b@x\.com/);
    expect(s).not.toMatch(/4242 4242/);
    expect(s).not.toMatch(/abcdefghijkl123/);
    expect(s).not.toMatch(/token=abc123/);
  });
  it('keeps non-card digit runs (order numbers) readable', () => {
    expect(scrubText('order 1234567890123')).toContain('order');
  });
  it('drops sensitive keys (transcript, phone, email, token...) deeply', () => {
    const v = scrubValue({ a: { transcript: 'my address is 5 Oak St', callerPhone: '+15551234567', ok: 'fine', nested: [{ apiKey: 'x' }] } }) as any;
    expect(v.a.transcript).toBe('[redacted]');
    expect(v.a.callerPhone).toBe('[redacted]');
    expect(v.a.ok).toBe('fine');
    expect(v.a.nested[0].apiKey).toBe('[redacted]');
  });
  it('scrubs a full event: request body/headers/cookies gone, user reduced to id, extra + breadcrumbs scrubbed', () => {
    const ev = scrubSentryEvent({
      request: { url: 'https://app.test/x?token=abc#h', method: 'POST', headers: { cookie: 'a' }, data: { phone: '+15551234567' }, cookies: { a: 'b' } },
      user: { id: 'u1', email: 'a@b.co', ip_address: '1.2.3.4' },
      extra: { transcript: 'hello', note: 'ring 555 123 4567' },
      breadcrumbs: [{ message: 'sent to a@b.co', data: { phone: '+1' } }],
      exception: { values: [{ value: 'fail for a@b.co' }] },
    }) as any;
    expect(ev.request.headers).toBeUndefined();
    expect(ev.request.data).toBeUndefined();
    expect(ev.request.url).not.toMatch(/token=abc/);
    expect(ev.user).toEqual({ id: 'u1' });
    expect(ev.extra.transcript).toBe('[redacted]');
    expect(ev.breadcrumbs[0].message).not.toMatch(/a@b\.co/);
    expect(ev.breadcrumbs[0].data.phone).toBe('[redacted]');
    expect(ev.exception.values[0].value).not.toMatch(/a@b\.co/);
  });
  it('drops console breadcrumbs and fails closed on malformed events', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    const bad: any = {}; Object.defineProperty(bad, 'extra', { get() { throw new Error('x'); }, enumerable: true });
    expect(scrubSentryEvent(bad)).toBeNull();
  });
});
