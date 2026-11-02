import type { Page, Route } from '@playwright/test';

/**
 * Mocks Supabase (auth session, REST, edge functions) and leaves telephony fully simulated: no Vapi, no Twilio,
 * no real phone is ever contacted. Realtime sockets are not mocked on purpose: the pages must work on polling alone.
 */
export const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const REF = new URL(SUPABASE_URL).hostname.split('.')[0];
export const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, email: USER.email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

export async function signIn(page: Page) {
  const session = { access_token: jwt(), refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: USER.id, email: USER.email, aud: 'authenticated', app_metadata: {}, user_metadata: {} } };
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [`sb-${REF}-auth-token`, JSON.stringify(session)] as const);
}

export type Tables = Record<string, unknown[]>;
export interface MockOpts {
  tables: Tables;
  /** Return a Response-like override for a REST table, e.g. 500 to simulate an outage. */
  fail?: (table: string) => boolean;
  delayMs?: number;
  functions?: Record<string, (body: Record<string, unknown>, route: Route) => unknown>;
  counts?: Record<string, number>;
}
export const calls: { fn: string; body: Record<string, unknown> }[] = [];
export const restWrites: { method: string; table: string; body: string }[] = [];

export async function mockSupabase(page: Page, opts: MockOpts) {
  calls.length = 0;
  restWrites.length = 0;
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

    if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER.id, email: USER.email, aud: 'authenticated' });

    if (url.pathname.startsWith('/functions/v1/')) {
      const fn = url.pathname.split('/').pop()!;
      const body = (req.postDataJSON?.() ?? {}) as Record<string, unknown>;
      calls.push({ fn, body });
      const h = opts.functions?.[fn];
      if (!h) return json(404, { error: 'not_mocked' });
      const out = h(body, route) as { __status?: number } & Record<string, unknown>;
      return json(out?.__status ?? 200, out);
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (req.method() !== 'GET' && req.method() !== 'HEAD') {
        restWrites.push({ method: req.method(), table, body: req.postData() ?? '' });
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (opts.fail?.(table)) return json(500, { message: 'boom' });
      const rows = opts.tables[table] ?? [];
      const wantsObject = (req.headers()['accept'] ?? '').includes('pgrst.object');
      const total = opts.counts?.[table] ?? rows.length;
      const headers = { 'content-range': `0-${Math.max(0, rows.length - 1)}/${total}` };
      if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...headers } });
      if (wantsObject) return rows.length ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'no rows' });
      return json(200, rows, { 'access-control-expose-headers': 'content-range', ...headers });
    }
    return route.continue();
  });
}

export const PROFILE = { id: USER.id, email: USER.email, role: 'owner', full_name: 'Olivia Owner', company_name: '', onboarding_completed: false, invoice_currency: 'USD', phone: null, created_at: new Date(Date.now() - 120_000).toISOString() };
