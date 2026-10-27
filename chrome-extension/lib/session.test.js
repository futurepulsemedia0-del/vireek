import { describe, expect, it, vi } from 'vitest';
import { createSession } from './session.js';

const config = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k'.repeat(50) };
const memStorage = () => {
  const m = {};
  return {
    m,
    get: async (k) => ({ [k]: m[k] }),
    set: async (v) => Object.assign(m, v),
    remove: async (k) => {
      delete m[k];
    },
  };
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (status, body = {}) => ({ ok: false, status, json: async () => body });
const tokens = (n, extra = {}) => ({
  access_token: `a${n}`,
  refresh_token: `r${n}`,
  expires_in: 3600,
  user: { id: 'u', email: 'e@x.com', factors: [] },
  ...extra,
});

describe('session', () => {
  it('signs in and reports status', async () => {
    const storage = memStorage();
    const f = vi.fn().mockResolvedValue(ok(tokens(1)));
    const s = createSession({ config, fetchImpl: f, storage });
    expect(await s.signIn(' e@x.com ', 'pw')).toEqual({ mfaFactor: null });
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ email: 'e@x.com', password: 'pw' });
    expect(f.mock.calls[0][1].headers.apikey).toBe(config.SUPABASE_ANON_KEY);
    expect(await s.status()).toEqual({ signedIn: true, email: 'e@x.com' });
  });

  it('flags a verified TOTP factor and completes MFA', async () => {
    const storage = memStorage();
    const factors = [{ id: 'f1', status: 'verified', factor_type: 'totp' }];
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok(tokens(1, { user: { id: 'u', email: 'e', factors } })))
      .mockResolvedValueOnce(ok({ id: 'ch1' }))
      .mockResolvedValueOnce(ok(tokens(2, { user: undefined })));
    const s = createSession({ config, fetchImpl: f, storage });
    expect((await s.signIn('e', 'p')).mfaFactor).toBe('f1');
    await s.verifyMfa(' 123456 ');
    expect(f.mock.calls[1][0]).toContain('/factors/f1/challenge');
    expect(JSON.parse(f.mock.calls[2][1].body)).toEqual({ challenge_id: 'ch1', code: '123456' });
    expect(f.mock.calls[2][1].headers.Authorization).toBe('Bearer a1');
    expect(storage.m.vk_session.access_token).toBe('a2');
    expect(storage.m.vk_session.user.factors).toHaveLength(1);
  });

  it('maps bad credentials and network errors', async () => {
    const s1 = createSession({
      config,
      fetchImpl: async () => bad(400, { error_description: 'Invalid login' }),
      storage: memStorage(),
    });
    await expect(s1.signIn('a', 'b')).rejects.toMatchObject({ code: 'invalid' });
    const s2 = createSession({
      config,
      fetchImpl: async () => {
        throw new TypeError('x');
      },
      storage: memStorage(),
    });
    await expect(s2.signIn('a', 'b')).rejects.toMatchObject({ code: 'network' });
  });

  it('refreshes expired tokens once even for concurrent callers', async () => {
    let t = 1_000_000;
    const storage = memStorage();
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok(tokens(1, { expires_in: 100 })))
      .mockResolvedValue(ok(tokens(2)));
    const s = createSession({ config, fetchImpl: f, storage, now: () => t });
    await s.signIn('e', 'p');
    expect(await s.getAccessToken()).toBe('a1'); // 100s lifetime > 60s skew
    t += 60_000;
    const [x, y] = await Promise.all([s.getAccessToken(), s.getAccessToken()]);
    expect([x, y]).toEqual(['a2', 'a2']);
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ refresh_token: 'r1' });
  });

  it('clears the session when the refresh token is rejected, and on sign out', async () => {
    const storage = memStorage();
    storage.m.vk_session = { access_token: 'a', refresh_token: 'r', expires_at: 0, user: null };
    const s = createSession({ config, fetchImpl: async () => bad(400), storage });
    await expect(s.getAccessToken()).rejects.toMatchObject({ code: 'invalid' });
    expect(storage.m.vk_session).toBeUndefined();
    await expect(s.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' });
    storage.m.vk_session = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Date.now() + 1e7,
      user: null,
    };
    await s.signOut();
    expect(storage.m.vk_session).toBeUndefined();
  });
});
