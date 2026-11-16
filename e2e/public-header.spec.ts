import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Theme = 'light' | 'dark';

async function prepare(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    try { localStorage.setItem('vireek-theme', t); } catch { /* storage unavailable */ }
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
}

test.describe('public header — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('renders landmark, logo, sign-in and one primary CTA; no theme toggle', async ({ page }) => {
    await prepare(page, 'light');
    await page.goto('/');
    const header = page.locator('header').first();
    await expect(header).toBeVisible();
    await expect(header.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(header.getByRole('link', { name: /vireek home/i })).toHaveAttribute('href', '/');
    await expect(header.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    await expect(header.getByRole('link', { name: 'Start Free Trial' })).toHaveAttribute('href', '/signup');
    await expect(header.getByRole('button', { name: /theme/i })).toHaveCount(0);
    expect((await header.boundingBox())?.height).toBeGreaterThanOrEqual(64);
  });

  test('mega-menu opens on hover and closes when the pointer leaves', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header').first();
    const trigger = header.getByRole('button', { name: 'Product' });
    await trigger.hover();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(header.getByRole('group', { name: 'Product' })).toBeVisible();
    await page.mouse.move(640, 700);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(header.getByRole('group', { name: 'Product' })).toBeHidden();
  });

  test('click toggles; outside click closes', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header').first();
    const trigger = header.getByRole('button', { name: 'Resources' });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await page.mouse.click(40, 600);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('keyboard: Enter opens, arrows move, Esc closes and returns focus', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header').first();
    const trigger = header.getByRole('button', { name: 'Product' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const panel = header.getByRole('group', { name: 'Product' });
    await expect(panel).toBeVisible();
    const links = panel.locator('[data-nav-item]');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(links.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('route change closes the menu and marks the active link', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header').first();
    await header.getByRole('button', { name: 'Resources' }).click();
    await header.getByRole('group', { name: 'Resources' }).getByRole('link', { name: 'FAQ' }).click();
    await expect(page).toHaveURL(/\/faq$/);
    await expect(header.getByRole('button', { name: 'Resources' })).toHaveAttribute('aria-expanded', 'false');
    await page.goto('/pricing');
    await expect(header.getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page');
  });

  test('transparent at top, surface after 8px of scroll', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header').first();
    await expect(header).toHaveAttribute('data-scrolled', 'false');
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(header).toHaveAttribute('data-scrolled', 'true');
  });
});

test.describe('public header — mobile drawer', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('opens, traps focus, scroll-locks, closes with Esc and restores focus', async ({ page }) => {
    await page.goto('/');
    const burger = page.locator('header').getByRole('button', { name: 'Open menu' });
    const box = await burger.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('header nav')).toBeHidden();

    await burger.click();
    const dialog = page.getByRole('dialog', { name: 'Site menu' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const el = document.activeElement;
        return !!el && (!!el.closest('[role="dialog"]') || el.getAttribute('aria-controls') !== null);
      });
      expect(inside).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('header').getByRole('button', { name: 'Open menu' })).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  });

  test('accordion expands and a link closes the drawer', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').getByRole('button', { name: 'Open menu' }).click();
    const dialog = page.getByRole('dialog', { name: 'Site menu' });
    await dialog.getByRole('button', { name: 'Resources' }).click();
    await dialog.getByRole('link', { name: 'FAQ' }).click();
    await expect(page).toHaveURL(/\/faq$/);
    await expect(dialog).toBeHidden();
  });
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`public header axe [${theme}]`, () => {
    test('desktop with open mega-menu', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await prepare(page, theme);
      await page.goto('/');
      await page.locator('header').getByRole('button', { name: 'Product' }).click();
      const result = await new AxeBuilder({ page }).include('header').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(result.violations).toEqual([]);
    });

    test('mobile drawer', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await prepare(page, theme);
      await page.goto('/');
      await page.locator('header').getByRole('button', { name: 'Open menu' }).click();
      const result = await new AxeBuilder({ page })
        .include('header')
        .include('[role="dialog"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
        .analyze();
      expect(result.violations).toEqual([]);
    });
  });
}

for (const dir of ['ltr', 'rtl'] as const) {
  for (const width of [375, 768, 1024, 1280, 1920]) {
    test(`no horizontal overflow at ${width}px [${dir}]`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.evaluate((d) => { document.documentElement.dir = d; }, dir);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}
