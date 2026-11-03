import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const RESULT = {
  ok: true, host: 'acme.com', score: 62, coverage: 0.2,
  subscores: [{ id: 'website', score: 62, measuredChecks: 8, totalChecks: 8 }],
  checks: [{ ruleId: 'site_click_to_call', subscore: 'website', status: 'fail', points: 0, max: 14, evidence: { k: 'tel_missing', p: { count: 0 } } }],
  topFixes: [{ ruleId: 'site_click_to_call', lost: 14, evidence: { k: 'tel_missing', p: { count: 0 } } }],
};

test.describe('/agent-readiness (public)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${scheme} mode, before and after a result`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.route('**/functions/v1/agent-readiness-public', (route) => route.fulfill({ json: RESULT }));
      await page.goto('/agent-readiness');
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);
      await page.getByLabel(/website address/i).fill('acme.com');
      await page.getByRole('button', { name: /check my website/i }).click();
      await expect(page.getByRole('heading', { name: /result for acme.com/i })).toBeVisible();
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    });
  }
  test('fits a 375px viewport without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/agent-readiness');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
