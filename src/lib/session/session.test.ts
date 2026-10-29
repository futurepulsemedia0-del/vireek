import { describe, expect, it, vi } from 'vitest';
import { classifySignOut, isAuthExpiredMessage, isTerminalRefreshError, needsRefresh } from '@/lib/session/sessionHealth';
import { reauthGate, withReauth } from '@/lib/session/reauthGate';
import { createReauthFetch } from '@/lib/session/reauthFetch';

describe('sessionHealth', () => {
  it('needsRefresh', () => {
    expect(needsRefresh(1000, 1_000_000 - 120_000)).toBe(false);
    expect(needsRefresh(1000, 1_000_000 - 30_000)).toBe(true);
    expect(needsRefresh(null, 0)).toBe(false);
  });
  it('classifySignOut ignores intentional and sessionless sign-outs', () => {
    expect(classifySignOut('SIGNED_OUT', true, false)).toBe('expired');
    expect(classifySignOut('SIGNED_OUT', true, true)).toBe('none');
    expect(classifySignOut('SIGNED_OUT', false, false)).toBe('none');
    expect(classifySignOut('TOKEN_REFRESHED', true, false)).toBe('none');
  });
  it('detects expired messages and terminal refresh errors', () => {
    expect(isAuthExpiredMessage('JWT expired')).toBe(true);
    expect(isAuthExpiredMessage('duplicate key')).toBe(false);
    expect(isAuthExpiredMessage('x', 'PGRST301')).toBe(true);
    expect(isTerminalRefreshError({ status: 400, message: 'Invalid Refresh Token' })).toBe(true);
    expect(isTerminalRefreshError({ name: 'AuthRetryableFetchError', status: 0 })).toBe(false);
  });
});

describe('reauthGate / withReauth', () => {
  reauthGate.setEnabled(true);
  it('shares one prompt across concurrent callers and retries once', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('JWT expired')).mockResolvedValue('ok');
    const p = withReauth(fn, (e) => /expired/.test(String(e)));
    await new Promise((r) => setTimeout(r, 0)); // let the first call fail and open the prompt
    const second = reauthGate.request();
    expect(reauthGate.getState().open).toBe(true);
    reauthGate.resolve(true);
    await expect(p).resolves.toBe('ok');
    await expect(second).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(reauthGate.getState().open).toBe(false);
  });
  it('rethrows when dismissed', async () => {
    const p = withReauth(() => Promise.reject(new Error('JWT expired')), () => true);
    await new Promise((r) => setTimeout(r, 0));
    reauthGate.resolve(false);
    await expect(p).rejects.toThrow('JWT expired');
  });
  it('refuses to prompt when no session exists', async () => {
    reauthGate.setEnabled(false);
    await expect(reauthGate.request()).resolves.toBe(false);
    reauthGate.setEnabled(true);
  });
  it('does not retry unrelated errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withReauth(fn, () => false)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createReauthFetch', () => {
  const expired = () => new Response(JSON.stringify({ message: 'JWT expired', code: 'PGRST301' }), { status: 401 });
  it('replays the request once with the fresh token', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(expired()).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const f = createReauthFetch({ baseFetch: base, requestReauth: async () => true, getAccessToken: async () => 'NEW' });
    const res = await f('https://p.supabase.co/rest/v1/jobs', { method: 'POST', body: '{"a":1}', headers: { Authorization: 'Bearer OLD' } });
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    const sent = base.mock.calls[1]![1]!;
    expect(new Headers(sent.headers).get('Authorization')).toBe('Bearer NEW');
    expect(sent.body).toBe('{"a":1}');
  });
  it('returns the 401 when the user dismisses, and ignores auth/ and non-expiry 401s', async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(async () => expired());
    const dismissed = createReauthFetch({ baseFetch: base, requestReauth: async () => false, getAccessToken: async () => 'x' });
    expect((await dismissed('https://p.supabase.co/rest/v1/jobs')).status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    const authCall = createReauthFetch({ baseFetch: base, requestReauth: async () => true, getAccessToken: async () => 'x' });
    await authCall('https://p.supabase.co/auth/v1/token');
    expect(base).toHaveBeenCalledTimes(2);
    const other = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"message":"nope"}', { status: 401 }));
    const f3 = createReauthFetch({ baseFetch: other, requestReauth: async () => true, getAccessToken: async () => 'x' });
    await f3('https://p.supabase.co/functions/v1/x');
    expect(other).toHaveBeenCalledTimes(1);
  });
});
