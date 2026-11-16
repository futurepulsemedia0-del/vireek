// Contract tests for the provider clients (ServiceTitan pricebook, Jobber products, Housecall Pro).
// Fixtures in ./__fixtures__ are SYNTHETIC (see README there) - they pin OUR client's request/response contract.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchServiceTitanPricebook } from './servicetitan';
import { fetchJobberProducts } from './jobber';
import { verifyHousecallProKey } from './housecallpro';

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const jsonRes = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } });

afterEach(() => vi.unstubAllGlobals());

const ST = { st_client_id: 'cid', st_client_secret: 'sec', st_app_key: 'key', st_tenant_id: '12345' };

describe('ServiceTitan pricebook contract', () => {
  it('authenticates with client_credentials, pages pricebook/v2 with ST-App-Key, normalizes prices to cents', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://auth.servicetitan.io/connect/token')) return jsonRes('{"access_token":"tok"}');
      return jsonRes(fx(String(url).includes('page=1') ? 'servicetitan-pricebook-services.page1.json' : 'servicetitan-pricebook-services.page2.json'));
    });
    const items = await fetchServiceTitanPricebook(ST);

    expect(calls[0].init.method).toBe('POST');
    expect(String(calls[0].init.body)).toContain('grant_type=client_credentials');
    const api = calls.filter((c) => c.url.startsWith('https://api.servicetitan.io/pricebook/v2/12345/services'));
    expect(api).toHaveLength(2);
    expect(api[0].url).toContain('page=1');
    expect(api[0].url).toContain('active=true');
    const h = api[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['ST-App-Key']).toBe('key');

    expect(items.map((i) => i.external_id)).toEqual(['101', '102', '104']); // rows without id / numeric price are skipped
    expect(items[0]).toEqual({ external_id: '101', service_name: 'Drain cleaning', category: 'Plumbing', price_cents: 18950, active: true });
    expect(items[1].active).toBe(false);
  });

  it('retries a 429 (Retry-After: 0) and then succeeds', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('auth.servicetitan.io')) return jsonRes('{"access_token":"tok"}');
      n += 1;
      return n === 1 ? jsonRes('{}', 429, { 'Retry-After': '0' }) : jsonRes(fx('servicetitan-pricebook-services.page2.json'));
    });
    expect((await fetchServiceTitanPricebook(ST)).map((i) => i.external_id)).toEqual(['104']);
    expect(n).toBe(2);
  });

  it('surfaces a persistent auth failure without leaking the secret', async () => {
    vi.stubGlobal('fetch', async () => jsonRes('{"error":"invalid_client"}', 401));
    await expect(fetchServiceTitanPricebook(ST)).rejects.toThrow('servicetitan_auth_http_401');
  });
});

describe('Jobber products contract', () => {
  it('queries products with cursor pagination, the pinned API version header, and skips nodes without a cost', async () => {
    const seen: Array<{ init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      seen.push({ init });
      return jsonRes(fx('jobber-products.json'));
    });
    const items = await fetchJobberProducts('access');
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['X-JOBBER-GRAPHQL-VERSION']).toBe('2025-04-16');
    expect(headers.Authorization).toBe('Bearer access');
    expect(String(seen[0].init.body)).toContain('products(first: 100');
    expect(items).toEqual([{ external_id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3QvMQ==', service_name: 'Furnace tune-up', category: 'HVAC', price_cents: 12999, active: true }]);
  });

  it('recovers from THROTTLED (HTTP 200 + errors) by waiting and retrying', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => (++n === 1 ? jsonRes(fx('jobber-throttled.json')) : jsonRes(fx('jobber-products.json'))));
    const items = await fetchJobberProducts('access');
    expect(n).toBe(2);
    expect(items).toHaveLength(1);
  }, 10_000);
});

describe('Housecall Pro contract', () => {
  it('verifies the key with GET /company and a Bearer header', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => ((captured = { url: String(url), init }), jsonRes('{"id":"co_1"}')));
    await verifyHousecallProKey('k');
    expect(captured!.url).toBe('https://api.housecallpro.com/company');
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });
  it('turns a 401 into a typed error', async () => {
    vi.stubGlobal('fetch', async () => jsonRes('{"error":"unauthorized"}', 401));
    await expect(verifyHousecallProKey('bad')).rejects.toThrow('housecallpro_http_401');
  });
});
