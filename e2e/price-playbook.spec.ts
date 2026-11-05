// e2e/price-playbook.spec.ts
//
// Needs a staging account (same env vars as auth-and-dispatch.spec.ts) and the 20280402000000 migration.
//   E2E_TEST_EMAIL, E2E_TEST_PASSWORD
// Needs: @axe-core/playwright (already a devDependency).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.describe('Price Playbook', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  for (const theme of ['light', 'dark'] as const) {
    for (const dir of ['ltr', 'rtl'] as const) {
      test(`axe + create-policy flow (${theme}/${dir})`, async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
        await page.goto('/login');
        await page.getByLabel('Email address').fill(EMAIL!);
        await page.getByLabel('Password').fill(PASSWORD!);
        await page.getByRole('button', { name: 'Sign In' }).click();
        await page.waitForURL(/\/dashboard/);
        await page.goto('/dashboard/price-playbook');
        await page.evaluate(([t, d]) => {
          document.documentElement.classList.toggle('dark', t === 'dark');
          document.documentElement.dir = d;
        }, [theme, dir]);
        await expect(page.getByRole('heading', { name: 'Price Playbook' })).toBeVisible();

        await page.getByRole('button', { name: 'New policy' }).first().click();
        const name = `E2E drain ${Date.now()}`;
        await page.getByLabel('Service name').fill(name);
        await page.getByLabel('What may Sarah say?').selectOption('diagnostic_fee_only');
        await page.getByLabel('Diagnostic / trip fee ($)').fill('89');
        // Unknown state: the preview must fail closed (no dollar amount).
        await expect(page.getByText('The caller\'s state is unknown, so no number is spoken.')).toBeVisible();

        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

        await page.getByRole('button', { name: 'Save policy' }).click();
        await expect(page.getByText(name)).toBeVisible();
        // Clean up.
        const row = page.getByRole('listitem').filter({ hasText: name });
        await row.getByRole('button', { name: 'Delete' }).click();
        await row.getByRole('button', { name: 'Delete' }).click();
        await expect(page.getByText(name)).toHaveCount(0);
      });
    }
  }
});
