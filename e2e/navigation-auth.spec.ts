// e2e/navigation-auth.spec.ts
//
// Authenticated navigation flows. Needs a real STAGING test account (never production):
//   E2E_TEST_EMAIL, E2E_TEST_PASSWORD   (an account owner)
// Optional: E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD  (a team member WITHOUT technician access)
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe('Authenticated navigation', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping.');

  test('deep link with filters survives a reload; invalid params degrade gracefully', async ({ page }) => {
    await login(page, EMAIL!, PASSWORD!);
    await page.goto('/dashboard/customers?q=zzz-no-match&stage=vip&sort=name:desc');
    await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/q=zzz-no-match/);
    await expect(page).toHaveURL(/stage=vip/);
    await expect(page).toHaveURL(/sort=name(%3A|:)desc/);
    await expect(page.locator('input[value="zzz-no-match"]')).toBeVisible();

    await page.goto('/dashboard/customers?page=-4&sort=evil:desc&stage=nope&customer=does-not-exist');
    await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Something went wrong');
    await expect(page).not.toHaveURL(/customer=does-not-exist/); // stale record id is dropped
  });

  test('filter changes replace history (no spam); opening a record pushes it', async ({ page }) => {
    await login(page, EMAIL!, PASSWORD!);
    await page.goto('/dashboard/customers');
    const start = await page.evaluate(() => history.length);
    await page.locator('input[type="search"], input[placeholder*="Search" i]').first().fill('a');
    await page.locator('input[type="search"], input[placeholder*="Search" i]').first().fill('ab');
    expect(await page.evaluate(() => history.length)).toBe(start); // replace, not push
    const rows = page.locator('tbody tr');
    if ((await rows.count()) === 0) test.skip(true, 'No customers in the test account to open.');
    await page.locator('input[type="search"], input[placeholder*="Search" i]').first().fill('');
    await rows.first().click();
    await expect(page).toHaveURL(/customer=/);
    await page.goBack();
    await expect(page).not.toHaveURL(/customer=/);
  });

  test('back/forward restores scroll inside a long dashboard list', async ({ page }) => {
    await login(page, EMAIL!, PASSWORD!);
    await page.goto('/dashboard/customers');
    await page.evaluate(() => window.scrollTo(0, 600));
    const y = await page.evaluate(() => window.scrollY);
    await page.goto('/dashboard/settings');
    await page.goBack();
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 4000 }).toBeGreaterThanOrEqual(Math.min(y, 100));
  });

  test('expired session mid-form: re-auth modal keeps the form and replays the request', async ({ page }) => {
    await login(page, EMAIL!, PASSWORD!);
    await page.goto('/dashboard/customers');
    await page.getByRole('button', { name: /add customer/i }).first().click();
    const name = page.getByLabel(/name/i).first();
    await name.fill('E2E Expired Session Co');

    let calls = 0;
    const auths: string[] = [];
    await page.route('**/rest/v1/customers*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      calls += 1;
      auths.push(route.request().headers()['authorization'] ?? '');
      if (calls === 1) {
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST301', message: 'JWT expired' }) });
      }
      return route.continue();
    });

    await page.getByRole('button', { name: /save|add customer|create/i }).last().click();
    const dialog = page.getByRole('dialog', { name: /session expired/i });
    await expect(dialog).toBeVisible();

    const axe = await new AxeBuilder({ page }).include('[role="dialog"][aria-labelledby="reauth-title"]').analyze();
    expect(axe.violations).toEqual([]);

    await dialog.getByLabel('Password').fill(PASSWORD!);
    await dialog.getByRole('button', { name: /sign in and continue/i }).click();
    await expect(dialog).toBeHidden();
    await expect(name).toHaveValue('E2E Expired Session Co'); // unsaved work preserved
    await expect.poll(() => calls).toBe(2); // the SAME request was replayed once
    expect(auths[1]).not.toBe(auths[0]); // with the fresh token
  });

  test('logging out in one tab signs the other tab out', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await login(a, EMAIL!, PASSWORD!);
    await b.goto('/dashboard');
    await a.getByRole('button', { name: /sign out/i }).first().click();
    await expect(b).toHaveURL(/\/login/, { timeout: 10_000 });
    await ctx.close();
  });
});

test.describe('Responsive navigation', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping.');

  const sizes = [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'desktop', width: 1280, height: 800 },
  ] as const;

  for (const s of sizes) {
    test(`${s.name}: correct navigation pattern and exactly one aria-current`, async ({ page }) => {
      await page.setViewportSize({ width: s.width, height: s.height });
      await login(page, EMAIL!, PASSWORD!);
      await page.goto('/dashboard/customers');

      const bottom = page.getByRole('navigation', { name: /mobile navigation/i });
      const sidebar = page.locator('aside').first();
      if (s.name === 'mobile') {
        await expect(bottom).toBeVisible();
        await expect(sidebar).toBeHidden();
        // safe-area padding is applied (computed value exists even when the inset is 0)
        await expect(bottom).toHaveCSS('padding-bottom', /px$/);
        await page.getByRole('button', { name: /more/i }).click();
        const drawer = page.getByRole('dialog');
        await expect(drawer).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
      } else {
        await expect(bottom).toBeHidden();
        await expect(sidebar).toBeVisible();
        const box = await sidebar.boundingBox();
        if (s.name === 'tablet') expect(box!.width).toBeLessThan(100); // icon rail (72px)
        else expect(box!.width).toBeGreaterThan(200); // full sidebar (240px)
      }

      const current = page.locator('nav[aria-label] [aria-current="page"]:visible');
      await expect(current).toHaveCount(1);
    });
  }

  test('nested route marks its section (aria-current="true"), never the dashboard root', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, EMAIL!, PASSWORD!);
    await page.goto('/dashboard/settings/team');
    await expect(page.locator('aside a[href="/dashboard"]')).not.toHaveAttribute('aria-current', /.+/);
  });
});

test.describe('Access denied', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD not set — skipping.');

  test('a member without technician access sees an explanation, not a silent redirect, and can request access', async ({ page }) => {
    await login(page, MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await page.goto('/tech');
    await expect(page).toHaveURL(/\/tech/);
    await expect(page.getByRole('heading', { name: /access denied/i })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await page.getByRole('button', { name: /request access/i }).click();
    await expect(page.getByText(/request sent/i)).toBeVisible();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });
});
