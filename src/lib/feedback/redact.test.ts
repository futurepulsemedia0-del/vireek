import { describe, expect, it } from 'vitest';
import fixtures from './redactionFixtures.json';
import { redactText, sanitizeRoute } from './redact';

describe('redactText', () => {
  it.each(fixtures)('redacts: $in', ({ in: input, out }) => {
    expect(redactText(input)).toBe(out);
  });
  it('redacts JWTs', () => {
    expect(redactText('t eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4 x')).toBe('t [token] x');
  });
  it('is idempotent', () => {
    const once = redactText('a@b.com 555-123-4567');
    expect(redactText(once)).toBe(once);
  });
});

describe('sanitizeRoute', () => {
  it('drops query/hash and ids', () => {
    expect(sanitizeRoute('/dashboard/jobs/6f1c2c1e-1111-4222-8333-444455556666/edit?x=1#a')).toBe('/dashboard/jobs/:id/edit');
    expect(sanitizeRoute('/dashboard/customers/12345')).toBe('/dashboard/customers/:id');
    expect(sanitizeRoute('/dashboard')).toBe('/dashboard');
  });
});
