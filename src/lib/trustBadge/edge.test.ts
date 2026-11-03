// @vitest-environment node
// Drives the real trust-badge edge handler with the database mocked: domain binding, state matrix, tampering, privacy.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signBadgeToken } from './core';

const SECRET = 's'.repeat(40);
let ctx: Record<string, unknown> | null;
const rpc = vi.fn(async (fn: string) => {
  if (fn === 'trust_badge_public_context') return { data: ctx, error: null };
  if (fn === 'trust_badge_hit') return { data: true, error: null };
  return { data: null, error: null };
});
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: () => ({ rpc }) }));

let handler: (r: Request) => Promise<Response>;
beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => ({ TRUST_BADGE_SIGNING_SECRET: SECRET, PUBLIC_APP_URL: 'https://vireek.com', SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k' } as Record<string, string>)[k] },
    serve: (h: (r: Request) => Promise<Response>) => { handler = h; },
  });
  await import('../../../supabase/functions/trust-badge/index.ts');
});

const base = () => ({
  slug: 'acme', enabled: true, displayName: 'Acme Plumbing', profileStatus: 'active', subscriptionStatus: 'active', whiteLabel: false,
  planCategory: 'standard', activeSince: '2026-01', metric: 'calls',
  stats: { callCount: 120, latestCallAt: new Date(Date.now() - 86_400_000).toISOString(), timedCount: 0, latestTimedAt: null, avgAnswerMs: null },
  showPoweredBy: true, linkRel: ['nofollow'], cardPhone: '+15125550123', bookingSlug: 'acme', partnerCode: null, hosts: ['acme.com'],
});
const render = (qs: Record<string, string>, origin: string | null = 'https://www.acme.com') => {
  const q = new URLSearchParams({ k: 'acme', v: 'stat', h: 'www.acme.com', l: 'en', ...qs });
  return handler(new Request(`https://x.supabase.co/functions/v1/trust-badge/render?${q}`, { headers: origin ? { origin } : {} }));
};

beforeEach(() => { ctx = base(); rpc.mockClear(); });

