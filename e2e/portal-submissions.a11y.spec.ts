// axe (WCAG 2.2 AA) for the Portal submissions page. Requires an authenticated session fixture: set E2E_STORAGE_STATE to a saved Playwright storageState
// of a billing-permitted user (the same approach other authenticated specs in this repo need). NOT RUN in the authoring environment.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.skip(!process.env.E2E_STORAGE_STATE, 'needs E2E_STORAGE_STATE for an authenticated billing user');
test.use({ storageState: process.env.E2E_STORAGE_STATE });

for (const lang of ['en', 'fa'] as const) {
  for (const tab of ['Submissions', 'Portals', 'Remittances', 'Settings']) {
    test(`/dashboard/portal-submissions [${lang}] ${tab} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem('i18nextLng', l), lang);
      await page.goto('/dashboard/portal-submissions');
      await page.getByRole('tab').nth(['Submissions', 'Portals', 'Remittances', 'Settings'].indexOf(tab)).click();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
}
test('tabs are keyboard operable and the dir attribute follows the language', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'fa'));
  await page.goto('/dashboard/portal-submissions');
  const first = page.getByRole('tab').first(); await first.focus(); await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab').nth(1)).toBeFocused();           // RTL: ArrowLeft moves forward
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
});
