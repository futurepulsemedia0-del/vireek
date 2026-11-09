// @vitest-environment node
// Mocked-network tests only. globalThis.fetch is replaced with a thrower so any accidental real
// request fails the test. All hosts below use the reserved .test TLD and are never contacted.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RDAP_STATUS,
  createRateLimiter,
  createRdapClient,
  lookupDomains,
  parseBootstrap,
  parseRetryAfter,
} from './rdap.mjs';

const BOOTSTRAP = {
  services: [
    [['com'], ['https://rdap.com.test/']],
    [['ai'], ['https://rdap.ai.test/rdap']],
    [['io'], ['http://insecure.io.test/']],
    [['co'], ['https://rdap.co.test/', 'https://backup.co.test/']],
  ],
};

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('real network is blocked in tests');
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const res = (status, body = '', headers = {}, url) => ({
  status,
  url,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  body: { cancel: async () => {} },
});
const domainBody = (d) => ({ objectClassName: 'domain', ldhName: d });

/** routes: { url: [response | Error | fn, ...] } (last item repeats). */
function harness(routes, opts = {}) {
  const calls = [];
  const sleeps = [];
  let t = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const list = routes[url];
    if (!list) throw new Error(`unrouted URL in test: ${url}`);
    const item = list.length > 1 ? list.shift() : list[0];
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item() : item;
  };
  const client = createRdapClient({
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    random: () => 1,
    minIntervalMs: 0,
    ...opts,
  });
  return { client, calls, sleeps };
}
const BOOT = 'https://data.iana.org/rdap/dns.json';
const withBoot = (routes) => ({ [BOOT]: [res(200, BOOTSTRAP)], ...routes });

describe('parseBootstrap', () => {
  it('maps TLDs to https bases with trailing slash and drops http services', () => {
    const m = parseBootstrap(BOOTSTRAP);
    expect(m.get('com')).toEqual(['https://rdap.com.test/']);
    expect(m.get('ai')).toEqual(['https://rdap.ai.test/rdap/']);
    expect(m.get('co')).toHaveLength(2);
    expect(m.has('io')).toBe(false);
  });
  it('throws on a malformed document and skips malformed entries', () => {
    expect(() => parseBootstrap({})).toThrow('services');
    expect(parseBootstrap({ services: [null, [['x']], [['za'], ['not a url']]] }).size).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and dates, caps, and rejects junk', () => {
    expect(parseRetryAfter('2', 0, 15000)).toBe(2000);
    expect(parseRetryAfter('999', 0, 15000)).toBe(15000);
    expect(parseRetryAfter(new Date(5000).toUTCString(), 1000, 15000)).toBe(4000);
    expect(parseRetryAfter('soon', 0, 15000)).toBeNull();
    expect(parseRetryAfter(null, 0, 15000)).toBeNull();
  });
});

