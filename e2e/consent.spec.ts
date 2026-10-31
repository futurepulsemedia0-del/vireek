// e2e/consent.spec.ts
// Proves no Google request happens before consent, that withdrawal works, and that the banner is accessible.
// Needs: npm i -D @axe-core/playwright
// "After accept" tests need a build that knows a GA id:
//   VITE_GA4_MEASUREMENT_ID=G-TEST123456 npx playwright test e2e/consent.spec.ts
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const GOOGLE = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net/i;
const HAS_GA_ID = Boolean(process.env.VITE_GA4_MEASUREMENT_ID);

async function watch(page: Page) {
  const log: { t: number; url: string }[] = [];
  const start = Date.now();
  page.on('request', (r) => log.push({ t: Date.now() - start, url: r.url() }));
  // Never talk to Google from tests: answer with an empty script.
  await page.route(GOOGLE, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  return log;
}
const googleHits = (log: { url: string }[]) => log.filter((e) => GOOGLE.test(e.url));

test('NO Google request before any consent decision (load, scroll, navigate)', async ({ page }, info) => {
  const log = await watch(page);
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: /cookie/i })).toBeVisible();
  await page.mouse.wheel(0, 1200);
  await page.goto('/pricing');
  await page.waitForTimeout(3000);
  await info.attach('network-log-before-consent.json', { body: JSON.stringify(log, null, 2), contentType: 'application/json' });
  expect(googleHits(log)).toEqual([]);
  expect((await page.context().cookies()).filter((c) => /^_ga/.test(c.name))).toEqual([]);
});

test('Reject non-essential keeps Google silent and the banner does not return', async ({ page }) => {
  const log = await watch(page);
  await page.goto('/');
  await page.getByRole('button', { name: /reject non-essential/i }).click();
  await page.reload();
  await page.waitForTimeout(2000);
  await expect(page.getByRole('dialog', { name: /cookie/i })).toHaveCount(0);
  expect(googleHits(log)).toEqual([]);
});

test('Accept all loads Google only after the click', async ({ page }) => {
  test.skip(!HAS_GA_ID, 'Build without VITE_GA4_MEASUREMENT_ID: analytics intentionally inert.');
  const log = await watch(page);
  await page.goto('/');
  await page.waitForTimeout(1500);
  expect(googleHits(log)).toEqual([]);
  await page.getByRole('button', { name: /accept all/i }).click();
  await expect.poll(() => googleHits(log).length).toBeGreaterThan(0);
});

test('Withdrawing consent deletes _ga cookies and stops Google traffic without a reload', async ({ page, context, baseURL }) => {
  test.skip(!HAS_GA_ID, 'Needs VITE_GA4_MEASUREMENT_ID.');
  const log = await watch(page);
  await page.goto('/');
  await page.getByRole('button', { name: /accept all/i }).click();
  await expect.poll(() => googleHits(log).length).toBeGreaterThan(0);
  const host = new URL(baseURL ?? 'http://localhost:4173').hostname;
  await context.addCookies([{ name: '_ga', value: 'GA1.1.1', domain: host, path: '/' }]);

  await page.getByRole('button', { name: /cookie preferences/i }).click();
  await page.getByRole('button', { name: /reject non-essential/i }).click();
  await expect.poll(async () => (await context.cookies()).filter((c) => /^_ga/.test(c.name)).length).toBe(0);

  const before = googleHits(log).length;
  await page.goto('/pricing');
  await page.waitForTimeout(2000);
  expect(googleHits(log).length).toBe(before);
});

test('GPC: marketing switch is locked off', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /choose settings/i }).click();
  const sw = page.getByRole('switch', { name: /marketing/i });
  await expect(sw).toBeDisabled();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await ctx.close();
});

test('banner and settings: axe, Esc, focus trap, focus return, live announcement', async ({ page }) => {
  await page.goto('/');
  const banner = page.getByRole('dialog', { name: /cookie/i });
  await expect(banner).toBeVisible();
  let results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  const sizes = await banner.getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  for (const h of sizes) expect(h).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: /choose settings/i }).click();
  const center = page.getByRole('dialog', { name: /cookie settings/i });
  await expect(center).toBeVisible();
  results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    expect(await center.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(center).toHaveCount(0);

  await page.getByRole('contentinfo').getByRole('button', { name: /cookie preferences/i }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /cookie settings/i })).toBeVisible();
  await page.getByRole('button', { name: /save choices/i }).click();
  await expect(page.locator('#consent-live-region')).toContainText(/saved/i);
  await expect(page.getByRole('contentinfo').getByRole('button', { name: /cookie preferences/i })).toBeFocused();
});
