// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ApiClient, paginate, parseRetryAfter, type Page } from '../src/http.js';
import { BASE, KEY, jsonResponse, makeRows } from './helpers.js';

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  const sleeps: number[] = [];
  const api = new ApiClient({
    baseUrl: BASE,
    apiKey: KEY,
    fetchImpl,
    random: () => 1,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { api, sleeps };
}

describe('ApiClient', () => {
  it('sends the bearer key, user agent and query, skipping empty params', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const { api } = client((async (url: URL, init: RequestInit) => {
      seen = { url: url.toString(), headers: new Headers(init.headers) };
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch, { userAgent: 'vireek-cli/test' });
    await api.get('/calls', { limit: 5, before: undefined, empty: '' });
    expect(seen?.url).toBe(`${BASE}/calls?limit=5`);
    expect(seen?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(seen?.headers.get('user-agent')).toBe('vireek-cli/test');
  });

  it('retries 503 with exponential backoff, then succeeds', async () => {
    let calls = 0;
    const { api, sleeps } = client((async () => (++calls < 3 ? jsonResponse({ error: 'down' }, 503) : jsonResponse({ ok: 1 }))) as typeof fetch);
    expect(await api.get('/calls')).toEqual({ ok: 1 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('honours Retry-After on 429', async () => {
    let calls = 0;
    const { api, sleeps } = client((async () => (++calls === 1 ? jsonResponse({ error: 'Rate limit' }, 429, { 'Retry-After': '60' }) : jsonResponse({ ok: 1 }))) as typeof fetch);
    await api.get('/calls');
    expect(sleeps).toEqual([60_000]);
  });

  it('gives up after maxRetries and surfaces the API message', async () => {
    const { api } = client((async () => jsonResponse({ error: 'Query failed' }, 500)) as typeof fetch, { maxRetries: 1 });
    await expect(api.get('/calls')).rejects.toMatchObject({ status: 500, message: 'API error: Query failed' });
  });

  it('maps 401/403 to the auth exit code without retrying', async () => {
    let calls = 0;
    const { api } = client((async () => (calls++, jsonResponse({ error: 'Invalid or revoked API key' }, 401))) as typeof fetch);
    await expect(api.get('/calls')).rejects.toMatchObject({ status: 401, exitCode: 3 });
    expect(calls).toBe(1);
    const forbidden = client((async () => jsonResponse({ error: 'This key is missing the required scope: jobs:read' }, 403)) as typeof fetch);
    await expect(forbidden.api.get('/jobs')).rejects.toMatchObject({ status: 403, exitCode: 3 });
  });

  it('retries network failures and explains them when they persist', async () => {
    const { api } = client((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch, { maxRetries: 1 });
    await expect(api.get('/calls')).rejects.toThrow(/Cannot reach the Vireek API/);
  });

  it('flags non-JSON responses (wrong base URL)', async () => {
    const { api } = client((async () => new Response('<html>', { status: 200 })) as typeof fetch);
    await expect(api.get('/calls')).rejects.toThrow(/non-JSON/);
  });

  it('refuses paths that escape the API prefix', () => {
    const { api } = client((async () => jsonResponse({})) as typeof fetch);
    expect(() => api.buildUrl('/../../auth/v1/admin')).toThrow(/outside the API/);
    expect(api.buildUrl('calls/abc').pathname).toBe('/functions/v1/api-v1/calls/abc');
  });

  it('stops immediately when interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { api } = client((async () => jsonResponse({})) as typeof fetch, { signal: controller.signal });
    await expect(api.get('/calls')).rejects.toMatchObject({ exitCode: 130 });
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates, caps at two minutes, ignores junk', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('9999')).toBe(120_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(parseRetryAfter('Mon, 26 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
  });
});

/** A fake api-v1 list endpoint that honours `limit` and `before` like the real function. */
function listApi(all: ReturnType<typeof makeRows>) {
  const requests: string[] = [];
  const fetchImpl = (async (url: URL) => {
    requests.push(url.search);
    const limit = Number(url.searchParams.get('limit'));
    const before = url.searchParams.get('before');
    const rows = all.filter((r) => !before || r.created_at < before).slice(0, limit);
    const page: Page = { data: rows, has_more: rows.length === limit, next_before: rows.at(-1)?.created_at ?? null };
    return jsonResponse(page);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

async function collect(gen: AsyncGenerator<Record<string, unknown>[]>) {
  const out: Record<string, unknown>[][] = [];
  for await (const page of gen) out.push(page);
  return out;
}

describe('paginate', () => {
  it('walks every page via the before cursor', async () => {
    const { fetchImpl, requests } = listApi(makeRows(250));
    const pages = await collect(paginate(client(fetchImpl).api, 'calls', { pageSize: 100 }));
    expect(pages.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(requests).toHaveLength(3);
  });

  it('respects max across pages', async () => {
    const { fetchImpl } = listApi(makeRows(250));
    const pages = await collect(paginate(client(fetchImpl).api, 'calls', { pageSize: 100, max: 120 }));
    expect(pages.flat()).toHaveLength(120);
  });

  it('stops at --since without fetching older pages', async () => {
    const { fetchImpl, requests } = listApi(makeRows(250));
    const since = makeRows(250)[149]?.created_at as string; // keep rows 0..149
    const pages = await collect(paginate(client(fetchImpl).api, 'calls', { pageSize: 100, since }));
    expect(pages.flat()).toHaveLength(150);
    expect(requests).toHaveLength(2);
  });

  it('starts from the supplied before cursor', async () => {
    const rows = makeRows(10);
    const { fetchImpl } = listApi(rows);
    const pages = await collect(paginate(client(fetchImpl).api, 'calls', { before: rows[4]?.created_at }));
    expect(pages.flat().map((r) => r.id)).toEqual(rows.slice(5).map((r) => r.id));
  });

  it('de-duplicates repeated ids and never loops on a stuck cursor', async () => {
    const rows = makeRows(3);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ data: rows, has_more: true, next_before: rows[2]?.created_at });
    }) as unknown as typeof fetch;
    const pages = await collect(paginate(client(fetchImpl).api, 'calls', { pageSize: 3 }));
    expect(pages.flat()).toHaveLength(3);
    expect(calls).toBe(2);
  });

  it('rejects malformed list responses', async () => {
    const fetchImpl = (async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    await expect(collect(paginate(client(fetchImpl).api, 'calls'))).rejects.toThrow(/unexpected list shape/);
  });
});
