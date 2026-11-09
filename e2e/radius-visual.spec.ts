// e2e/radius-visual.spec.ts — visual regression + a11y for the border-radius scale (light + dark).
// Public screens only (no auth needed). The dashboard / marketing batches are baselined per batch of the codemod:
//   1. BEFORE migrating a batch:  E2E_VISUAL=1 npx playwright test e2e/radius-visual.spec.ts --update-snapshots   (commit "before")
//   2. run the codemod for that batch, then re-run WITHOUT --update-snapshots and review every diff image.
//   3. when the diff is exactly the intended radius change, refresh snapshots and commit.
// /dev/design-system exists in dev and in builds made with VITE_ENABLE_DEV_STATES=true.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.skip(!process.env.E2E_VISUAL, 'set E2E_VISUAL=1 to run radius visual regression');

const SCREENS = [
  ['home', '/'],
  ['pricing', '/pricing'],
  ['login', '/login'],
  ['brand', '/brand'],
  ['design-system', '/dev/design-system'],
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const [name, path] of SCREENS) {
    test(`radius visual: ${name} [${theme}]`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript((t) => { try { localStorage.setItem('vireek-theme', t); } catch { /* ignore */ } }, theme);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`radius-${name}-${theme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01, animations: 'disabled' });
    });
  }
}

test('design-system page has no serious a11y violations', async ({ page }) => {
  await page.goto('/dev/design-system');
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});

// Computed-style assertions: the scale is what the config says, in the real browser.
test('computed radii match the scale', async ({ page }) => {
  await page.goto('/dev/design-system');
  const px = async (cls: string) => page.locator(`code:text-is("${cls}")`).first().locator('xpath=ancestor::tr//span[contains(@class,"block")]').evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(await px('rounded-control')).toBe('8px');
  expect(await px('rounded-inset')).toBe('8px');
  expect(await px('rounded-chip')).toBe('6px');
  expect(await px('rounded-surface')).toBe('12px');
  expect(await px('rounded-overlay')).toBe('16px');
});
