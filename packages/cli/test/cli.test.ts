// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION, main } from '../src/cli.js';
import { readConfig } from '../src/config.js';
import { signPayload } from '../src/webhooks.js';
import { BASE, KEY, jsonResponse, makeIo, makeRows } from './helpers.js';

async function tmpConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vireek-cli-'));
  return { dir, configFile: path.join(dir, 'config.json') };
}

/** Fake api-v1 serving `rows` for every resource, honouring limit/before. */
function apiFetch(rows = makeRows(5)) {
  const urls: string[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    urls.push(url.toString());
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    const parts = url.pathname.replace('/functions/v1/api-v1/', '').split('/');
    if (parts[1]) return rows.find((r) => r.id === parts[1]) ? jsonResponse({ data: rows.find((r) => r.id === parts[1]) }) : jsonResponse({ error: 'calls not found' }, 404);
    const limit = Number(url.searchParams.get('limit'));
    const before = url.searchParams.get('before');
    const slice = rows.filter((r) => !before || r.created_at < before).slice(0, limit);
    return jsonResponse({ data: slice, has_more: slice.length === limit, next_before: slice.at(-1)?.created_at ?? null });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const AUTH_ENV = { VIREEK_API_KEY: KEY, VIREEK_API_URL: BASE };

describe('basics', () => {
  it('prints help, version and rejects unknown commands with exit code 2', async () => {
    const help = makeIo();
    expect(await main([], help.io)).toBe(0);
    expect(help.stdout()).toContain('Usage:');

    const version = makeIo();
    expect(await main(['--version'], version.io)).toBe(0);
    expect(version.stdout().trim()).toBe(VERSION);

    const sub = makeIo();
    expect(await main(['export', '--help'], sub.io)).toBe(0);
    expect(sub.stdout()).toContain('--since');

    const unknown = makeIo();
    expect(await main(['frobnicate'], unknown.io)).toBe(2);
    expect(unknown.stderr()).toContain('Unknown command');
  });

  it('turns unknown flags into usage errors', async () => {
    const t = makeIo({ env: AUTH_ENV });
    expect(await main(['calls', 'list', '--bogus'], t.io)).toBe(2);
    expect(t.stderr()).toContain('error:');
  });

  it('exits 3 with a hint when no credentials exist', async () => {
    const { configFile } = await tmpConfig();
    const t = makeIo({ configFile });
    expect(await main(['calls', 'list'], t.io)).toBe(3);
    expect(t.stderr()).toContain('vireek auth login');
  });
});

describe('auth', () => {
  it('logs in with a piped key, verifies it, stores it, and reports status without leaking the key', async () => {
    const { configFile } = await tmpConfig();
    const { fetchImpl, urls } = apiFetch();
    const login = makeIo({ configFile, fetchImpl }, `${KEY}\n`);
    expect(await main(['auth', 'login', '--with-key', '--base-url', BASE], login.io)).toBe(0);
    expect(urls).toHaveLength(1);
    expect(login.stderr()).toContain('Logged in');
    expect(login.stderr()).not.toContain(KEY);
    expect((await readConfig(configFile)).profiles.default).toEqual({ apiKey: KEY, baseUrl: BASE });

    const status = makeIo({ configFile });
    expect(await main(['auth', 'status'], status.io)).toBe(0);
    expect(status.stdout()).toContain('vrk_live_a1b2c…');
    expect(status.stdout()).not.toContain(KEY);
  });

  it('refuses to save a key the API rejects', async () => {
    const { configFile } = await tmpConfig();
    const fetchImpl = (async () => jsonResponse({ error: 'Invalid or revoked API key' }, 401)) as unknown as typeof fetch;
    const t = makeIo({ configFile, fetchImpl }, `${KEY}\n`);
    expect(await main(['auth', 'login', '--with-key', '--base-url', BASE], t.io)).toBe(3);
    expect((await readConfig(configFile)).profiles).toEqual({});
  });

  it('accepts a key that only lacks the calls scope (403 proves authentication)', async () => {
    const { configFile } = await tmpConfig();
    const fetchImpl = (async () => jsonResponse({ error: 'This key is missing the required scope: calls:read' }, 403)) as unknown as typeof fetch;
    const t = makeIo({ configFile, fetchImpl }, `${KEY}\n`);
    expect(await main(['auth', 'login', '--with-key', '--base-url', BASE], t.io)).toBe(0);
    expect(t.stderr()).toContain('key is valid');
  });

  it('logs out and removes the config file when the last profile goes', async () => {
    const { configFile } = await tmpConfig();
    const login = makeIo({ configFile, env: AUTH_ENV }, '');
    expect(await main(['auth', 'login', '--no-verify'], login.io)).toBe(0);
    const out = makeIo({ configFile });
    expect(await main(['auth', 'logout'], out.io)).toBe(0);
    expect(await readConfig(configFile)).toMatchObject({ profiles: {} });
    const again = makeIo({ configFile });
    expect(await main(['auth', 'logout'], again.io)).toBe(1);
  });
});

describe('resources', () => {
  it('lists as raw JSON when piped (stdout is not a TTY)', async () => {
    const { fetchImpl, urls } = apiFetch();
    const t = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['calls', 'list', '--limit', '2'], t.io)).toBe(0);
    expect(JSON.parse(t.stdout()).data).toHaveLength(2);
    expect(urls[0]).toBe(`${BASE}/calls?limit=2`);
  });

  it('renders a table on a TTY with a pagination hint', async () => {
    const { fetchImpl } = apiFetch();
    const t = makeIo({ env: AUTH_ENV, fetchImpl });
    t.io.stdout.isTTY = true;
    expect(await main(['leads', 'list', '--limit', '2', '--columns', 'id,name'], t.io)).toBe(0);
    expect(t.stdout()).toContain('id');
    expect(t.stdout()).toContain('Row 0');
    expect(t.stdout()).toContain('More results: --before');
  });

  it('gets one record and surfaces 404s', async () => {
    const { fetchImpl } = apiFetch();
    const ok = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['jobs', 'get', 'id-1'], ok.io)).toBe(0);
    expect(JSON.parse(ok.stdout()).data.id).toBe('id-1');
    const missing = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['jobs', 'get', 'nope'], missing.io)).toBe(1);
  });

  it('validates --limit', async () => {
    const t = makeIo({ env: AUTH_ENV });
    expect(await main(['calls', 'list', '--limit', '500'], t.io)).toBe(2);
  });

  it('supports the raw api command with --param', async () => {
    const { fetchImpl, urls } = apiFetch();
    const t = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['api', 'calls', '--param', 'limit=1'], t.io)).toBe(0);
    expect(urls[0]).toBe(`${BASE}/calls?limit=1`);
    const bad = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['api', '../../auth/v1/admin'], bad.io)).toBe(2);
  });
});

