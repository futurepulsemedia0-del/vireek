// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorBody,
  parseBefore,
  parseLimit,
  resolveRoute,
  sandboxResponse,
} from '../../../supabase/functions/api-v1/contract';
import { Vireek, VireekError } from '../src/index';

let server: Server;
let base = '';
const seen: string[] = [];
let failNext: { status: number; headers?: Record<string, string>; count: number } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    seen.push(url.pathname + url.search);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer vrk_test_sdk')
      return send(401, errorBody('invalid_api_key', 'Invalid or revoked API key', 'rid-1'));
    if (failNext && failNext.count > 0) {
      failNext.count--;
      return send(
        failNext.status,
        errorBody(
          failNext.status === 429 ? 'rate_limited' : 'internal_error',
          'try later',
          'rid-2',
        ),
        failNext.headers,
      );
    }
    const route = resolveRoute(url.pathname);
    if (route.kind !== 'ok') return send(404, errorBody('route_not_found', 'nope', 'rid-3'));
    const before = parseBefore(url.searchParams.get('before'));
    const body = sandboxResponse(
      route.resource,
      route.id,
      parseLimit(url.searchParams.get('limit')),
      before.ok ? before.value : null,
    );
    return body === null
      ? send(404, errorBody('record_not_found', 'not found', 'rid-4'))
      : send(200, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api-v1`;
});
afterAll(() => server.close());

const client = (over = {}) => new Vireek({ apiKey: 'vrk_test_sdk', baseUrl: base, ...over });

describe('@vireek/sdk against the contract-derived server', () => {
  it('lists, gets and sends the key as a bearer token', async () => {
    const page = await client().calls.list({ limit: 2 });
    expect(page.data).toHaveLength(2);
    const one = await client().calls.get(page.data[1].id);
    expect(one.id).toBe(page.data[1].id);
    expect(seen.at(-2)).toBe('/api-v1/calls?limit=2');
  });

  it('iterate() follows next_before through every page exactly once', async () => {
    const ids: string[] = [];
    for await (const j of client().jobs.iterate({ limit: 7 })) ids.push(j.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('throws VireekError with code, docUrl and requestId, and does not retry 4xx', async () => {
    const before = seen.length;
    const err = await client()
      .leads.get('3f2b8c1e-7a4d-4e0b-9c5a-1d2e3f4a5b6c')
      .catch((e) => e);
    expect(err).toBeInstanceOf(VireekError);
    expect(err).toMatchObject({ status: 404, code: 'record_not_found', requestId: 'rid-4' });
    expect(err.docUrl).toContain('#error-record_not_found');
    expect(seen.length - before).toBe(1);
    const bad = await client({ apiKey: 'vrk_test_wrong' })
      .calls.list()
      .catch((e) => e);
    expect(bad).toMatchObject({ status: 401, code: 'invalid_api_key' });
  });

  it('retries 429 (honouring Retry-After) and 5xx, then succeeds', async () => {
    failNext = { status: 429, headers: { 'Retry-After': '1' }, count: 1 };
    const t0 = Date.now();
    expect((await client().calls.list({ limit: 1 })).data).toHaveLength(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    failNext = { status: 500, count: 2 };
    expect((await client().calls.list({ limit: 1 })).data).toHaveLength(1);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    failNext = { status: 500, count: 10 };
    const err = await client({ maxRetries: 1 })
      .calls.list()
      .catch((e) => e);
    expect(err).toMatchObject({ status: 500, code: 'internal_error' });
    failNext = null;
  });

  it('validates required options', () => {
    expect(() => new Vireek({ apiKey: '', baseUrl: base })).toThrow(/apiKey/);
    expect(() => new Vireek({ apiKey: 'k', baseUrl: '' })).toThrow(/baseUrl/);
  });
});
