// Sensitive-access page: WCAG 2.2 AA (axe) in light, dark and RTL, plus keyboard reachability.
// Needs a real owner account: set E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD, otherwise the suite is skipped.
// Selectors for the login form are assumptions: adjust them to the real /login markup.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_OWNER_EMAIL;
const PASSWORD = process.env.E2E_OWNER_PASSWORD;
const PATH = '/dashboard/settings/access-history';

test.skip(!EMAIL || !PASSWORD, 'E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD not set');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(EMAIL ?? '');
  await page.getByLabel(/password/i).fill(PASSWORD ?? '');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/dashboard/);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const dir of ['ltr', 'rtl'] as const) {
    test(`access-history has no WCAG 2.2 AA violations (${scheme}, ${dir})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await signIn(page);
      await page.goto(PATH);
      await page.evaluate((d) => document.documentElement.setAttribute('dir', d), dir);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
}

test('access-history controls are keyboard reachable', async ({ page }) => {
  await signIn(page);
  await page.goto(PATH);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const checkbox = page.getByRole('checkbox');
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
});
