// e2e/exit-ready.spec.ts — Exit-Ready evidence, multiples and staged buyer room: states, honesty, a11y, keyboard.
// NOT RUN in the authoring environment (no browser/back end available). Run: npx playwright test e2e/exit-ready.spec.ts
// RPCs are intercepted with page.route AFTER mockSupabase so they take precedence (Playwright runs the latest route first).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PROFILE, SUPABASE_URL, mockSupabase, signIn, type Tables } from './helpers/mockSupabase';

const H = 'a'.repeat(64);
const asOf = '2028-02-01T00:00:00Z';
const fact = (key: string, label: string, value: Record<string, unknown>, count: number) => ({
  id: `f-${key}`, metric_key: key, label, value, as_of: asOf, logic_version: 'exit_ready.v1', logic_text: `logic ${key}`, source_table: 'ar_invoices', source_count: count, content_hash: H,
});
const metrics = {
  generatedAt: asOf, ledgerMonths: 12,
  financials: { revenueCents: 300_000_000, expensesCents: 250_000_000, interestCents: 0, taxCents: 0, daCents: 0, monthly: [] },
  recurringShare: 0.1, recurringAnnualCents: 30_000_000, concentration: { top1: 0.1, top5: 0.3, customers: 40 },
  workforce: { headcount: 5, avgTenureYears: 2, turnoverRate: 0.2 }, ownerDependence: { revenueShare: 0.4 }, dso: 40, arOpenCents: 1,
  margin: { overall: 0.4, coveragePct: 0.9, byService: [] }, documentation: { published: 5, categories: 3, ackRate: 0.8 },
  compliance: { credentialsTotal: 3, credentialsValid: 2, credentialsExpiring: 0, credentialsExpired: 1, insuranceTotal: 1, insuranceValid: 1, hasGeneralLiability: true },
};
const run = {
  id: 'r1', as_of: asOf, logic_version: 'exit_ready.v1', run_hash: H, created_at: asOf,
  reconciliation: [{ key: 'invoiced_vs_gl_revenue', label: 'Invoiced revenue vs general-ledger revenue', leftLabel: 'Invoices', leftCents: 100000, rightLabel: 'Ledger', rightCents: 90000, diffCents: 10000, toleranceCents: 500, status: 'difference', note: 'Timing can explain this.' }],
};
const facts = [
  fact('revenue_invoiced_12m', 'Invoiced revenue, last 12 months', { subtotalCents: 300_000_000, invoices: 120 }, 120),
  fact('compliance', 'Compliance cleanliness', { credentialsExpired: 1, documentsExpired: 0, permitsLapsed: 0, rescissionTracked: false }, 4),
];

async function open(page: Page, tables: Tables = {}) {
  await signIn(page);
  await mockSupabase(page, { tables: { profiles: [PROFILE], team_members: [], ...tables } });
  const rpc = (name: string, body: unknown) => page.route(`${SUPABASE_URL}/rest/v1/rpc/${name}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await rpc('exit_get_metrics', metrics);
  await rpc('exit_data_quality_score', 80);
  await page.route(`${SUPABASE_URL}/rest/v1/exit_lineage_runs*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([run]) }));
  await page.route(`${SUPABASE_URL}/rest/v1/exit_lineage_facts*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facts) }));
  await page.goto('/dashboard/exit-readiness');
}

test.describe('Exit-Ready evidence tab', () => {
  test('shows figures with lineage, reconciliation differences and a fix link, and passes axe', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Evidence' }).click();
    await expect(page.getByRole('heading', { name: 'Evidence and lineage' })).toBeVisible();
    await expect(page.getByText('Invoiced revenue, last 12 months')).toBeVisible();
    await expect(page.getByText('Difference', { exact: true }).first()).toBeVisible(); // a difference is shown, not hidden
    await expect(page.getByRole('link', { name: /Fix:/ }).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('details disclose logic, source count and hash; keyboard operable', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Evidence' }).click();
    const btn = page.getByRole('button', { name: 'How computed' }).first();
    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(H).first()).toBeVisible();
    await expect(page.getByText('logic revenue_invoiced_12m')).toBeVisible();
  });

  test('says the estimate is not a valuation on every new tab', async ({ page }) => {
    await open(page);
    for (const name of ['Evidence', 'Multiples', 'Secure sharing']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByText(/not a valuation/i).first()).toBeVisible();
    }
  });

  test('multiples form requires a source and a date and flags the placeholder as illustrative', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Multiples' }).click();
    await expect(page.getByText('Illustrative').first()).toBeVisible();
    await page.getByRole('button', { name: 'Save multiple' }).click();
    await expect(page.getByText(/Name the source/)).toBeVisible();
    await expect(page.getByText(/date the figure was published/)).toBeVisible();
  });
});

test.describe('buyer staged room', () => {
  const room = (over: Record<string, unknown>) => ({
    mode: 'staged', label: 'Buyer A', expiresAt: '2099-01-01T00:00:00Z', viewsRemaining: 4, stage: 'teaser', stageCeiling: 'nda', ndaRequired: true,
    ndaText: 'This is the NDA text approved by counsel. '.repeat(3), viewOnly: true, watermark: 'Acme | abcd | 2028-02-01',
    content: { teaser: { revenueBand: '$1M-$2.5M', jobsCompleted12mBand: '500-2,000', hasRecurringRevenue: true } }, documents: [], questions: [], ...over,
  });

  test('teaser shows banded data only, requires the NDA, then reveals aggregated figures without customer data', async ({ page }) => {
    let accepted = false;
    await page.route(`${SUPABASE_URL}/functions/v1/exit-dataroom-public`, async (r) => {
      const body = r.request().postDataJSON() as { action?: string };
      const payload = body.action === 'accept_nda' ? (accepted = true, { outcome: 'accepted' })
        : accepted ? room({ stage: 'nda', ndaRequired: false, ndaText: null, content: { teaser: {}, nda: { facts: { revenue_invoiced_12m: { label: 'Invoiced revenue', value: { subtotalCents: 150000 }, asOf, sourceCount: 2, hash: H } }, reconciliation: [], addBacks: [] } } })
        : room({});
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.goto(`/data-room#${'t'.repeat(43)}`);
    await expect(page.getByText('$1M-$2.5M')).toBeVisible();
    await expect(page.getByText('Verified figures')).toHaveCount(0);
    await page.getByLabel('Your full name').fill('Jane Doe');
    await page.getByLabel('Your email').fill('jane@example.com');
    await page.getByLabel('I have read and agree to this NDA').check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page.getByText('Verified figures')).toBeVisible();
    await expect(page.getByText(/Customer|@example/)).toHaveCount(0);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('an unusable link reveals nothing about why', async ({ page }) => {
    await page.route(`${SUPABASE_URL}/functions/v1/exit-dataroom-public`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"UNAVAILABLE"}' }));
    await page.goto(`/data-room#${'t'.repeat(43)}`);
    await expect(page.getByText('This link is no longer available')).toBeVisible();
  });

  test('reduced motion: no spinning loaders', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await page.getByRole('tab', { name: 'Evidence' }).click();
    const animated = await page.evaluate(() => Array.from(document.querySelectorAll('.animate-spin')).filter((el) => getComputedStyle(el).animationName !== 'none').length);
    expect(animated).toBe(0);
  });
});
