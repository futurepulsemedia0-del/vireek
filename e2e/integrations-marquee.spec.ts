import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// First run creates baselines:  npx playwright test integrations-marquee --update-snapshots
const WIDTHS = [375, 768, 1280, 1920] as const;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

async function openHome(page: Page, theme: Theme, width: number) {
  await page.addInitScript((t) => window.localStorage.setItem('vireek-theme', t), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  const section = page.getByTestId('integrations-marquee');
  await section.scrollIntoViewIfNeeded();
  return section;
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`marquee visual ${theme} @${width}px`, async ({ page }) => {
      const section = await openHome(page, theme, width);
      await expect(section.locator('.logo-marquee[data-entered="true"]:visible').first()).toBeVisible();
      await expect(section).toHaveScreenshot(`marquee-${theme}-${width}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  for (const width of [375, 1280] as const) {
    test(`marquee axe (WCAG 2.2 AA) ${theme} @${width}px`, async ({ page }) => {
      const section = await openHome(page, theme, width);
      await expect(section.locator('.logo-marquee[data-entered="true"]:visible').first()).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include('[data-testid="integrations-marquee"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('pause button freezes the track', async ({ page }) => {
  const section = await openHome(page, 'light', 1280);
  const track = section.locator('.logo-marquee__track:visible').first();
  await expect(track).toHaveCSS('animation-play-state', 'running');
  await section.getByRole('button', { name: /pause logo scroll/i }).click();
  await expect(track).toHaveCSS('animation-play-state', 'paused');
});

test('hover pauses the track', async ({ page }) => {
  const section = await openHome(page, 'light', 1280);
  const track = section.locator('.logo-marquee__track:visible').first();
  await track.hover();
  await expect(track).toHaveCSS('animation-play-state', 'paused');
});

for (const width of [375, 1280] as const) {
  test(`reduced motion renders a static grid @${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const section = await openHome(page, 'light', width);
    await expect(section.locator('.logo-marquee__track')).toHaveCount(0);
    await expect(section.getByRole('list', { name: 'Supported integrations' }).getByRole('link')).toHaveCount(11);
    await expect(section).toHaveScreenshot(`marquee-reduced-${width}.png`, { maxDiffPixelRatio: 0.02 });
  });
}
