// e2e/staff-margins.spec.ts — needs a real STAFF account on staging: set E2E_STAFF_EMAIL and E2E_STAFF_PASSWORD.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_STAFF_EMAIL;
const PASSWORD = process.env.E2E_STAFF_PASSWORD;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(EMAIL!);
  await page.getByLabel('Password').fill(PASSWORD!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe('Staff margins', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD not set — skipping staff flows.');

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/staff/margins');
    await expect(page.getByRole('heading', { name: 'Margins & unit economics' })).toBeVisible();
  });

  test('tabs work with arrow keys', async ({ page }) => {
    const tabs = page.getByRole('tablist', { name: 'Margin sections' });
    await expect(tabs).toBeVisible();
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Simulator & quotes' })).toHaveAttribute('aria-selected', 'true');
  });

  for (const tab of ['Overview', 'Simulator & quotes', 'Inputs', 'Report']) {
    test(`no serious a11y violations on "${tab}"`, async ({ page }) => {
      await page.getByRole('tab', { name: tab }).click();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    });
  }

  test('rate form refuses a rate without a source', async ({ page }) => {
    await page.getByRole('tab', { name: 'Inputs' }).click();
    await page.getByLabel('Provider', { exact: true }).first().fill('vapi');
    await page.getByLabel('Rate (USD per unit)').fill('0.01');
    await page.getByRole('button', { name: 'Add rate' }).click();
    await expect(page.getByRole('alert').getByText(/Source is required/)).toBeVisible();
  });
});
