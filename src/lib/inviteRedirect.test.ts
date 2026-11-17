import { beforeEach, describe, expect, it } from 'vitest';
import { consumePostAuthRedirect, isValidInviteToken, setPendingInviteToken, setPostAuthPath } from './inviteRedirect';

const UUID = '3f2b8c1e-9d4a-4b7e-8a61-0c5d2e7f9a10';

describe('inviteRedirect', () => {
  beforeEach(() => sessionStorage.clear());

  it('returns the invite path for a valid uuid token and consumes it once', () => {
    setPendingInviteToken(UUID);
    expect(consumePostAuthRedirect()).toBe(`/invite/${UUID}`);
    expect(consumePostAuthRedirect()).toBe('/dashboard');
  });
  it('rejects path-traversal / URL-like tokens on write', () => {
    for (const bad of ['../admin', '//evil.com', 'https://evil.com', 'abc', '']) {
      setPendingInviteToken(bad);
      expect(consumePostAuthRedirect()).toBe('/dashboard');
    }
  });
  it('ignores a tampered value already sitting in sessionStorage', () => {
    sessionStorage.setItem('vireek_pending_invite_token', '../../billing');
    expect(consumePostAuthRedirect()).toBe('/dashboard');
    expect(sessionStorage.getItem('vireek_pending_invite_token')).toBeNull();
  });
  it('only allows /talent/ post-auth paths', () => {
    setPostAuthPath('https://evil.com');
    setPostAuthPath('/admin');
    expect(consumePostAuthRedirect()).toBe('/dashboard');
    setPostAuthPath('/talent/jobs/abc-1');
    expect(consumePostAuthRedirect()).toBe('/talent/jobs/abc-1');
  });
  it('validates uuid shape', () => {
    expect(isValidInviteToken(UUID)).toBe(true);
    expect(isValidInviteToken(UUID + 'x')).toBe(false);
  });
});
