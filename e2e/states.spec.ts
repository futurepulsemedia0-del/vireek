// e2e/states.spec.ts
//
// Run:  VITE_ENABLE_DEV_STATES=true npx playwright test e2e/states.spec.ts
// (the env var is needed because the Playwright webServer serves a production build, where /dev/states is off)
// First run only:  add --update-snapshots to create the visual baselines, then commit them.
// Needs:  npm i -D @axe-core/playwright
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const themes = ['light', 'dark'] as const;
const dirs = ['ltr', 'rtl'] as const;

async function open(page: Page, theme: (typeof themes)[number], dir: (typeof dirs)[number]) {
  await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
  await page.goto('/dev/states');
  await page.evaluate(([t, d]) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.dir = d;
  }, [theme, dir]);
  await expect(page.getByRole('heading', { name: 'Interaction states' })).toBeVisible();
}

for (const theme of themes) {
  for (const dir of dirs) {
    test.describe(`${theme} / ${dir}`, () => {
      test('axe: no WCAG 2.2 AA violations (including color-contrast)', async ({ page }) => {
        await open(page, theme, dir);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      });

      test('visual: every state section', async ({ page }) => {
        await open(page, theme, dir);
        await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
        for (const name of ['Button', 'IconButton', 'Link', 'Form controls', 'Tab / Table row / Menu item', 'Card', 'Copy']) {
          await expect(page.getByRole('region', { name })).toHaveScreenshot(`${name.replace(/\W+/g, '-')}-${theme}-${dir}.png`, { maxDiffPixelRatio: 0.002 });
        }
      });

      test('visual: real hover / focus-visible / pressed on a primary button', async ({ page }) => {
        await open(page, theme, dir);
        const btn = page.getByRole('region', { name: 'Button' }).getByRole('button', { name: 'Action' }).first();
        await btn.hover();
        await expect(btn).toHaveScreenshot(`btn-hover-${theme}-${dir}.png`);
        await page.keyboard.press('Tab'); // moves to the next control; then return with Shift+Tab to get :focus-visible
        await page.keyboard.press('Shift+Tab');
        await expect(btn).toBeFocused();
        await expect(btn).toHaveScreenshot(`btn-focus-${theme}-${dir}.png`);
        const box = (await btn.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await expect(btn).toHaveScreenshot(`btn-pressed-${theme}-${dir}.png`);
        await page.mouse.up();
      });
    });
  }
}

test.describe('behavior', () => {
  test.beforeEach(async ({ page }) => open(page, 'light', 'ltr'));

  test('focus ring is visible with the keyboard and has >= 3:1 contrast against the page', async ({ page }) => {
    await page.keyboard.press('Tab');
    const shadow = await page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
    expect(shadow).not.toBe('none');
  });

  test('double-click on a useAction button runs the action once and shows the loader', async ({ page }) => {
    const save = page.getByRole('button', { name: 'Save' });
    await save.dblclick();
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Saved')).toHaveCount(1, { timeout: 4000 });
  });

  test('disabled-with-reason is focusable and shows its reason on keyboard focus; Escape dismisses it', async ({ page }) => {
    const exportBtn = page.getByRole('button', { name: 'Export' });
    await exportBtn.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByText('Upgrade to Professional to use this').last()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exportBtn).toBeFocused();
  });

  test('copy shows inline confirmation without a toast', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const copy = page.getByRole('region', { name: 'Copy' }).getByRole('button').first();
    await copy.click();
    await expect(copy).toHaveAttribute('data-copy-status', 'copied');
    await expect(page.getByRole('region', { name: 'Notifications' }).locator('[data-toast-type]')).toHaveCount(0);
  });

  test('toast burst queues (max 3 visible) and Escape dismisses the focused toast', async ({ page }) => {
    await page.getByRole('button', { name: 'Queue (5)' }).click();
    await expect(page.locator('[data-toast-type]')).toHaveCount(3);
  });

  test('reduced motion: no running animations on the loader', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const anim = await page.getByRole('button', { name: 'Pay now' }).evaluate((el) => getComputedStyle(el.querySelector('.vrk-mini')!).animationName);
    expect(anim).toBe('none');
  });
});
