// e2e/visual.spec.ts — visual regression baseline. Opt-in: E2E_VISUAL=1.
// Create/refresh baselines on CI (Linux) only:  E2E_VISUAL=1 npx playwright test e2e/visual.spec.ts --update-snapshots
import { test, expect } from '@playwright/test';

test.skip(!process.env.E2E_VISUAL, 'set E2E_VISUAL=1 to run visual regression');

for (const [name, path] of [['home', '/'], ['pricing', '/pricing'], ['login', '/login']] as const) {
  test(`visual: ${name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(path, { waitUntil: 'networkidle' });
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.01 });
  });
}
