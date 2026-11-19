// Contract + behaviour tests: ServiceTitan Capacity read and the FSM gate (fixtures are SYNTHETIC, see price-book/__fixtures__/README.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FsmAvailabilityError, clearServiceTitanTokenCache, fetchServiceTitanCapacity, normalizeCapacity, slotAllowedByWindows } from './serviceTitanCapacity';
import { clearFsmGateCache, resolveFsmGate } from './gate';

const fixture = readFileSync(join(__dirname, '__fixtures__', 'servicetitan-capacity.json'), 'utf8');
const CFG = { st_client_id: 'cid', st_client_secret: 'sec', st_app_key: 'key', st_tenant_id: '12345', st_business_unit_id: '7', st_job_type_id: '9' };
const ok = (b: string, s = 200) => new Response(b, { status: s, headers: { 'Content-Type': 'application/json' } });
const T = (iso: string) => Date.parse(iso);
const sleep = async () => undefined;

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as typeof fetch;
  return { calls, fetchImpl };
}
const tokenOr = (cap: () => Response) => (url: string) => (url.includes('/connect/token') ? ok('{"access_token":"tok","expires_in":900}') : cap());

beforeEach(() => { clearServiceTitanTokenCache(); clearFsmGateCache(); });
afterEach(() => vi.restoreAllMocks());

describe('ServiceTitan capacity contract', () => {
  it('POSTs dispatch/v2 capacity with bearer + app key and the documented body', async () => {
    const s = stub(tokenOr(() => ok(fixture)));
    await fetchServiceTitanCapacity(CFG, { fromMs: T('2026-11-19T00:00:00Z'), toMs: T('2026-11-21T00:00:00Z') }, { fetchImpl: s.fetchImpl, sleep });
    const tok = s.calls[0];
    expect(tok.url).toBe('https://auth.servicetitan.io/connect/token');
    expect(String(tok.init.body)).toContain('grant_type=client_credentials');
    const cap = s.calls[1];
    expect(cap.url).toBe('https://api.servicetitan.io/dispatch/v2/tenant/12345/capacity');
    expect(cap.init.method).toBe('POST');
    const h = cap.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['ST-App-Key']).toBe('key');
    expect(JSON.parse(String(cap.init.body))).toEqual({
      startsOnOrAfter: '2026-11-19T00:00:00.000Z', endsOnOrBefore: '2026-11-21T00:00:00.000Z',
      businessUnitIds: [7], jobTypeId: 9, skillBasedAvailability: false,
    });
  });

  it('uses the integration hosts when env=integration', async () => {
    const s = stub(tokenOr(() => ok(fixture)));
    await fetchServiceTitanCapacity(CFG, { fromMs: T('2026-11-19T00:00:00Z'), toMs: T('2026-11-20T00:00:00Z') }, { fetchImpl: s.fetchImpl, sleep, env: 'integration' });
    expect(s.calls[0].url).toBe('https://auth-integration.servicetitan.io/connect/token');
    expect(s.calls[1].url).toContain('https://api-integration.servicetitan.io/dispatch/v2/tenant/12345/capacity');
  });

  it('normalises: open only when isAvailable AND openAvailability>0; drops windows without UTC range', () => {
    const w = normalizeCapacity(JSON.parse(fixture));
    expect(w).toHaveLength(3);
    expect(w.map((x) => x.open)).toEqual([true, false, true]);
  });

  it('can only remove slots: start must sit inside an OPEN window (end exclusive)', () => {
    const w = normalizeCapacity(JSON.parse(fixture));
    expect(slotAllowedByWindows(w, T('2026-11-19T13:00:00Z'))).toBe(true);
    expect(slotAllowedByWindows(w, T('2026-11-19T16:59:59Z'))).toBe(true);
    expect(slotAllowedByWindows(w, T('2026-11-19T17:00:00Z'))).toBe(false); // next window is full
    expect(slotAllowedByWindows(w, T('2026-11-19T05:00:00Z'))).toBe(false); // outside any window
    expect(slotAllowedByWindows(w, T('2026-11-20T18:00:00Z'))).toBe(false); // window w/o UTC range was dropped
  });

  it('chunks long ranges into <=7-day calls', async () => {
    const s = stub(tokenOr(() => ok('{"availabilities":[]}')));
    await fetchServiceTitanCapacity(CFG, { fromMs: T('2026-11-01T00:00:00Z'), toMs: T('2026-11-16T00:00:00Z') }, { fetchImpl: s.fetchImpl, sleep });
    expect(s.calls.filter((c) => c.url.includes('/capacity'))).toHaveLength(3);
  });

  it('refreshes the token once on 401 then succeeds', async () => {
    let n = 0;
    const s = stub((url) => (url.includes('/connect/token') ? ok(`{"access_token":"t${++n}","expires_in":900}`) : n === 1 ? ok('{}', 401) : ok(fixture)));
    const w = await fetchServiceTitanCapacity(CFG, { fromMs: T('2026-11-19T00:00:00Z'), toMs: T('2026-11-20T00:00:00Z') }, { fetchImpl: s.fetchImpl, sleep });
    expect(w).toHaveLength(3);
    expect(n).toBe(2);
  });

  it.each([
    [() => ok('{}', 401), 'auth'], [() => ok('{}', 403), 'auth'], [() => ok('{}', 429), 'throttled'],
    [() => ok('{}', 500), 'http'], [() => ok('not json'), 'malformed'], [() => ok('{"foo":1}'), 'malformed'],
  ] as const)('fails closed with a typed error (%#)', async (cap, code) => {
    const s = stub(tokenOr(cap));
    await expect(fetchServiceTitanCapacity(CFG, { fromMs: T('2026-11-19T00:00:00Z'), toMs: T('2026-11-20T00:00:00Z') }, { fetchImpl: s.fetchImpl, sleep }))
      .rejects.toMatchObject({ code });
  });

  it('maps network failure to timeout and rejects incomplete config without any request', async () => {
    const s = stub(() => { throw new Error('boom'); });
    await expect(fetchServiceTitanCapacity(CFG, { fromMs: 0, toMs: 1000 }, { fetchImpl: s.fetchImpl, sleep })).rejects.toMatchObject({ code: 'timeout' });
    const s2 = stub(() => ok('{}'));
    await expect(fetchServiceTitanCapacity({ ...CFG, st_business_unit_id: '' }, { fromMs: 0, toMs: 1000 }, { fetchImpl: s2.fetchImpl })).rejects.toBeInstanceOf(FsmAvailabilityError);
    expect(s2.calls).toHaveLength(0);
  });

  it('never leaks the client secret in errors', async () => {
    const s = stub(() => ok('{"error":"invalid_client"}', 401));
    const err = await fetchServiceTitanCapacity(CFG, { fromMs: 0, toMs: 1000 }, { fetchImpl: s.fetchImpl, sleep }).catch((e) => e as Error);
    expect(String(err.message)).not.toContain('sec');
  });
});

