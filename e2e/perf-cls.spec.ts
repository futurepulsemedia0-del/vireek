// e2e/perf-cls.spec.ts — fails when a top route shifts layout more than the 0.05 budget.
// layout-shift entries exist only in Chromium, so this runs there.
import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __cls: number;
  }
}

const ROUTES = ['/', '/pricing', '/login', '/faq', '/security', '/accessibility-statement'];
const CLS_BUDGET = 0.05;

for (const path of ROUTES) {
  test(`${path} stays within the CLS budget`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'layout-shift is Chromium-only');
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
          if (!shift.hadRecentInput) window.__cls += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(path, { waitUntil: 'networkidle' });
    // Scroll through the page so lazy sections, images and widgets mount and can shift.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 600) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(500);
    const cls = await page.evaluate(() => window.__cls);
    expect(cls, `CLS on ${path}`).toBeLessThanOrEqual(CLS_BUDGET);
  });
}
