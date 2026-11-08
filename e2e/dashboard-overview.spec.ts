// e2e/dashboard-overview.spec.ts
//
// Overview redesign guard: axe (WCAG 2.2 AA) + "no AI tells" smoke checks + screenshots for the
// visual inventory (light/dark × 3 widths). Needs the same staging account as auth-and-dispatch.spec.ts:
// E2E_TEST_EMAIL / E2E_TEST_PASSWORD. Skipped (not faked) when they are missing.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const WIDTHS = [390, 768, 1280] as const;
const THEMES = ['light', 'dark'] as const;

test.describe('Overview', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(EMAIL!);
    await page.getByLabel('Password').fill(PASSWORD!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/dashboard/);
  });

  test('has no WCAG 2.2 AA violations', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('has no WCAG 2.2 AA violations [dark]', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => { try { localStorage.setItem('vireek-theme', 'dark'); } catch { /* ignore */ } document.documentElement.classList.add('dark'); });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
  
  test('shows no gradients, glass, or large radii on the page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const offenders = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('main *').forEach((el) => {
        const s = getComputedStyle(el);
        if (s.backgroundImage.includes('gradient')) out.push(`gradient: ${el.tagName}.${(el as HTMLElement).className}`);
        if (s.backdropFilter && s.backdropFilter !== 'none') out.push(`backdrop-filter: ${el.tagName}`);
        if (parseFloat(s.borderTopLeftRadius) > 16 && (el as HTMLElement).offsetHeight < 64 && s.borderTopLeftRadius.endsWith('px')) out.push(`radius ${s.borderTopLeftRadius}: ${el.tagName}`);
      });
      return out;
    });
    expect(offenders).toEqual([]);
  });

  test('respects prefers-reduced-motion (no running animations in main)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && (a.effect as KeyframeEffect).target?.closest?.('main')).length);
    expect(running).toBe(0);
  });

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`screenshot ${theme} @${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
        await page.goto('/dashboard');
        await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
        await page.screenshot({ path: info.outputPath(`overview-${theme}-${width}.png`), fullPage: true });
      });
    }
  }
});
