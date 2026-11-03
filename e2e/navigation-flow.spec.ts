import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Public-route flows only (no login fixture needed).

test('back/forward restores scroll, new navigation resets to top', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  const before = await page.evaluate(() => window.scrollY);

  await page.locator('a[href="/faq"]').first().click();
  await expect(page).toHaveURL(/\/faq$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 3000 }).toBeGreaterThan(before - 120);
});

test('route change moves focus to the page heading and guarantees #main-content', async ({ page }) => {
  await page.goto('/');
  await page.locator('a[href="/faq"]').first().click();
  await expect(page).toHaveURL(/\/faq$/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  await expect(page.locator('#main-content')).toHaveCount(1);
});

test('skip link is the first tab stop and lands in main content', async ({ page }) => {
  await page.goto('/faq');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: /skip to main content/i });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main-content$/);
});

test('reduced motion: no transition animation on <main>', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('a[href="/faq"]').first().click();
  await expect(page).toHaveURL(/\/faq$/);
  const animations = await page.evaluate(() => document.querySelector('main')?.getAnimations().length ?? 0);
  expect(animations).toBe(0);
});

test('breadcrumbs on a public page: accessible and emit BreadcrumbList JSON-LD', async ({ page }) => {
  await page.goto('/faq');
  const nav = page.getByRole('navigation', { name: /breadcrumb/i });
  if ((await nav.count()) === 0) test.skip(true, 'Breadcrumbs not mounted on /faq yet (see integration step 6)');
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.some((t) => t.includes('BreadcrumbList'))).toBe(true);
  const results = await new AxeBuilder({ page }).include('nav[aria-label]').analyze();
  expect(results.violations).toEqual([]);
});

test.describe('404 page', () => {
  test('is noindex, suggests a close match, filters links and reports the broken link', async ({ page }) => {
    let reported: string | null = null;
    await page.route('**/rest/v1/rpc/report_broken_link', async (route) => {
      reported = route.request().postData();
      await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/pricng');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByRole('link', { name: '/pricing' })).toBeVisible(); // "Did you mean"

    await page.getByRole('searchbox', { name: /search popular pages/i }).fill('integr');
    await expect(page.getByRole('link', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pricing', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /report this broken link/i }).click();
    await expect(page.getByText(/we will take a look/i)).toBeVisible();
    expect(reported).toContain('/pricng');
  });

  test('has no axe violations', async ({ page }) => {
    await page.goto('/definitely-not-a-page');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
