import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, newRequestId } from './api.js';

const config = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k'.repeat(50) };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('api', () => {
  it('posts the action with the bearer token', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true }));
    const call = createApi({
      config,
      session: { getAccessToken: async () => 'tok' },
      fetchImpl: f,
    });
    expect(await call('whoami')).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://x.supabase.co/functions/v1/browser-extension');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ action: 'whoami' });
  });

  it('refreshes once on 401 then retries', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const refresh = vi.fn().mockResolvedValue('new');
    const call = createApi({
      config,
      session: { getAccessToken: async () => 'old', refresh },
      fetchImpl: f,
    });
    expect(await call('recent')).toEqual({ ok: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });

  it('throws ApiError with code, status and data', async () => {
    const f = vi.fn().mockResolvedValue(res(409, { code: 'dnc_suppressed', error: 'x' }));
    const call = createApi({ config, session: { getAccessToken: async () => 't' }, fetchImpl: f });
    await expect(call('click_to_call', {})).rejects.toMatchObject({
      status: 409,
      code: 'dnc_suppressed',
    });
    await expect(call('click_to_call', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps network failures and passes auth errors through', async () => {
    const call = createApi({
      config,
      session: { getAccessToken: async () => 't' },
      fetchImpl: async () => {
        throw new TypeError('x');
      },
    });
    await expect(call('whoami')).rejects.toMatchObject({ code: 'network' });
    const call2 = createApi({
      config,
      session: {
        getAccessToken: async () => {
          throw Object.assign(new Error('s'), { code: 'signed_out' });
        },
      },
    });
    await expect(call2('whoami')).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('creates valid request ids', () => {
    expect(newRequestId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
