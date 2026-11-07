// e2e/images.spec.ts — image accessibility, layout stability and loading-policy guard.
// Runs against 10 key public pages. Complements perf-cls.spec.ts (CLS budget) and accessibility.spec.ts.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = ['/', '/pricing', '/faq', '/security', '/blog', '/press', '/leadership', '/brand', '/login', '/accessibility-statement'];

async function scrollThrough(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 700) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(100);
  }
  await page.waitForLoadState('networkidle');
}

for (const path of PAGES) {
  test.describe(path, () => {
    test('axe: image-alt, role-img-alt, svg-img-alt, image-redundant-alt', async ({ page }) => {
      await page.goto(path);
      await scrollThrough(page);
      const results = await new AxeBuilder({ page })
        .withRules(['image-alt', 'role-img-alt', 'svg-img-alt', 'image-redundant-alt', 'input-image-alt'])
        .analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });

    test('every <img> has alt, reserved space, a loading policy and loads', async ({ page }) => {
      await page.goto(path);
      await scrollThrough(page);
      const problems = await page.evaluate(() => {
        const out: string[] = [];
        let high = 0;
        for (const img of Array.from(document.images)) {
          const id = img.currentSrc || img.src || '(no src)';
          if (!img.hasAttribute('alt')) out.push(`missing alt: ${id}`);
          const hasDims = img.hasAttribute('width') && img.hasAttribute('height');
          const aspect = getComputedStyle(img).aspectRatio;
          const parentBox = img.parentElement ? getComputedStyle(img.parentElement) : null;
          const reservedByParent = Boolean(parentBox && parentBox.height !== 'auto' && img.getBoundingClientRect().height > 0 && img.offsetParent);
          if (!hasDims && aspect === 'auto' && !reservedByParent) out.push(`no reserved space: ${id}`);
          const priority = img.getAttribute('fetchpriority') === 'high';
          if (priority) high++;
          if (!img.hasAttribute('loading') && !priority) out.push(`no loading policy: ${id}`);
          if (priority && img.getAttribute('loading') === 'lazy') out.push(`lazy LCP image: ${id}`);
          if (img.complete && img.naturalWidth === 0 && img.getBoundingClientRect().width > 0) out.push(`broken image: ${id}`);
        }
        if (high > 1) out.push(`more than one fetchpriority=high image (${high})`);
        return out;
      });
      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
}

test('reveal image motion is static under prefers-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const img = page.locator('picture img').first();
  await img.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const a = await img.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(900);
  const b = await img.evaluate((el) => getComputedStyle(el).transform);
  expect(b, 'transform must not animate with reduced motion').toBe(a);
});
