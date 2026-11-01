// e2e/cross-browser.spec.ts — runs on Chromium, Firefox, WebKit, Pixel 7 and iPhone 14 (see playwright.config.ts).
import { test, expect } from '@playwright/test';

const ROUTES = ['/', '/pricing', '/login', '/faq'];

for (const path of ROUTES) {
  test(`${path} renders, has no console errors and no horizontal overflow`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main, #root').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

test('form inputs are >=16px on small screens (prevents iOS Safari focus-zoom)', async ({ page }) => {
  const viewport = page.viewportSize();
  test.skip(!viewport || viewport.width >= 768, 'only relevant on phones');
  await page.goto('/login', { waitUntil: 'networkidle' });
  const sizes = await page.$$eval('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea', (els) =>
    els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => parseFloat(getComputedStyle(el).fontSize)),
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
});

test('min-h-screen uses dynamic viewport units where supported (iOS 100vh bug)', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'networkidle' });
  const ok = await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'min-h-screen';
    document.body.appendChild(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return !CSS.supports('height', '100dvh') || Math.abs(h - window.innerHeight) < 2;
  });
  expect(ok).toBe(true);
});
