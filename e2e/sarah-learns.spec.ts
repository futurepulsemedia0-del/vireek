// e2e/sarah-learns.spec.ts
//
// "Sarah Learns Your Business" — fully mocked network (Supabase auth/REST/RPC and
// the three edge functions), so it needs no real account and never touches
// telephony. The real test call is gated in the UI: Go live stays disabled until
// the owner confirms a test call, which this spec asserts instead of dialling.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const SUPABASE = process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const REF = new URL(SUPABASE).hostname.split('.')[0];
const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-00000000000a';

const field = (key: string, value: unknown, o: Record<string, unknown> = {}) => ({
  id: key, key, value, prev_value: null, confidence: 'high', assumed: false, sensitive: false, origin: 'source', source_id: null, citation: 'quote', status: 'pending', edit_count: 0, ...o,
});

async function mockBackend(page: Page) {
  const state = { fields: [field('business_name', 'Arctic Breeze'), field('services_offered', ['furnace repair']), field('service_area', 'Austin, TX'), field('diagnostic_fee', 'Trip fee is $89', { sensitive: true, confidence: 'medium' })], run: { id: RUN, status: 'drafted', locale: 'en', website_url: 'https://arctic.example.com', started_at: new Date().toISOString(), first_draft_at: new Date().toISOString(), readiness_passed: false, readiness_score: null, test_call_confirmed_at: null, live_at: null } };
  const token = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: USER, email: 'owner@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {} } };
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [`sb-${REF}-auth-token`, JSON.stringify(token)]);

  await page.route('**/auth/v1/user', (r) => r.fulfill({ json: token.user }));
  await page.route('**/rest/v1/rpc/**', async (r) => {
    const name = new URL(r.request().url()).pathname.split('/').pop();
    if (name === 'sarah_learn_bulk_approve') {
      state.fields = state.fields.map((f) => (!f.sensitive && f.status === 'pending' ? { ...f, status: 'approved' } : f));
      return r.fulfill({ json: 3 });
    }
    if (name === 'sarah_learn_set_field') {
      const b = r.request().postDataJSON() as { p_key: string; p_action: string };
      state.fields = state.fields.map((f) => (f.key === b.p_key ? { ...f, status: b.p_action === 'approve' ? 'approved' : 'rejected' } : f));
      return r.fulfill({ json: null });
    }
    return r.fulfill({ json: [] });
  });
  await page.route('**/rest/v1/sarah_learn_runs**', (r) => r.fulfill({ json: r.request().headers()['accept']?.includes('vnd.pgrst.object') ? state.run : [state.run] }));
  await page.route('**/rest/v1/sarah_learn_fields**', (r) => r.fulfill({ json: state.fields }));
  await page.route('**/rest/v1/sarah_learn_sources**', (r) => r.fulfill({ json: [] }));
  await page.route('**/rest/v1/sarah_learn_scenario_results**', (r) => r.fulfill({ json: [] }));
  await page.route('**/rest/v1/sarah_learn_suggestions**', (r) => r.fulfill({ json: [] }));
  await page.route('**/functions/v1/sarah-learn-interview', (r) => r.fulfill({ json: { question: null, remaining: 0, answered: 0, max_questions: 7, estimate_seconds: 0, done: true } }));
  await page.route('**/functions/v1/sarah-learn-readiness', (r) =>
    r.fulfill({ json: { scorecard: { total: 20, passed: 18, rate: 0.9, criticalFailed: [], meetsThreshold: true, passed_gate: true }, results: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, category: i === 0 ? 'emergency' : 'pricing', critical: i === 0, caller: `Caller ${i}`, reply: `Reply ${i}`, passed: i > 1, failures: i > 1 ? [] : ['Must offer an estimate'] })) } }),
  );
  return state;
}

test.describe('Sarah Learns Your Business (mocked)', () => {
  test('resumes a draft, requires sensitive approval, runs readiness, keeps Go live gated', async ({ page }) => {
    const state = await mockBackend(page);
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Let Sarah learn your business' })).toBeVisible();

    // Resumed at the interview; mocked interview has nothing left -> review.
    await page.getByRole('button', { name: 'Review what Sarah learned' }).click();
    await expect(page.getByTestId('field-diagnostic_fee')).toContainText('Needs review');
    await expect(page.getByText('1 sensitive items are waiting.')).toBeVisible();

    await page.getByRole('button', { name: /Approve \d+ safe items/ }).click();
    await expect(page.getByTestId('field-business_name')).toContainText('Approved');
    // Sensitive item is NOT approved by the bulk action.
    await expect(page.getByTestId('field-diagnostic_fee')).toContainText('Needs review');

    await page.getByRole('button', { name: 'Test Sarah' }).click();
    state.run = { ...state.run, status: 'readiness', readiness_passed: true, readiness_score: 0.9 } as typeof state.run;
    await page.getByRole('button', { name: 'Run the 20 test calls' }).click();
    await expect(page.getByTestId('scorecard')).toContainText('18 of 20 passed');

    // No real call has been confirmed, so Go live must stay disabled.
    await expect(page.getByRole('button', { name: 'Go live' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Approve or reject every sensitive item.')).toBeVisible();
  });

  test('has no serious accessibility violations on the review screen', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/onboarding');
    await page.getByRole('button', { name: 'Review what Sarah learned' }).click();
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('mobile viewport has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockBackend(page);
    await page.goto('/onboarding');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});
