// e2e/voice-resilience.a11y.spec.ts
// NOT RUN in the authoring environment (no @playwright/test / @axe-core/playwright install, no app server, no login fixture).
// Requires: a signed-in owner session saved by your existing auth setup, and `supabase.functions` reachable or routed below.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const STATUS = { org: null, platform_level: 2, since: new Date().toISOString(), recent_fallback_calls: [], checks: [] };

test.beforeEach(async ({ page }) => {
  // Deterministic backend: the admin function is stubbed, no real call or vendor is touched.
  await page.route('**/functions/v1/voice-resilience-admin', async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    const json = body.action === 'status' ? STATUS
      : body.action === 'wizard_plan' ? { warning: 'Confirm with your carrier.', codes: [{ kind: 'no_answer', activate: '**61*+14155552671**20#', cancel: '##61#', status: '*#61#', confidence: 'standard', note: '' }] }
      : body.action === 'wizard_start' ? { check_id: 'c1', instruction: 'x' }
      : body.action === 'wizard_status' ? { status: 'passed', kind: 'forward_on', outbound_status: 'completed' }
      : { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
});

for (const theme of ['light', 'dark'] as const) {
  test(`voice resilience has no WCAG 2.2 AA violations (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/dashboard/voice-resilience');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const name of [/status/i, /backup handling/i, /carrier safety net/i]) {
      await page.getByRole('tab', { name }).click();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(r.violations, JSON.stringify(r.violations, null, 2)).toEqual([]);
    }
  });
}

test('tabs are keyboard operable (arrow keys, roving tabindex)', async ({ page }) => {
  await page.goto('/dashboard/voice-resilience');
  const first = page.getByRole('tab', { name: /status/i });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /backup handling/i })).toBeFocused();
  await expect(page.getByRole('tab', { name: /backup handling/i })).toHaveAttribute('aria-selected', 'true');
});

test('wizard: result is announced through the status live region', async ({ page }) => {
  await page.goto('/dashboard/voice-resilience');
  await page.getByRole('tab', { name: /carrier safety net/i }).click();
  await page.getByLabel(/your business line/i).fill('+14155550100');
  await page.getByRole('button', { name: /test forwarding is on/i }).click();
  await expect(page.getByRole('status').filter({ hasText: /forwarding works/i })).toBeVisible({ timeout: 15_000 });
});
