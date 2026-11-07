// e2e/color-visual.spec.ts — visual regression snapshots for the colour system (light + dark).
// First run: `npx playwright test e2e/color-visual.spec.ts --update-snapshots` and commit the PNGs.
import { test, expect } from '@playwright/test';

const PAGES = [['home', '/'], ['pricing', '/pricing'], ['login', '/login'], ['brand', '/brand'], ['about', '/about'], ['contact', '/contact'], ['blog', '/blog'], ['calculator', '/calculator'], ['compare', '/compare'], ['customers', '/customers']] as const;
for (const theme of ['light', 'dark'] as const) {
  for (const [name, path] of PAGES) {
    test(`visual ${name} [${theme}]`, async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem('vireek-theme', t); } catch { /* ignore */ } }, theme);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01, animations: 'disabled' });
    });
  }
}