describe('FSM gate', () => {
  const range = { fromMs: T('2026-11-19T13:00:00Z'), toMs: T('2026-11-19T18:00:00Z') };
  const windows = normalizeCapacity(JSON.parse(fixture));

  it('does not gate tenants without ServiceTitan job write-back', async () => {
    const fetchCapacity = vi.fn();
    const g = await resolveFsmGate({ loadServiceTitanConfig: async () => null, fetchCapacity }, 'u1', range);
    expect(g.provider).toBeNull();
    expect(g.allows(1)).toBe(true);
    expect(fetchCapacity).not.toHaveBeenCalled();
  });

  it('gates with ServiceTitan windows, caches for 60s and shares concurrent reads', async () => {
    let now = 1_000_000;
    const fetchCapacity = vi.fn(async () => windows);
    const deps = { loadServiceTitanConfig: async () => CFG, fetchCapacity, now: () => now };
    const [a, b] = await Promise.all([resolveFsmGate(deps, 'u1', range), resolveFsmGate(deps, 'u1', range)]);
    expect(fetchCapacity).toHaveBeenCalledTimes(1);
    expect(a.allows(T('2026-11-19T14:00:00Z'))).toBe(true);
    expect(b.allows(T('2026-11-19T18:00:00Z'))).toBe(false);
    now += 59_000; await resolveFsmGate(deps, 'u1', range);
    expect(fetchCapacity).toHaveBeenCalledTimes(1);
    now += 2_000; await resolveFsmGate(deps, 'u1', range);
    expect(fetchCapacity).toHaveBeenCalledTimes(2);
  });

  it('isolates tenants and never caches failures', async () => {
    const fetchCapacity = vi.fn().mockRejectedValueOnce(new FsmAvailabilityError('http', '500')).mockResolvedValue(windows);
    const deps = { loadServiceTitanConfig: async () => CFG, fetchCapacity };
    await expect(resolveFsmGate(deps, 'u1', range)).rejects.toMatchObject({ code: 'http' });
    await resolveFsmGate(deps, 'u1', range);
    await resolveFsmGate(deps, 'u2', range);
    expect(fetchCapacity).toHaveBeenCalledTimes(3);
  });
});