describe('createRateLimiter', () => {
  it('spaces requests per host and does not delay other hosts', async () => {
    let t = 0;
    const sleeps = [];
    const rl = createRateLimiter({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await rl.wait('a');
    await rl.wait('a');
    await rl.wait('a');
    await rl.wait('b');
    expect(sleeps).toEqual([1000, 1000]);
  });
});

describe('lookup classification', () => {
  it('maps HTTP 200 domain objects to "registered"', async () => {
    const { client, calls } = harness(withBoot({ 'https://rdap.com.test/domain/vireek.com': [res(200, domainBody('VIREEK.COM'))] }));
    const r = await client.lookup('vireek', 'com');
    expect(r.status).toBe('registered');
    expect(r.source).toBe('rdap.com.test');
    expect(calls[1].init.headers.accept).toContain('rdap+json');
    expect(calls[1].init.headers['user-agent']).toContain('vireek-naming-screen');
  });

  it('maps HTTP 404 to the UNVERIFIED no-record wording and nothing else', async () => {
    const { client } = harness(withBoot({ 'https://rdap.ai.test/rdap/domain/vireek.ai': [res(404)] }));
    const r = await client.lookup('vireek', 'ai');
    expect(r.status).toBe('no RDAP record found (UNVERIFIED, confirm at a registrar)');
    expect(r.status).toBe(RDAP_STATUS.NO_RECORD);
  });

  it('only ever produces the three allowed statuses', () => {
    expect(Object.values(RDAP_STATUS)).toEqual([
      'registered',
      'no RDAP record found (UNVERIFIED, confirm at a registrar)',
      'lookup error',
    ]);
    for (const s of Object.values(RDAP_STATUS)) expect(s).not.toMatch(/availab|\bfree/i);
  });

  it('does not retry other 4xx responses', async () => {
    const { client, sleeps } = harness(withBoot({ 'https://rdap.com.test/domain/vireek.com': [res(403)] }));
    const r = await client.lookup('vireek', 'com');
    expect(r).toMatchObject({ status: 'lookup error', detail: 'HTTP 403', attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it('rejects unexpected payloads, bad JSON and mismatched names', async () => {
    const url = 'https://rdap.com.test/domain/vireek.com';
    for (const body of [{ objectClassName: 'nameserver' }, domainBody('other.com'), '<html>', '{"x":']) {
      const { client } = harness(withBoot({ [url]: [res(200, body)] }));
      expect((await client.lookup('vireek', 'com')).status).toBe('lookup error');
    }
  });

  it('refuses an insecure redirect target', async () => {
    const { client } = harness(withBoot({ 'https://rdap.com.test/domain/vireek.com': [res(200, domainBody('vireek.com'), {}, 'http://evil.test/x')] }));
    expect((await client.lookup('vireek', 'com')).detail).toContain('insecure');
  });

  it('errors for TLDs missing from the bootstrap or listed over http only', async () => {
    const { client, calls } = harness(withBoot({}));
    const r = await client.lookup('vireek', 'io');
    expect(r.status).toBe('lookup error');
    expect(r.detail).toContain('no RDAP service for .io');
    expect(calls).toHaveLength(1);
  });

  it('rejects unsafe labels without any request', async () => {
    const { client, calls } = harness({});
    expect((await client.lookup('a/../b', 'com')).detail).toContain('invalid');
    expect((await client.lookup('vireek', 'c0m')).status).toBe('lookup error');
    expect(calls).toHaveLength(0);
  });
});

describe('retry, backoff and timeouts', () => {
  const url = 'https://rdap.com.test/domain/vireek.com';

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const { client, sleeps } = harness(withBoot({ [url]: [res(429, '', { 'retry-after': '2' }), res(200, domainBody('vireek.com'))] }));
    const r = await client.lookup('vireek', 'com');
    expect(r.status).toBe('registered');
    expect(r.attempts).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('backs off exponentially on 5xx and ends in "lookup error"', async () => {
    const { client, sleeps } = harness(withBoot({ [url]: [res(503)] }), { retries: 2, backoffBaseMs: 500 });
    const r = await client.lookup('vireek', 'com');
    expect(r).toMatchObject({ status: 'lookup error', detail: 'HTTP 503', attempts: 3 });
    expect(sleeps).toEqual([500, 1000]);
  });

  it('caps backoff', async () => {
    const { sleeps, client } = harness(withBoot({ [url]: [res(500)] }), { retries: 3, backoffBaseMs: 10000, maxBackoffMs: 12000 });
    await client.lookup('vireek', 'com');
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(12000);
  });

  it('reports network failures and timeouts as lookup errors', async () => {
    const net = harness(withBoot({ [url]: [new Error('ECONNRESET')] }), { retries: 1 });
    const a = await net.client.lookup('vireek', 'com');
    expect(a.status).toBe('lookup error');
    expect(a.detail).toContain('network error: ECONNRESET');
    expect(a.attempts).toBe(2);

    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const to = harness(withBoot({ [url]: [timeout] }), { retries: 0 });
    expect((await to.client.lookup('vireek', 'com')).detail).toBe('timeout');
  });

  it('passes an abort signal for the timeout', async () => {
    const { client, calls } = harness(withBoot({ [url]: [res(404)] }));
    await client.lookup('vireek', 'com');
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('bootstrap handling', () => {
  it('fetches the bootstrap once and reuses it', async () => {
    const { client, calls } = harness(withBoot({ 'https://rdap.com.test/domain/a-b.com': [res(404)], 'https://rdap.com.test/domain/c-d.com': [res(404)] }));
    await client.lookup('a-b', 'com');
    await client.lookup('c-d', 'com');
    expect(calls.filter((c) => c.url === BOOT)).toHaveLength(1);
  });

  it('turns a failed bootstrap into lookup errors without retrying forever', async () => {
    const { client, calls } = harness({ [BOOT]: [res(500)] }, { retries: 1 });
    const out = await lookupDomains(client, 'vireek', ['com', 'ai']);
    expect(out.map((o) => o.status)).toEqual(['lookup error', 'lookup error']);
    expect(out[0].detail).toContain('bootstrap fetch failed');
    expect(calls).toHaveLength(2);
  });

  it('spaces requests to the same RDAP host', async () => {
    const { client, sleeps } = harness(
      withBoot({
        'https://rdap.com.test/domain/vireek.com': [res(404)],
        'https://rdap.com.test/domain/lumen.com': [res(404)],
      }),
      { minIntervalMs: 1000 },
    );
    await client.lookup('vireek', 'com');
    await client.lookup('lumen', 'com');
    expect(sleeps.filter((s) => s > 0).length).toBeGreaterThanOrEqual(1);
  });
});
