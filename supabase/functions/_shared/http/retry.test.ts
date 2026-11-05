import { describe, expect, it } from 'vitest';
import { backoffMs, fetchWithRetry, graphqlWithRetry, retryAfterMs, throttleWaitMs } from './retry';

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function harness(responses: Array<Response | Error>) {
  const sleeps: number[] = [];
  let i = 0;
  return {
    sleeps,
    calls: () => i,
    deps: {
      fetchImpl: (async () => {
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r;
      }) as typeof fetch,
      sleep: async (ms: number) => void sleeps.push(ms),
      now: () => 1_000_000,
      random: () => 0.5,
    },
  };
}

describe('retryAfterMs / backoffMs', () => {
  it('parses seconds and HTTP dates', () => {
    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(retryAfterMs('nonsense', 0)).toBeNull();
    expect(retryAfterMs(null, 0)).toBeNull();
  });
  it('caps exponential backoff and applies jitter', () => {
    expect(backoffMs(0, 500, 20000, () => 0.5)).toBe(250);
    expect(backoffMs(10, 500, 1000, () => 0.999)).toBe(999);
  });
});

describe('fetchWithRetry', () => {
  it('retries 429 honoring Retry-After, for writes too', async () => {
    const h = harness([res(429, {}, { 'Retry-After': '2' }), res(200, { ok: 1 })]);
    const r = await fetchWithRetry('https://x', { method: 'POST' }, {}, h.deps);
    expect(r.status).toBe(200);
    expect(h.sleeps).toEqual([2000]);
  });
  it('does NOT retry a 500 on a write (could double-apply)', async () => {
    const h = harness([res(500)]);
    const r = await fetchWithRetry('https://x', { method: 'POST' }, {}, h.deps);
    expect(r.status).toBe(500);
    expect(h.calls()).toBe(1);
  });
  it('retries a 502 on a read and on idempotent POSTs', async () => {
    const h1 = harness([res(502), res(200)]);
    expect((await fetchWithRetry('https://x', {}, {}, h1.deps)).status).toBe(200);
    const h2 = harness([res(502), res(200)]);
    expect((await fetchWithRetry('https://x', { method: 'POST' }, { idempotent: true }, h2.deps)).status).toBe(200);
  });
  it('never retries other 4xx', async () => {
    const h = harness([res(404)]);
    expect((await fetchWithRetry('https://x', {}, {}, h.deps)).status).toBe(404);
    expect(h.calls()).toBe(1);
  });
  it('retries network errors on reads, rethrows on writes, and stops at maxAttempts', async () => {
    const h = harness([new Error('net'), res(200)]);
    expect((await fetchWithRetry('https://x', {}, {}, h.deps)).status).toBe(200);
    const w = harness([new Error('net')]);
    await expect(fetchWithRetry('https://x', { method: 'POST' }, {}, w.deps)).rejects.toThrow('net');
    const e = harness([res(503), res(503), res(503)]);
    const out = await fetchWithRetry('https://x', {}, { maxAttempts: 3 }, e.deps);
    expect(out.status).toBe(503);
    expect(e.calls()).toBe(3);
  });
});

describe('graphqlWithRetry (Jobber THROTTLED)', () => {
  const throttled = {
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    extensions: { cost: { requestedQueryCost: 1000, throttleStatus: { currentlyAvailable: 500, restoreRate: 500 } } },
  };
  it('waits for budget refill then succeeds', async () => {
    const h = harness([res(200, throttled), res(200, { data: { ok: true } })]);
    const body = await graphqlWithRetry({ url: 'https://x', headers: {}, query: 'q' }, {}, h.deps);
    expect(body.data).toEqual({ ok: true });
    expect(h.sleeps).toEqual([1000]);
  });
  it('gives up with graphql_throttled', async () => {
    const h = harness([res(200, throttled), res(200, throttled)]);
    await expect(graphqlWithRetry({ url: 'https://x', headers: {}, query: 'q' }, { maxAttempts: 2 }, h.deps)).rejects.toThrow('graphql_throttled');
  });
  it('returns non-throttle GraphQL errors to the caller untouched', async () => {
    const h = harness([res(200, { errors: [{ message: 'bad field' }] })]);
    const body = await graphqlWithRetry({ url: 'https://x', headers: {}, query: 'q' }, {}, h.deps);
    expect(body.errors?.[0].message).toBe('bad field');
  });
  it('throttleWaitMs is null when cost info is absent', () => {
    expect(throttleWaitMs({ errors: [] })).toBeNull();
  });
});
