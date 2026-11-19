// e2e/tenant-isolation.spec.ts
// Live check (PostgREST) that tenant A and guests cannot read or write tenant B's data and cannot tell it exists (T6).
// Needs a staging/local Supabase with TWO test accounts that belong to DIFFERENT tenants. NOT RUN in the authoring environment.
//   E2E_ISO_SUPABASE_URL (default VITE_SUPABASE_URL), E2E_ISO_ANON_KEY (default VITE_SUPABASE_ANON_KEY),
//   E2E_TENANT_A_EMAIL / E2E_TENANT_A_PASSWORD, E2E_TENANT_B_EMAIL / E2E_TENANT_B_PASSWORD
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const URL_BASE = (process.env.E2E_ISO_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const ANON = process.env.E2E_ISO_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';
const A = { email: process.env.E2E_TENANT_A_EMAIL, password: process.env.E2E_TENANT_A_PASSWORD };
const B = { email: process.env.E2E_TENANT_B_EMAIL, password: process.env.E2E_TENANT_B_PASSWORD };
const READY = Boolean(URL_BASE && ANON && A.email && A.password && B.email && B.password);

// Tables a guest must never be able to read. Extend it; the exhaustive proof is the generated pgTAP suite.
const GUEST_TABLES = ['customers', 'jobs', 'invoices', 'quotes', 'team_members', 'profiles', 'audit_log'];

type Session = { token: string; userId: string };

async function signIn(request: APIRequestContext, who: { email?: string; password?: string }): Promise<Session> {
  const res = await request.post(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    data: { email: who.email, password: who.password },
  });
  expect(res.status(), 'sign-in must succeed for the isolation fixtures').toBe(200);
  const body = await res.json();
  return { token: body.access_token as string, userId: body.user.id as string };
}

const headers = (token?: string) => ({
  apikey: ANON,
  Authorization: `Bearer ${token ?? ANON}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
});

test.describe('tenant isolation (live API)', () => {
  test.skip(!READY, 'E2E_ISO_* / E2E_TENANT_A_* / E2E_TENANT_B_* not set — skipping live isolation checks.');

  let a: Session;
  let b: Session;
  let bCustomerId: string;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    a = await signIn(request, A);
    b = await signIn(request, B);
    expect(a.userId, 'A and B must be different accounts').not.toBe(b.userId);
    // [VERIFY] minimal customers columns on your schema (name + user_id used by supabase/tests/database/commercial_approval_to_cash.test.sql)
    const res = await request.post(`${URL_BASE}/rest/v1/customers`, { headers: headers(b.token), data: { user_id: b.userId, name: 'iso-probe-b' } });
    expect(res.status(), `tenant B fixture insert failed: ${await res.text()}`).toBe(201);
    bCustomerId = (await res.json())[0].id;
    await request.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    if (!bCustomerId) return;
    const request = await playwright.request.newContext();
    await request.delete(`${URL_BASE}/rest/v1/customers?id=eq.${bCustomerId}`, { headers: headers(b.token) });
    await request.dispose();
  });

  for (const table of GUEST_TABLES) {
    test(`guest cannot read ${table}`, async ({ request }) => {
      const res = await request.get(`${URL_BASE}/rest/v1/${table}?select=*&limit=5`, { headers: headers() });
      if (res.status() === 200) expect(await res.json(), `${table} leaked rows to a guest`).toEqual([]);
      else expect([401, 403, 404]).toContain(res.status());
    });
  }

  test('guest sees nothing of tenant B and gets the same answer as for a row that does not exist', async ({ request }) => {
    const real = await request.get(`${URL_BASE}/rest/v1/customers?id=eq.${bCustomerId}&select=id`, { headers: headers() });
    const ghost = await request.get(`${URL_BASE}/rest/v1/customers?id=eq.${randomUUID()}&select=id`, { headers: headers() });
    expect(real.status()).toBe(ghost.status());
    expect(await real.text()).toBe(await ghost.text());
  });

  test('tenant A cannot read tenant B’s row and cannot tell it exists', async ({ request }) => {
    const real = await request.get(`${URL_BASE}/rest/v1/customers?id=eq.${bCustomerId}&select=id`, { headers: headers(a.token) });
    const ghost = await request.get(`${URL_BASE}/rest/v1/customers?id=eq.${randomUUID()}&select=id`, { headers: headers(a.token) });
    expect(real.status()).toBe(200);
    expect(await real.json()).toEqual([]);
    expect(real.status()).toBe(ghost.status());
    expect(await real.text()).toBe(await ghost.text());
  });

  test('tenant A cannot update or delete tenant B’s row', async ({ request }) => {
    const patch = await request.patch(`${URL_BASE}/rest/v1/customers?id=eq.${bCustomerId}`, { headers: headers(a.token), data: { name: 'hijacked' } });
    expect(patch.status()).toBeLessThan(500);
    if (patch.status() === 200) expect(await patch.json()).toEqual([]);
    const del = await request.delete(`${URL_BASE}/rest/v1/customers?id=eq.${bCustomerId}`, { headers: headers(a.token) });
    expect(del.status()).toBeLessThan(500);
    if (del.status() === 200) expect(await del.json()).toEqual([]);
    // B's row is untouched
    const still = await request.get(`${URL_BASE}/rest/v1/customers?id=eq.${bCustomerId}&select=name`, { headers: headers(b.token) });
    expect(await still.json()).toEqual([{ name: 'iso-probe-b' }]);
  });

  test('tenant A cannot create a row owned by tenant B', async ({ request }) => {
    const res = await request.post(`${URL_BASE}/rest/v1/customers`, { headers: headers(a.token), data: { user_id: b.userId, name: 'forged-for-b' } });
    expect([401, 403]).toContain(res.status());
  });

  test('tenant A does not see tenant B’s profile or team', async ({ request }) => {
    const profile = await request.get(`${URL_BASE}/rest/v1/profiles?id=eq.${b.userId}&select=id`, { headers: headers(a.token) });
    expect(await profile.json()).toEqual([]);
    const team = await request.get(`${URL_BASE}/rest/v1/team_members?account_owner_id=eq.${b.userId}&select=id`, { headers: headers(a.token) });
    expect(await team.json()).toEqual([]);
  });
});
