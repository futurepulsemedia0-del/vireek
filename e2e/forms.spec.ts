import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Needs a route that renders <Form> (migrate one real form first, then point FORM_URL at it).
const FORM_URL = process.env.FORM_URL ?? '/signup';

test('form has no axe violations in light and dark', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(FORM_URL);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
  }
});

test('submitting an empty form focuses the first invalid field and exposes the error', async ({ page }) => {
  await page.goto(FORM_URL);
  await page.getByRole('button', { name: /submit|send|create|sign up/i }).click();
  const focused = page.locator(':focus');
  await expect(focused).toHaveAttribute('aria-invalid', 'true');
  await expect(focused).toHaveAttribute('aria-describedby', /.+/);
});

test('tab close is guarded while dirty', async ({ page }) => {
  await page.goto(FORM_URL);
  await page.locator('input:not([type=hidden])').first().fill('x');
  let prompted = false;
  page.on('dialog', async (d) => { prompted = d.type() === 'beforeunload'; await d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  expect(prompted).toBe(true);
});

test('reduced motion: no spinner animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(FORM_URL);
  const anims = await page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'spin').length);
  expect(anims).toBe(0);
});
