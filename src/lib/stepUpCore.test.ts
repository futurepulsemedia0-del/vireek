import { describe, expect, it } from 'vitest';
import { availableMethods, isReauthRequiredError, isRecentlyAuthenticated, latestAuthAt, StepUpCancelledError } from './stepUpCore';

const jwt = (payload: unknown) => `h.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
const NOW = 1_800_000_000_000;

describe('latestAuthAt / isRecentlyAuthenticated', () => {
  it('uses the newest amr timestamp', () => {
    const t = jwt({ amr: [{ method: 'password', timestamp: 1_799_999_000 }, { method: 'totp', timestamp: 1_799_999_900 }] });
    expect(latestAuthAt(t)).toBe(1_799_999_900);
    expect(isRecentlyAuthenticated(t, NOW, 600)).toBe(true);
  });
  it('is false when stale, missing, malformed or not a token', () => {
    expect(isRecentlyAuthenticated(jwt({ amr: [{ method: 'password', timestamp: 1_799_990_000 }] }), NOW, 600)).toBe(false);
    expect(latestAuthAt(jwt({}))).toBeNull();
    expect(latestAuthAt(jwt({ amr: 'x' }))).toBeNull();
    expect(latestAuthAt(jwt({ amr: [{ method: 'p', timestamp: 'now' }] }))).toBeNull();
    expect(latestAuthAt('garbage')).toBeNull();
    expect(isRecentlyAuthenticated('a.b', NOW)).toBe(false);
  });
});

describe('isReauthRequiredError', () => {
  it('recognises the DB error however it is wrapped', () => {
    expect(isReauthRequiredError({ message: 'REAUTH_REQUIRED' })).toBe(true);
    expect(isReauthRequiredError({ message: 'x', details: 'REAUTH_REQUIRED' })).toBe(true);
    expect(isReauthRequiredError({ message: 'x', hint: 'REAUTH_REQUIRED' })).toBe(true);
    expect(isReauthRequiredError(new Error('network down'))).toBe(false);
    expect(isReauthRequiredError(null)).toBe(false);
    expect(isReauthRequiredError('REAUTH_REQUIRED')).toBe(false);
  });
  it('cancel error is distinguishable', () => {
    expect(new StepUpCancelledError() instanceof StepUpCancelledError).toBe(true);
  });
});

describe('availableMethods', () => {
  it('offers totp first, password for email accounts, email code as universal fallback', () => {
    expect(availableMethods({ providers: ['email'], hasVerifiedTotp: true, email: 'a@b.co' })).toEqual(['totp', 'password', 'emailCode']);
    expect(availableMethods({ providers: ['google'], hasVerifiedTotp: false, email: 'a@b.co' })).toEqual(['emailCode']);
    expect(availableMethods({ providers: ['google'], hasVerifiedTotp: false, email: null })).toEqual([]);
  });
});
