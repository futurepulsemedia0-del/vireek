// e2e/typography.spec.ts
//
// Typography gate in a real browser, on real routes:
//   • no rendered text below 12px (SVG text measured at its on-screen scale) at phone + desktop widths
//   • text-only zoom to 200% via the app's own --a11y-font-scale, and an enlarged OS font via --native-font-scale
//   • WCAG 1.4.12 text-spacing overrides cause no clipped text
//   • no page-level horizontal overflow at 200% text and at 320px (1.4.10 reflow)
//
// Public routes always run. The ten densest authenticated screens (the former heavy users of text-[Npx]) need the staging account
// (E2E_TEST_EMAIL / E2E_TEST_PASSWORD) and are SKIPPED, never faked, when it is missing — same as dashboard-overview.spec.ts.
// Component-level coverage that needs no backend: `npm run type:browser`.
import { test, expect, type Page } from '@playwright/test';
import { findSmallText } from '../src/lib/typeAudit';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

const PUBLIC = ['/', '/pricing', '/login', '/accessibility-statement', '/press', '/brand', '/partners'];
const DENSEST = [
  '/dashboard/supplier-intelligence',
  '/dashboard/permit-intelligence',
  '/dashboard/operations-sandbox',
  '/dashboard/revenue-protection',
  '/dashboard/financing',
  '/dashboard/trade-playbooks',
  '/dashboard/pricing-flywheel',
  '/dashboard/adaptive-diagnostics',
  '/dashboard/ai-reliability',
  '/dashboard/operations-center',
];

const SPACING_CSS = '*{line-height:1.5 !important;letter-spacing:0.12em !important;word-spacing:0.16em !important} p{margin-bottom:2em !important}';

const small = (page: Page) => page.evaluate(`(${findSmallText.toString()})(document, 12)`) as Promise<{ selector: string; px: number; text: string }[]>;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const clipped = (page: Page) =>
  page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !(el.textContent ?? '').trim()) continue;
      const x = ['hidden', 'clip'].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis';
      const y = ['hidden', 'clip'].includes(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (x || y) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`);
    }
    return bad.slice(0, 8);
  });
const fmt = (hits: { selector: string; px: number; text: string }[]) => hits.slice(0, 6).map((h) => `${h.selector} ${h.px}px "${h.text}"`).join('\n');

async function audit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');

  expect(await small(page), `text < 12px at default size on ${path}`).toEqual([]);

  await page.evaluate(() => document.documentElement.style.setProperty('--a11y-font-scale', '2'));
  await page.waitForTimeout(400);
  const hits200 = await small(page);
  expect(hits200, fmt(hits200)).toEqual([]);
  expect(await overflow(page), `page-level horizontal overflow at 200% text on ${path}`).toBeLessThanOrEqual(1);
  await page.evaluate(() => document.documentElement.style.removeProperty('--a11y-font-scale'));

  await page.evaluate(() => document.documentElement.style.setProperty('--native-font-scale', '1.5'));
  await page.waitForTimeout(300);
  expect(await small(page), `text < 12px with enlarged OS font on ${path}`).toEqual([]);
  await page.evaluate(() => document.documentElement.style.removeProperty('--native-font-scale'));

  await page.addStyleTag({ content: SPACING_CSS });
  await page.waitForTimeout(300);
  expect(await clipped(page), `clipped text under WCAG 1.4.12 spacing on ${path}`).toEqual([]);
}

for (const width of [390, 1280]) {
  test.describe(`public routes @${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const path of PUBLIC) test(`${path} — text floor, 200% text, enlarged OS font, 1.4.12 spacing`, async ({ page }) => audit(page, path));
  });
}

test.describe('reflow @320px (WCAG 1.4.10)', () => {
  test.use({ viewport: { width: 320, height: 800 } });
  for (const path of PUBLIC) {
    test(`${path} has no horizontal page scroll and no text < 12px`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      expect(await small(page)).toEqual([]);
    });
  }
});

test.describe('densest authenticated screens', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated typography checks.');
  for (const width of [390, 1280]) {
    test.describe(`@${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });
      test.beforeEach(async ({ page }) => {
        await page.goto('/login');
        await page.getByLabel('Email address').fill(EMAIL!);
        await page.getByLabel('Password').fill(PASSWORD!);
        await page.getByRole('button', { name: 'Sign In' }).click();
        await page.waitForURL(/\/dashboard/);
      });
      for (const path of DENSEST) test(`${path}`, async ({ page }) => audit(page, path));
    });
  }
});
