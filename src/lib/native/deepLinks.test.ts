import { describe, expect, it } from 'vitest';
import { resolveDeepLink } from './deepLinks';

describe('resolveDeepLink', () => {
  it('maps vireek.com URLs to in-app paths', () => {
    expect(resolveDeepLink('https://vireek.com/tech/job/42?x=1')).toEqual({ path: '/tech/job/42?x=1', isAuthLink: false });
    expect(resolveDeepLink('https://www.vireek.com/dashboard')?.path).toBe('/dashboard');
  });

  it('maps the vireek:// scheme', () => {
    expect(resolveDeepLink('vireek://tech/today')?.path).toBe('/tech/today');
    expect(resolveDeepLink('vireek:///tech/job/7')?.path).toBe('/tech/job/7');
  });

  it('accepts relative paths from push payloads', () => {
    expect(resolveDeepLink('/tech/today')?.path).toBe('/tech/today');
  });

  it('flags Supabase auth links', () => {
    expect(resolveDeepLink('https://vireek.com/reset-password#access_token=a&refresh_token=b&type=recovery')?.isAuthLink).toBe(true);
    expect(resolveDeepLink('https://vireek.com/login?code=abc')?.isAuthLink).toBe(true);
  });

  it('rejects foreign hosts, protocol-relative and malformed input', () => {
    expect(resolveDeepLink('https://evil.com/tech/today')).toBeNull();
    expect(resolveDeepLink('//evil.com/x')).toBeNull();
    expect(resolveDeepLink('javascript:alert(1)')).toBeNull();
    expect(resolveDeepLink('https://vireek.com.evil.com/x')).toBeNull();
    expect(resolveDeepLink('')).toBeNull();
  });
});
