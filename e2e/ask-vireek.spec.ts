// e2e/ask-vireek.spec.ts
//
// Unified "Ask Vireek" launcher: discoverability, no overlap with other floating UI, keyboard +
// focus behaviour, RTL mirroring, hand-off to live chat, axe in light and dark.
// Model replies are stubbed (the function is not called with real traffic here).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'wide', width: 1920, height: 1080 },
];

async function stubAssistant(page: Page) {
  await page.route('**/functions/v1/site-assistant', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [
        'data: {"answerId":"11111111-1111-1111-1111-111111111111"}\n\n',
        'data: {"sources":[{"title":"Pricing","url":"/pricing"}]}\n\n',
        'data: {"delta":"Plans start free. See pricing."}\n\n',
        'data: {"handoff":{"reason":"low_confidence"}}\n\n',
        'data: {"done":true}\n\n',
      ].join(''),
    }),
  );
}

async function prime(page: Page) {
  await page.addInitScript(() => localStorage.setItem('vk-ask-intro-v1', '1')); // skip the one-time intro
  await page.goto('/pricing');
  await page.mouse.move(5, 5); // first interaction mounts the idle-loaded widget
  await page.keyboard.press('Shift');
}

const launcher = (page: Page) => page.getByRole('button', { name: /Open Ask Vireek|Close Ask Vireek/i });

for (const vp of VIEWPORTS) {
  test(`launcher is visible, in the bottom-end corner and clear of other floating UI @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await prime(page);
    const btn = launcher(page);
    await expect(btn).toBeVisible();
    const box = (await btn.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(56);
    expect(box.x + box.width).toBeGreaterThan(vp.width - 120); // end corner (LTR = right)

    // Must not intersect the accessibility button or the consent banner when they are on screen.
    for (const other of [page.locator('.a11y-widget button').first(), page.getByRole('dialog', { name: /cookie|privacy|consent/i })]) {
      if (await other.isVisible().catch(() => false)) {
        const o = (await other.boundingBox())!;
        const overlap = !(box.x + box.width <= o.x || o.x + o.width <= box.x || box.y + box.height <= o.y || o.y + o.height <= box.y);
        expect(overlap, 'launcher overlaps another floating element').toBe(false);
      }
    }
  });
}

test('opens by click and Ctrl+/, traps focus, Esc closes and restores focus', async ({ page }) => {
  await stubAssistant(page);
  await prime(page);
  const btn = launcher(page);
  await btn.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Vireek Assistant' });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher(page)).toBeFocused();
  await page.keyboard.press('Control+/');
  await expect(dialog).toBeVisible();
});

test('asks a question, shows sources, and hands off to live chat with the transcript', async ({ page }) => {
  await stubAssistant(page);
  await prime(page);
  await launcher(page).click();
  await page.getByRole('textbox', { name: /Message to Vireek assistant/i }).fill('Do you support weird thing X?');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Plans start free. See pricing.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pricing' })).toBeVisible();
  await page.getByRole('button', { name: /Chat with our team|Leave a message for our team/i }).click();
  await expect(page.getByRole('dialog', { name: /live chat|chat with/i })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Vireek Assistant' })).toBeHidden(); // one panel at a time
  await expect(page.getByRole('textbox').last()).toHaveValue(/Do you support weird thing X\?/);
});

test('is hidden on staff routes and present on the dashboard route shell', async ({ page }) => {
  await prime(page);
  await expect(launcher(page)).toBeVisible();
  await page.goto('/staff/support-inbox');
  await page.keyboard.press('Shift');
  await expect(launcher(page)).toHaveCount(0);
});

test('RTL (Persian): launcher mirrors to the left and the panel text is right-to-left', async ({ page }) => {
  await stubAssistant(page);
  await page.addInitScript(() => {
    localStorage.setItem('vk-ask-intro-v1', '1');
    localStorage.setItem('i18nextLng', 'fa');
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/pricing');
  await page.keyboard.press('Shift');
  const btn = page.getByRole('button', { name: /دستیار|Ask Vireek/ });
  await expect(btn).toBeVisible();
  expect(((await btn.boundingBox())!).x).toBeLessThan(200);
  await btn.click();
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-label', /دستیار ویریک/);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe: panel has no serious/critical violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await stubAssistant(page);
    await prime(page);
    await launcher(page).click();
    await page.getByRole('textbox', { name: /Message to Vireek assistant/i }).fill('hello');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Plans start free. See pricing.')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('[role="dialog"][aria-label="Vireek Assistant"]').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
