import { describe, it, expect } from 'vitest';
import { cronSecretMatches, timingSafeEqual } from './auth';

describe('cronSecretMatches', () => {
  const secret = 'a-long-enough-secret-123';
  it('accepts the exact secret', () => expect(cronSecretMatches(secret, secret)).toBe(true));
  it('rejects wrong, missing and prefix-only values', () => {
    expect(cronSecretMatches('nope', secret)).toBe(false);
    expect(cronSecretMatches(null, secret)).toBe(false);
    expect(cronSecretMatches(secret.slice(0, 10), secret)).toBe(false);
  });
  it('rejects when the configured secret is empty or too short (fail closed)', () => {
    expect(cronSecretMatches('', '')).toBe(false);
    expect(cronSecretMatches('short', 'short')).toBe(false);
  });
  it('timingSafeEqual handles different lengths', () => expect(timingSafeEqual('a', 'ab')).toBe(false));
});
