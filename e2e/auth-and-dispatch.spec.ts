// e2e/auth-and-dispatch.spec.ts
//
// نیاز به یک اکانت تست واقعی توی محیط استیجینگ داره (نه production).
// این دو env var رو توی CI secrets ست کنید: E2E_TEST_EMAIL, E2E_TEST_PASSWORD
import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.describe('Authenticated flows', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(EMAIL!);
    await page.getByLabel('Password').fill(PASSWORD!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/dashboard/);
  });

  test('dispatch board loads and lists technicians without a client-side crash', async ({ page }) => {
    await page.goto('/dashboard/dispatch');
    await expect(page.getByRole('heading', { name: 'Dispatch Board' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('billing page loads without exposing a raw Stripe error', async ({ page }) => {
    await page.goto('/dashboard/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/stripe.*error/i);
  });
});
