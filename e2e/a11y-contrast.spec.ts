// e2e/a11y-contrast.spec.ts — axe `color-contrast` on 25 routes × light + dark (WCAG 1.4.3).
// Complements the static guard (`npm run lint:design`): axe sees what static analysis cannot — ancestor backgrounds,
// gradients, overlays, computed opacity. Dashboard routes run against mocked Supabase (empty-state data), so rows/tables
// with real data are NOT covered here; run e2e/dashboard-overview.spec.ts with E2E_TEST_EMAIL for staging data.
// ASSUMPTION: this list is the 25 routes of the public site + core dashboard, not analytics-ranked. Replace with your real top 25.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PROFILE, mockSupabase, signIn } from './helpers/mockSupabase';

const PUBLIC_ROUTES = ['/', '/pricing', '/login', '/about', '/contact', '/blog', '/calculator', '/compare', '/customers', '/changelog', '/brand', '/accessibility-statement'] as const;
const DASHBOARD_ROUTES = ['/dashboard', '/dashboard/jobs', '/dashboard/customers', '/dashboard/calls', '/dashboard/leads', '/dashboard/team', '/dashboard/inventory', '/dashboard/settings', '/dashboard/analytics', '/dashboard/billing', '/dashboard/quotes', '/dashboard/reviews', '/dashboard/inbox'] as const;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

async function prepare(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => { try { localStorage.setItem('vireek-theme', t); } catch { /* storage unavailable */ } }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

async function contrastScan(page: Page): Promise<{ lines: string[]; incomplete: number }> {
  const r = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const lines = r.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? v.help}`));
  const incomplete = r.incomplete.filter((i) => i.id === 'color-contrast').reduce((n, i) => n + i.nodes.length, 0);
  return { lines, incomplete };
}

async function expectNoContrastViolations(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main, [role="main"]').first()).toBeVisible();
  const { lines, incomplete } = await contrastScan(page);
  if (incomplete) test.info().annotations.push({ type: 'axe-incomplete', description: `${incomplete} node(s) axe could not evaluate (gradient/image/overlap) — review manually` });
  expect(lines, lines.join('\n')).toEqual([]);
}

for (const theme of THEMES) {
  test.describe(`public [${theme}]`, () => {
    for (const route of PUBLIC_ROUTES) {
      test(`${route} has no colour-contrast violations`, async ({ page }) => {
        await prepare(page, theme);
        await page.goto(route);
        await expectNoContrastViolations(page);
      });
    }
  });
  test.describe(`dashboard [${theme}]`, () => {
    for (const route of DASHBOARD_ROUTES) {
      test(`${route} has no colour-contrast violations`, async ({ page }) => {
        await signIn(page);
        await mockSupabase(page, { tables: { profiles: [PROFILE], team_members: [] } });
        await prepare(page, theme);
        await page.goto(route);
        await expectNoContrastViolations(page);
      });
    }
  });
}