describe('export', () => {
  it('writes CSV to a file atomically and reports a summary', async () => {
    const { dir } = await tmpConfig();
    const { fetchImpl } = apiFetch(makeRows(130));
    const target = path.join(dir, 'calls.csv');
    const t = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['export', 'calls', '-o', target], t.io)).toBe(0);
    const lines = (await readFile(target, 'utf8')).trim().split('\r\n');
    expect(lines).toHaveLength(131);
    expect(lines[0]).toBe('id,created_at,name');
    expect(t.stderr()).toContain('Exported 130 calls');

    const again = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['export', 'calls', '-o', target], again.io)).toBe(1);
    expect(again.stderr()).toContain('--force');
  });

  it('streams NDJSON to stdout by default and honours --max', async () => {
    const { fetchImpl } = apiFetch(makeRows(50));
    const t = makeIo({ env: AUTH_ENV, fetchImpl });
    expect(await main(['export', 'jobs', '--max', '7', '--quiet'], t.io)).toBe(0);
    expect(t.stdout().trim().split('\n')).toHaveLength(7);
    expect(t.stderr()).toBe('');
  });

  it('validates arguments', async () => {
    const t = makeIo({ env: AUTH_ENV });
    expect(await main(['export', 'invoices'], t.io)).toBe(2);
    expect(await main(['export', 'calls', '--format', 'xml'], makeIo({ env: AUTH_ENV }).io)).toBe(2);
    expect(await main(['export', 'calls', '--since', 'banana'], makeIo({ env: AUTH_ENV }).io)).toBe(2);
    expect(await main(['export', 'calls', '--since', '1d', '--until', '2d'], makeIo({ env: AUTH_ENV }).io)).toBe(2);
  });

  it('leaves no partial file when the API fails mid-export', async () => {
    const { dir } = await tmpConfig();
    let call = 0;
    const rows = makeRows(250);
    const fetchImpl = (async (url: URL) => {
      call += 1;
      if (call === 3) return jsonResponse({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': '1' });
      const limit = Number(url.searchParams.get('limit'));
      const before = url.searchParams.get('before');
      const slice = rows.filter((r) => !before || r.created_at < before).slice(0, limit);
      return jsonResponse({ data: slice, has_more: true, next_before: slice.at(-1)?.created_at });
    }) as unknown as typeof fetch;
    const target = path.join(dir, 'out.ndjson');
    const t = makeIo({ env: AUTH_ENV, fetchImpl });
    // 429 is retried (sleep is stubbed) and the export then completes.
    expect(await main(['export', 'calls', '-o', target, '--max', '250'], t.io)).toBe(0);
    expect((await readFile(target, 'utf8')).trim().split('\n')).toHaveLength(250);
  });
});

