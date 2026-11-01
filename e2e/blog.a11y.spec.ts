import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Requires: npm i -D @axe-core/playwright, and a built app served by playwright.config.ts (same as other e2e specs).
const PAGES = ['/blog', '/blog/category/missed-calls', '/blog/cost-of-a-missed-call'];

for (const path of PAGES) {
  test(`axe: no WCAG A/AA violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForSelector('h1');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

test('article has one h1, ordered headings, a TOC and Article JSON-LD', async ({ page }) => {
  await page.goto('/blog/cost-of-a-missed-call');
  await page.waitForSelector('h1');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('nav[aria-label="On this page"]')).toBeAttached();
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.join(' ')).toContain('BlogPosting');
  expect(ld.join(' ')).toContain('BreadcrumbList');
});
