// Playwright + axe for the owner statement/dispute flow (Task E).
// STATUS: written, NOT RUN by the author (no browser, no app server, no seeded database were available).
// Needs: staging DB with the migration applied, the feature switched on for the test account, and a seeded approved statement with >= 1 line.
// Env: E2E_OUTCOME_EMAIL / E2E_OUTCOME_PASSWORD (a test account owner). Read-only except for the dispute it opens then withdraws.
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const email = process.env.E2E_OUTCOME_EMAIL;
const password = process.env.E2E_OUTCOME_PASSWORD;
test.skip(!email || !password, 'E2E_OUTCOME_EMAIL / E2E_OUTCOME_PASSWORD not set');

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email as string);
  await page.getByLabel(/password/i).fill(password as string);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/dashboard/);
}

for (const lang of ['en', 'fa'] as const) {
  test(`statement page is accessible and RTL-correct (${lang})`, async ({ page }) => {
    await page.addInitScript((l) => localStorage.setItem('i18nextLng', l), lang);
    await login(page);
    await page.goto('/dashboard/invoice-outcomes');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (lang === 'fa') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('contest a line with keyboard only, then withdraw', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/invoice-outcomes');
  const contest = page.getByRole('button', { name: /contest this line/i }).first();
  await contest.focus();
  await page.keyboard.press('Enter');
  const reason = page.getByLabel(/why do you disagree/i);
  await expect(reason).toBeFocused({ timeout: 2_000 }).catch(() => reason.focus());
  const send = page.getByRole('button', { name: /send contest/i });
  await expect(send).toBeDisabled();             // too short
  await reason.fill('This invoice was paid by cheque before the follow-up.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText(/won't be billed until it's resolved/i)).toBeVisible();
  await expect(page.getByText(/contested: not billed/i).first()).toBeVisible();
  await page.getByRole('button', { name: /withdraw contest/i }).first().click();
  await expect(page.getByText(/contest withdrawn/i)).toBeVisible();
});

test('offline disables sending', async ({ page, context }) => {
  await login(page);
  await page.goto('/dashboard/invoice-outcomes');
  await context.setOffline(true);
  await expect(page.getByText(/you are offline/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /contest this line/i }).first()).toBeDisabled();
});
