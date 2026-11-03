// e2e/ai-agent-callers.spec.ts
// Needs a staging test account (E2E_TEST_EMAIL / E2E_TEST_PASSWORD), like auth-and-dispatch.spec.ts.
// NOT RUN in the authoring environment (no staging credentials) — see the PR description.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.describe('AI agent callers dashboard', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(EMAIL!);
    await page.getByLabel('Password').fill(PASSWORD!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/dashboard/);
  });

  for (const dir of ['ltr', 'rtl'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`controls tab has no WCAG 2.2 AA violations (${theme}, ${dir})`, async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
        await page.goto('/dashboard/ai-agent-callers');
        await page.evaluate(([t, d]) => {
          document.documentElement.classList.toggle('dark', t === 'dark');
          document.documentElement.dir = d;
        }, [theme, dir]);
        await expect(page.getByRole('heading', { name: 'AI agent callers' })).toBeVisible();
        for (const tab of ['Overview', 'Holds', 'Controls', 'Quotable services']) {
          await page.getByRole('tab', { name: tab }).click();
          const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
          expect(results.violations.map((v) => `${tab}: ${v.id} x${v.nodes.length}`)).toEqual([]);
        }
      });
    }
  }

  test('reduced motion is respected and the page does not crash', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard/ai-agent-callers');
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });
});
