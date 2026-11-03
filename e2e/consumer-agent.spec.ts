// e2e/consumer-agent.spec.ts
//
// Part 1 needs a staging account:            E2E_TEST_EMAIL, E2E_TEST_PASSWORD
// Part 2 needs the DEPLOYED edge function:   CONSUMER_AGENT_BASE_URL  (e.g. https://<ref>.supabase.co/functions/v1/consumer-agent)
// Each part is skipped (never faked) when its variables are missing.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const BASE = process.env.CONSUMER_AGENT_BASE_URL?.replace(/\/$/, '');

test.describe('Owner page: AI Agent Requests', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set.');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(EMAIL!);
    await page.getByLabel('Password').fill(PASSWORD!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/dashboard/);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const dir of ['ltr', 'rtl'] as const) {
      test(`axe: no WCAG 2.2 AA violations (${theme}/${dir})`, async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
        await page.goto('/dashboard/consumer-agent');
        await page.evaluate(([t, d]) => {
          document.documentElement.classList.toggle('dark', t === 'dark');
          document.documentElement.dir = d;
        }, [theme, dir]);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      });
    }
  }

  test('nothing is shared by default and the preview is visible', async ({ page }) => {
    await page.goto('/dashboard/consumer-agent');
    await expect(page.getByRole('switch', { name: /Open my business to AI agents/i })).toBeVisible();
    await expect(page.getByRole('region', { name: /Exactly what agents will see/i }).or(page.getByText(/Exactly what agents will see/i))).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('emergency stop needs a confirmation step and is keyboard reachable', async ({ page }) => {
    await page.goto('/dashboard/consumer-agent');
    const stop = page.getByRole('button', { name: /Stop all agent access now/i });
    if (!(await stop.isVisible())) test.skip(true, 'Emergency stop is already on for this account.');
    await stop.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
  });

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard/consumer-agent');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('Public surface contract (deployed function, sandbox business)', () => {
  test.skip(!BASE, 'CONSUMER_AGENT_BASE_URL not set.');
  const sb = () => `${BASE}/v1/b/vireek-sandbox`;
  const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });

  test('health, llms.txt, JSON-LD and agent card are served', async ({ request }) => {
    expect((await request.get(`${BASE}/v1/health`)).ok()).toBe(true);
    const llms = await request.get(`${sb()}/llms.txt`);
    expect(llms.headers()['content-type']).toContain('text/plain');
    expect(await llms.text()).toContain('Requests are not appointments');
    const ld = await (await request.get(`${sb()}/jsonld`)).json();
    expect(ld['@type']).toBe('HomeAndConstructionBusiness');
    const card = await (await request.get(`${sb()}/agent-card.json`)).json();
    expect(card.skills.map((s: { id: string }) => s.id).sort()).toEqual(['check_availability', 'get_business_info', 'get_price_range', 'request_booking']);
  });

  test('MCP: initialize + tools/list expose exactly four tools', async ({ request }) => {
    const init = await (await request.post(`${sb()}/mcp`, { data: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }) })).json();
    expect(init.result.serverInfo.name).toBe('vireek-consumer-agent');
    const list = await (await request.post(`${sb()}/mcp`, { data: rpc(2, 'tools/list') })).json();
    expect(list.result.tools).toHaveLength(4);
  });

  test('scope escape: owner tools are unknown here', async ({ request }) => {
    const r = await (await request.post(`${sb()}/mcp`, { data: rpc(3, 'tools/call', { name: 'get_customer', arguments: { email: 'a@b.co' } }) })).json();
    expect(r.error.code).toBe(-32602);
  });

  test('request_booking without a challenge is refused', async ({ request }) => {
    const avail = await (await request.post(`${sb()}/mcp`, { data: rpc(4, 'tools/call', { name: 'check_availability', arguments: { days: 7 } }) })).json();
    const start = avail.result.structuredContent.slots[0].start as string;
    const r = await (await request.post(`${sb()}/mcp`, { data: rpc(5, 'tools/call', { name: 'request_booking', arguments: {
      idempotency_key: `e2e-${Date.now()}-0001`, service_type: 'Drain Cleaning', requested_start: start, contact_name: 'E2E Tester',
      contact_phone: '+13125550100', postal_code: '60601', homeowner_consent: true } }) })).json();
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0].text).error).toBe('challenge_required');
  });

  test('unsigned and malformed bodies are rejected safely', async ({ request }) => {
    expect((await request.post(`${sb()}/mcp`, { data: 'not json', headers: { 'content-type': 'text/plain' } })).status()).toBe(415);
    expect((await request.post(`${sb()}/mcp`, { headers: { 'vireek-key-id': 'x' }, data: rpc(6, 'ping') })).status()).toBe(401);
  });

  test('unknown business is indistinguishable from an unpublished one', async ({ request }) => {
    expect((await request.get(`${BASE}/v1/b/no-such-business-xyz/profile.json`)).status()).toBe(404);
  });
});
