// e2e/golden-path-pay-link.spec.ts — public payment link (golden path step 8), edge function fully mocked.
// No Stripe call is made; a real card decline needs Stripe test mode and is listed as BLOCKED in the audit report.
// NOT RUN when authored. Needs a build with VITE_SUPABASE_URL set (same requirement as e2e/first-call.spec.ts).
import { test, expect, type Page } from '@playwright/test';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

async function mockPublicPayment(page: Page, status: number, body: unknown) {
  await page.route('**/functions/v1/public-payment', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
}

test.describe('Golden path: public pay link', () => {
  test('an already-paid link says so and never offers to pay again (duplicate-payment guard)', async ({ page }) => {
    await mockPublicPayment(page, 200, { status: 'paid', amount_cents: 15000 });
    await page.goto(`/pay/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Already paid' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay \$/ })).toHaveCount(0);
  });

  test('a canceled or unknown link is explained, not blank', async ({ page }) => {
    await mockPublicPayment(page, 200, { status: 'canceled' });
    await page.goto(`/pay/${TOKEN}`);
    await expect(page.getByRole('heading', { name: "This payment link isn't available" })).toBeVisible();
  });

  test('a server refusal is shown as a readable alert', async ({ page }) => {
    await mockPublicPayment(page, 409, { error: "Your payment is still being processed. Please don't pay again." });
    await page.goto(`/pay/${TOKEN}`);
    await expect(page.getByRole('alert')).toContainText("still being processed");
  });

  test('an open link shows the amount due', async ({ page }) => {
    await mockPublicPayment(page, 200, { status: 'open', amount_cents: 15000, description: 'AC repair', tip_enabled: false, presets: [], publishable_key: null });
    await page.goto(`/pay/${TOKEN}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('150.00');
  });
});
