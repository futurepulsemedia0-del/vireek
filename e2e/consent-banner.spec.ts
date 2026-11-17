// e2e/consent-banner.spec.ts: timing, dismissal, placement and accessibility of the redesigned banner.
// Run: npx playwright test e2e/consent-banner.spec.ts
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const GOOGLE = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net/i;
const region = (page: Page) => page.getByRole('region', { name: /cookie choices/i });

test('not present at first paint; appears by ~3.5s; focus stays on the page; no Google request', async ({ page }) => {
  const google: string[] = [];
  page.on('request', (r) => { if (GOOGLE.test(r.url())) google.push(r.url()); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(region(page)).toHaveCount(0);
  await expect(region(page)).toBeVisible({ timeout: 8000 });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect(google).toEqual([]);
});

test('first click reveals it early', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('load');
  await page.mouse.click(5, 300);
  await expect(region(page)).toBeVisible({ timeout: 2500 });
});

test('Escape = no choice: nothing stored, stays away on reload, footer reopens the center', async ({ page }) => {
  await page.goto('/');
  await expect(region(page)).toBeVisible({ timeout: 8000 });
  await region(page).getByRole('button', { name: /close and decide later/i }).focus();
  await page.keyboard.press('Escape');
  await expect(region(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('vireek-consent-v3'))).toBeNull();
  await page.reload();
  await page.waitForTimeout(4500);
  await expect(region(page)).toHaveCount(0);
  await page.getByRole('contentinfo').getByRole('button', { name: /cookie preferences/i }).click();
  await expect(page.getByRole('dialog', { name: /cookie settings/i })).toBeVisible();
});

test('Accept and Reject have identical size', async ({ page }) => {
  await page.goto('/');
  await expect(region(page)).toBeVisible({ timeout: 8000 });
  const a = await region(page).getByRole('button', { name: /accept all/i }).boundingBox();
  const r = await region(page).getByRole('button', { name: /reject all/i }).boundingBox();
  expect(Math.round(a!.width)).toBe(Math.round(r!.width));
  expect(Math.round(a!.height)).toBe(Math.round(r!.height));
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe passes in ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
    await page.goto('/');
    await expect(region(page)).toBeVisible({ timeout: 8000 });
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}

for (const dir of ['ltr', 'rtl'] as const) {
  test(`375px: covers <=45% and does not overlap launchers (${dir})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    await page.evaluate((d) => { document.documentElement.dir = d; }, dir);
    await expect(region(page)).toBeVisible({ timeout: 8000 });
    const b = (await region(page).boundingBox())!;
    expect(b.height).toBeLessThanOrEqual(800 * 0.45 + 1);
    for (const sel of ['[data-floating-launcher]']) {
      const l = await page.locator(sel).first().boundingBox();
      if (l) expect(l.y + l.height <= b.y + 1 || l.y >= b.y + b.height).toBe(true);
    }
  });
}

test('reduced motion: no transition on the banner', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(region(page)).toBeVisible({ timeout: 8000 });
  const d = await region(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(d).toMatch(/^0s(, 0s)*$/);
});
