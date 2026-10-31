// e2e/loading.spec.ts — Vireek Pulse
// Production-safe tests run against `vite preview` (default webServer).
// The /dev/loading tests need the dev server:  E2E_DEV=1 E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/loading.spec.ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('boot + route loading (production build)', () => {
  test('first paint uses the themed boot background (no white flash in dark)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vireek-theme', 'dark'));
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    expect(bg).toBe('rgb(9, 10, 13)');
  });

  test('boot loader is removed after the app mounts', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#vrk-boot')).toHaveCount(0, { timeout: 10_000 });
  });

  test('slow chunk shows the top progress bar, then the page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#vrk-boot')).toHaveCount(0, { timeout: 10_000 });
    await page.route('**/assets/**/*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    // Client-side navigation (react-router listens to popstate) so the lazy chunk is fetched, not a full reload.
    await page.evaluate(() => {
      history.pushState({}, '', '/accessibility-statement');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.vrk-topbar')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.vrk-topbar')).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe('demo page (dev server only)', () => {
  test.skip(!process.env.E2E_DEV, 'set E2E_DEV=1 and point E2E_BASE_URL at the dev server');

  test('reduced motion: no transform animation on the mark', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dev/loading');
    const name = await page.locator('.vrk-pulse__bar').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe('none');
  });

  test('skeleton → content causes ~zero layout shift', async ({ page }) => {
    await page.goto('/dev/loading');
    await page.evaluate(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEntry[] & { value?: number; hadRecentInput?: boolean }[]) {
          const ls = e as unknown as { value: number; hadRecentInput: boolean };
          if (!ls.hadRecentInput) (window as unknown as { __cls: number }).__cls += ls.value;
        }
      }).observe({ type: 'layout-shift', buffered: false });
    });
    await page.getByRole('group', { name: 'Boundary state' }).getByRole('button', { name: 'loading' }).click();
    await page.waitForTimeout(700);
    await page.getByRole('group', { name: 'Boundary state' }).getByRole('button', { name: 'content' }).click();
    await expect(page.getByTestId('demo-content')).toBeVisible();
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls).toBeLessThan(0.01);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`no WCAG 2.2 AA violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), scheme);
      await page.goto('/dev/loading');
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
});
