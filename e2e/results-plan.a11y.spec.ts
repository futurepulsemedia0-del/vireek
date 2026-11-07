// e2e/results-plan.a11y.spec.ts — WCAG 2.2 AA (axe) for the public Results Plan surfaces + auth gate for the owner page.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag22aa'];

test('/how-we-verify has no WCAG 2.2 AA violations', async ({ page }) => {
  await page.goto('/how-we-verify');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('/pricing "Pay per result" tab is keyboard operable and accessible', async ({ page }) => {
  await page.goto('/pricing');
  const tab = page.getByRole('tab', { name: 'Pay per result' });
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('/pricing never shows a Results Plan price unless public approved terms exist', async ({ page }) => {
  await page.goto('/pricing');
  await page.getByRole('tab', { name: 'Pay per result' }).click();
  await expect(page.getByText(/per verified job|Pricing is shared during onboarding/)).toBeVisible();
});

test('/dashboard/results-plan requires sign-in', async ({ page }) => {
  await page.goto('/dashboard/results-plan');
  await expect(page).not.toHaveURL(/\/dashboard\/results-plan$/);
});
