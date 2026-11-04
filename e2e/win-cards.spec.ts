// Playwright. NOT RUN in the authoring sandbox (no browser / network). Needs a seeded approved card token in WIN_CARD_TEST_TOKEN
// and an expired/revoked one in WIN_CARD_DEAD_TOKEN. Snapshots are created on first run: `npx playwright test e2e/win-cards.spec.ts --update-snapshots`.
import { expect, test } from '@playwright/test';

const OK = process.env.WIN_CARD_TEST_TOKEN ?? '';
const DEAD = process.env.WIN_CARD_DEAD_TOKEN ?? '';
const LEAKS = [/\b\d{3}[-. )]+\d{3}[-. ]\d{4}\b/, /@[a-z0-9.-]+\.[a-z]{2,}/i, /\b\d{1,2}:\d{2}\s?(am|pm)?\b/i];

test.describe('public win card', () => {
  test.skip(!OK, 'WIN_CARD_TEST_TOKEN not set');
  test('renders, is noindex, leaks no contact data or exact times', async ({ page }) => {
    await page.goto(`/win/${OK}`);
    await expect(page.locator('article img')).toBeVisible();
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
    const text = await page.locator('main').innerText();
    for (const re of LEAKS) expect(text).not.toMatch(re);
  });
  test('visual snapshots: light / dark / reduced motion', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto(`/win/${OK}`);
      await expect(page.locator('article img')).toHaveScreenshot(`win-card-${scheme}.png`, { maxDiffPixelRatio: 0.01 });
    }
  });
  test('OG route returns tags for crawlers and an image', async ({ request }) => {
    const r = await request.get(`/api/win-card?t=${OK}`);
    expect(r.status()).toBe(200);
    const html = await r.text();
    expect(html).toContain('property="og:image"');
    for (const re of LEAKS) expect(html).not.toMatch(re);
    const img = await request.get(`/api/win-card?t=${OK}&img=og`);
    expect(img.headers()['content-type']).toContain('image/png');
  });
});
test('expired / revoked / malformed tokens give 404 and no OG image', async ({ page, request }) => {
  for (const t of [DEAD, 'x'.repeat(43), 'short', '../../etc/passwd'].filter(Boolean)) {
    const r = await request.get(`/api/win-card?t=${encodeURIComponent(t)}`);
    expect(r.status()).toBe(404);
    expect(await r.text()).not.toContain('og:image');
  }
  await page.goto(`/win/${'x'.repeat(43)}`);
  await expect(page.getByText('This card is no longer available')).toBeVisible();
});
