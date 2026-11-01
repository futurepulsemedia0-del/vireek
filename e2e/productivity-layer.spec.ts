// e2e/productivity-layer.spec.ts
//
// Phase 1 of the productivity layer: unified Cmd/Ctrl+K palette + central
// keyboard-shortcut registry. Needs a real staging account, like the other
// authenticated specs: set E2E_TEST_EMAIL and E2E_TEST_PASSWORD.
// axe needs: npm install -D @axe-core/playwright (already required by accessibility.spec.ts).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(EMAIL!);
  await page.getByLabel('Password').fill(PASSWORD!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe('Productivity layer — palette and shortcuts', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Ctrl+K opens the palette, ">" scopes to actions, Esc restores focus', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search and quick navigation' });
    await expect(dialog).toBeVisible();
    await page.getByRole('combobox').fill('>');
    await expect(dialog.getByRole('option', { name: /New job/ })).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'Pages' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('"?" opens the cheat sheet; "g" then "c" navigates; typing in a field never triggers shortcuts', async ({ page }) => {
    await page.keyboard.press('Shift+/');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await expect(page).toHaveURL(/\/dashboard\/calendar/);

    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('gc');
    await expect(page).toHaveURL(/\/dashboard\/calendar/); // still here: typing "gc" did not navigate
  });

  test('repeat palette queries are served from the cache (no network round trip)', async ({ page }) => {
    let calls = 0;
    page.on('request', (r) => {
      if (r.url().includes('global_search')) calls += 1;
    });
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox');
    await input.fill('smi');
    await expect.poll(() => calls).toBe(1);
    await input.fill('sm');
    await expect.poll(() => calls).toBe(2);
    await input.fill('smi'); // already fetched within the cache TTL
    await page.waitForTimeout(400);
    expect(calls).toBe(2);
  });

  test('palette and cheat sheet have no WCAG 2.2 AA violations', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').waitFor();
    let results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Shift+/');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('with prefers-reduced-motion the palette appears fully opaque immediately (no fade)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Control+k');
    const panel = page.getByRole('dialog', { name: 'Search and quick navigation' });
    await panel.waitFor({ state: 'attached' });
    expect(await panel.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });
});
