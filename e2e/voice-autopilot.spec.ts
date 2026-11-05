// e2e/voice-autopilot.spec.ts
//
// Voice Autopilot (A/B tab) and Staff QA tab: WCAG 2.2 AA via axe, keyboard reachability, light/dark, RTL, reduced motion.
// Needs a staging account with a published call script: set E2E_TEST_EMAIL and E2E_TEST_PASSWORD.
// axe needs: npm install -D @axe-core/playwright
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(EMAIL!);
  await page.getByLabel('Password').fill(PASSWORD!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/dashboard/);
}

const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();

test.describe('Voice Autopilot and Staff QA', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/call-scripts');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`A/B tab has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByRole('tab', { name: /A\/B test/ }).or(page.getByRole('button', { name: /A\/B test/ })).first().click();
      await expect(page.getByRole('heading', { name: 'Voice Autopilot' })).toBeVisible();
      const results = await axe(page);
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

  test('locked-compliance notice is always visible and the mode radios are keyboard operable', async ({ page }) => {
    await page.getByRole('button', { name: /A\/B test/ }).first().click();
    await expect(page.getByText('Compliance language is locked')).toBeVisible();
    const suggest = page.getByRole('radio', { name: /Suggest/ });
    await suggest.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Auto/ })).toBeChecked();
  });

  test('RTL layout has no axe violations', async ({ page }) => {
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await page.getByRole('button', { name: /A\/B test/ }).first().click();
    const results = await axe(page);
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('reduced motion: spinners do not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: /A\/B test/ }).first().click();
    const animated = await page.locator('.animate-spin:not(.motion-reduce\\:animate-none)').count();
    expect(animated).toBe(0);
  });

  test('Staff QA tab shows the policy note and is accessible', async ({ page }) => {
    await page.getByRole('button', { name: /Staff QA/ }).first().click();
    await expect(page.getByText(/must not be used for discipline/)).toBeVisible();
    const results = await axe(page);
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