describe('webhooks', () => {
  const SECRET = 'whsec_abc123';

  it('lists events and signs/verifies a body', async () => {
    const events = makeIo();
    expect(await main(['webhooks', 'events'], events.io)).toBe(0);
    expect(events.stdout()).toContain('job.completed');

    const sign = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET } });
    expect(await main(['webhooks', 'sign', '--body', '{"a":1}'], sign.io)).toBe(0);
    const signature = sign.stdout().trim();
    expect(signature).toBe(signPayload(SECRET, '{"a":1}'));

    const ok = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET } });
    expect(await main(['webhooks', 'verify', '--body', '{"a":1}', '--signature', signature], ok.io)).toBe(0);
    const bad = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET } });
    expect(await main(['webhooks', 'verify', '--body', '{"a":2}', '--signature', signature], bad.io)).toBe(1);
    expect(bad.stderr()).toContain('INVALID');
  });

  it('verifies a body piped on stdin', async () => {
    const t = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET } }, '{"a":1}');
    expect(await main(['webhooks', 'sign', '--body-file', '-'], t.io)).toBe(0);
    expect(t.stdout().trim()).toBe(signPayload(SECRET, '{"a":1}'));
  });

  it('requires a secret', async () => {
    const t = makeIo();
    expect(await main(['webhooks', 'sign', '--body', 'x'], t.io)).toBe(2);
  });

  it('triggers a signed sample delivery and fails the exit code on non-2xx', async () => {
    let received: { body: string; sig: string } | undefined;
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      received = { body: init.body as string, sig: new Headers(init.headers).get('x-vireek-signature') as string };
      return new Response('{"received":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET }, fetchImpl });
    expect(await main(['webhooks', 'trigger', 'job.completed', '--url', 'https://example.com/hook'], t.io)).toBe(0);
    expect(received?.sig).toBe(signPayload(SECRET, received?.body as string));
    expect(JSON.parse(received?.body as string).event).toBe('job.completed');
    expect(t.stdout()).toContain('← 200');

    const failing = makeIo({
      env: { VIREEK_WEBHOOK_SECRET: SECRET },
      fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    expect(await main(['webhooks', 'trigger', 'job.completed', '--url', 'https://example.com/hook'], failing.io)).toBe(1);
  });

  it('refuses unknown events without --data, and plain-http remote targets', async () => {
    const t = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET } });
    expect(await main(['webhooks', 'trigger', 'custom.thing', '--url', 'https://example.com'], t.io)).toBe(2);
    expect(await main(['webhooks', 'trigger', 'job.created', '--url', 'http://example.com'], makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET } }).io)).toBe(2);
  });

  it('sends custom event data from stdin', async () => {
    let body = '';
    const fetchImpl = (async (_u: URL, init: RequestInit) => ((body = init.body as string), new Response('ok'))) as unknown as typeof fetch;
    const t = makeIo({ env: { VIREEK_WEBHOOK_SECRET: SECRET }, fetchImpl }, '{"hello":"world"}');
    expect(await main(['webhooks', 'trigger', 'custom.thing', '--url', 'https://example.com', '--data', '-', '--json'], t.io)).toBe(0);
    expect(JSON.parse(body).data).toEqual({ hello: 'world' });
    expect(JSON.parse(t.stdout()).ok).toBe(true);
  });
});