describe('GET /render', () => {
  it('serves a live stat badge to the verified host, cacheable, with a heartbeat', async () => {
    const res = await render({});
    const v = await res.json();
    expect(res.status).toBe(200);
    expect(v.s).toBe('ok');
    expect(v.x).toBe('120 calls answered');
    expect(v.h).toMatch(/^https:\/\/vireek\.com\/verify\/acme\?t=/);
    expect(v.w.h).toContain('utm_source=trust_badge');
    expect(res.headers.get('cache-control')).toContain('s-maxage=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(rpc).toHaveBeenCalledWith('trust_badge_touch', expect.objectContaining({ p_slug: 'acme', p_host: 'acme.com' }));
  });
  it.each([
    ['another site copying the snippet', 'https://evil.com', 'evil.com'],
    ['a lookalike domain', 'https://acme.com.evil.com', 'acme.com.evil.com'],
    ['Origin and h disagree (cache-key games)', 'https://evil.com', 'www.acme.com'],
  ])('hides for %s', async (_n, origin, h) => {
    expect(await (await render({ h }, origin)).json()).toEqual({ s: 'hidden' });
  });
  it('hides without an Origin header (non-browser clients)', async () => {
    expect(await (await render({}, null)).json()).toEqual({ s: 'hidden' });
  });
  it.each([
    ['disabled', { enabled: false }], ['suspended profile', { profileStatus: 'suspended' }], ['canceled', { profileStatus: 'canceled' }],
    ['dunning-suspended', { subscriptionStatus: 'suspended' }], ['no verified domains', { hosts: [] }],
  ])('hides when %s', async (_n, patch) => {
    ctx = { ...base(), ...patch };
    expect(await (await render({})).json()).toEqual({ s: 'hidden' });
  });
  it('goes neutral (no 24/7 claim, no numbers) when past_due', async () => {
    ctx = { ...base(), subscriptionStatus: 'past_due' };
    const v = await (await render({})).json();
    expect(v.s).toBe('neutral');
    expect(JSON.stringify(v)).not.toMatch(/24\/7|calls answered/);
  });
  it('falls back to neutral-safe text when stats are stale, too small, or not approved', async () => {
    for (const stats of [
      { ...base().stats, latestCallAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
      { ...base().stats, callCount: 5 },
      null,
    ]) {
      ctx = { ...base(), stats };
      const v = await (await render({})).json();
      expect(v.s).toBe('ok');
      expect(v.x).toBe('Calls answered 24/7 by Vireek');
      expect(v.y).toBeUndefined();
    }
  });
  it('answer_time stays off while nothing measures it', async () => {
    ctx = { ...base(), metric: 'answer_time' };
    const v = await (await render({})).json();
    expect(v.x).not.toMatch(/answer time/i);
  });
  it('white-label plans can drop Powered-by; others cannot even if the flag is off', async () => {
    ctx = { ...base(), showPoweredBy: false, whiteLabel: true };
    expect((await (await render({})).json()).w).toBeUndefined();
    ctx = { ...base(), showPoweredBy: false, whiteLabel: false };
    expect((await (await render({})).json()).w).toBeDefined();
  });
  it('uses the partner code for attribution when the owner is an approved partner', async () => {
    ctx = { ...base(), partnerCode: 'ACME42' };
    expect(new URL((await (await render({})).json()).w.h).pathname).toBe('/r/ACME42');
  });
  it('Do Not Track skips the heartbeat; junk slugs never reach the database', async () => {
    await render({ dnt: '1' });
    expect(rpc).not.toHaveBeenCalledWith('trust_badge_touch', expect.anything());
    rpc.mockClear();
    expect(await (await render({ k: "x';drop table" })).json()).toEqual({ s: 'hidden' });
    expect(rpc).not.toHaveBeenCalledWith('trust_badge_public_context', expect.anything());
  });
  it('returns 429 when rate limited, and never breaks the page on internal errors', async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect((await render({})).status).toBe(429);
    rpc.mockImplementationOnce(() => { throw new Error('db down'); });
    const res = await render({});
    expect(await res.json()).toEqual({ s: 'hidden' });
  });
});

describe('GET /verify', () => {
  const verify = (qs: Record<string, string>) =>
    handler(new Request(`https://x.supabase.co/functions/v1/trust-badge/verify?${new URLSearchParams({ slug: 'acme', ...qs })}`));
  const tok = (o: Partial<{ s: string; h: string; e: number }> = {}) => {
    const i = Math.floor(Date.now() / 1000);
    return signBadgeToken(SECRET, { s: 'acme', h: 'www.acme.com', i, e: i + 3600, ...o });
  };

  it('shows only approved facts and validates the token host', async () => {
    const j = await (await verify({ t: await tok() })).json();
    expect(j.active).toBe(true);
    expect(j.facts.activeSince).toBe('2026-01');
    expect(j.facts.callsAnswered.count).toBe(120);
    expect(j.token).toMatchObject({ valid: true, host: 'www.acme.com', hostVerified: true });
  });
  it('shares nothing that was not approved', async () => {
    ctx = { ...base(), activeSince: null, planCategory: null, stats: null };
    const j = await (await verify({})).json();
    expect(j.facts).toEqual({});
    expect(JSON.stringify(j)).not.toMatch(/callsAnswered|avgAnswerMs|activeSince|planCategory/);
  });
  it('flags a genuine token that was issued to a host the account does not own', async () => {
    const j = await (await verify({ t: await tok({ h: 'evil.com' }) })).json();
    expect(j.token).toMatchObject({ valid: true, host: 'evil.com', hostVerified: false });
  });
  it('rejects forged, expired and cross-account tokens', async () => {
    const good = await tok();
    const forged = `${btoa(JSON.stringify({ s: 'acme', h: 'evil.com', i: 1, e: 9999999999 })).replace(/=+$/, '')}.${good.split('.')[1]}`;
    expect((await (await verify({ t: forged })).json()).token.valid).toBe(false);
    expect((await (await verify({ t: await tok({ e: 10 }) })).json()).token).toMatchObject({ valid: false, reason: 'expired' });
    expect((await (await verify({ t: await tok({ s: 'other' }) })).json()).token).toMatchObject({ valid: false, reason: 'wrong_account' });
  });
  it('reveals nothing for suspended accounts or unknown slugs', async () => {
    ctx = { ...base(), profileStatus: 'suspended' };
    const j = await (await verify({})).json();
    expect(j).toMatchObject({ found: true, active: false });
    expect(j.facts).toBeUndefined();
    ctx = null;
    expect((await verify({})).status).toBe(404);
  });
});
