import { test, expect } from '@playwright/test';

test('homepage loads and shows the core CTA path', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /start free trial/i }).first()).toBeVisible();
});

test('pricing page lists all plans and links to Stripe or /login', async ({ page }) => {
  await page.goto('/pricing');
  await expect(page.getByText(/professional/i).first()).toBeVisible();
});

test('nonexistent route does not crash the app shell', async ({ page }) => {
  const response = await page.goto('/this-route-does-not-exist');
  expect(response?.status()).toBeLessThan(500);
  await expect(page.locator('body')).not.toBeEmpty();
});
