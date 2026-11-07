// e2e/layering.spec.ts — real stacking on the public site (cookie banner vs. sticky header vs. mobile bars), desktop + mobile.
// Run:  npx playwright test e2e/layering.spec.ts     First run: add --update-snapshots, then commit the baselines.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
// @ts-expect-error — plain .mjs shared with the Tailwind config
import { Z_LAYERS } from '../scripts/design/layout-tokens.mjs';

const layers = Z_LAYERS as Record<string, number>;
const viewports = [
  { name: 'desktop', size: { width: 1280, height: 800 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
] as const;

/** True when the element is what the user actually hits at its own centre (i.e. nothing covers it). */
async function isOnTop(page: Page, loc: Locator): Promise<boolean> {
  const box = await loc.boundingBox();
  if (!box) return false;
  return loc.evaluate((el, p) => {
    const hit = document.elementFromPoint(p.x, p.y);
    return !!hit && (el === hit || el.contains(hit));
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}
const zOf = (loc: Locator) => loc.evaluate((el) => Number(getComputedStyle(el).zIndex));

for (const vp of viewports) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${vp.name} / ${theme}`, () => {
      test.use({ viewport: vp.size });

      test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
        await page.goto('/');
        await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      });

      test('cookie banner sits on the banner layer and is never covered', async ({ page }) => {
        const banner = page.getByRole('dialog', { name: /cookie/i });
        await expect(banner).toBeVisible();
        expect(await zOf(banner)).toBe(layers.banner);
        expect(await isOnTop(page, banner)).toBe(true);
      });

      test('cookie banner stays above the sticky header after scrolling', async ({ page }) => {
        const banner = page.getByRole('dialog', { name: /cookie/i });
        await expect(banner).toBeVisible();
        await page.mouse.wheel(0, 1500);
        await page.waitForTimeout(300);
        const header = page.locator('header').first();
        expect(await zOf(header)).toBeLessThanOrEqual(layers.sticky);
        expect(await zOf(banner)).toBeGreaterThan(await zOf(header));
        expect(await isOnTop(page, banner)).toBe(true);
      });

      test('no element uses a numeric z-index outside the named scale', async ({ page }) => {
        const allowed = new Set(Object.values(layers));
        const bad = await page.evaluate((ok) => {
          const set = new Set<number>(ok);
          return [...document.querySelectorAll<HTMLElement>('body *')]
            .map((el) => ({ el, z: getComputedStyle(el).zIndex }))
            .filter(({ z }) => z !== 'auto' && !set.has(Number(z)))
            .slice(0, 10)
            .map(({ el, z }) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} z=${z}`);
        }, [...allowed]);
        expect(bad).toEqual([]);
      });

      test('axe: no WCAG 2.2 AA violations with the banner open', async ({ page }) => {
        await expect(page.getByRole('dialog', { name: /cookie/i })).toBeVisible();
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      });

      test('visual: stacked banner over header', async ({ page }) => {
        await expect(page.getByRole('dialog', { name: /cookie/i })).toBeVisible();
        await expect(page).toHaveScreenshot(`layering-${vp.name}-${theme}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.01 });
      });
    });
  }
}
