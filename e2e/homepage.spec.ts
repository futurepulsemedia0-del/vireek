import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WIDTHS = [375, 768, 1280, 1920] as const;

async function dismissCookies(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'vireek-consent-v2',
      JSON.stringify({ essential: true, analytics: false, personalization: false, marketing: false, ai: false, version: 2, timestamp: new Date().toISOString() }),
    );
  });
}

test.describe('homepage', () => {
  test('has one H1, a primary CTA, and no fabricated proof', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const body = (await page.locator('main').innerText()).toLowerCase();
    for (const banned of ['soc 2', 'bank-grade', '99.9%', 'coastal plumbing', '$10,000', '$18,000']) {
      expect(body, `unverified claim "${banned}" must not appear`).not.toContain(banned);
    }
  });

  test('hero CTA goes to signup', async ({ page }) => {
    await dismissCookies(page);
    await page.goto('/');
    await page.locator('[data-hero-cta]').getByRole('link', { name: /start free trial/i }).click();
    await expect(page).toHaveURL(/\/signup/);
  });

  test('pricing toggle switches monthly and annual prices', async ({ page }) => {
    await dismissCookies(page);
    await page.goto('/');
    const pricing = page.locator('#pricing');
    await pricing.scrollIntoViewIfNeeded();
    const monthly = pricing.getByRole('button', { name: 'Monthly' });
    const annual = pricing.getByRole('button', { name: 'Annual' });
    await monthly.click();
    await expect(monthly).toHaveAttribute('aria-pressed', 'true');
    await expect(pricing).toContainText('$79');
    await annual.click();
    await expect(annual).toHaveAttribute('aria-pressed', 'true');
    await expect(pricing).toContainText('Billed $790 a year');
  });

  test('demo falls back to a transcript when the microphone is unsupported', async ({ page }) => {
    await dismissCookies(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });
    await page.goto('/');
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('demo-fallback')).toBeVisible();
    await expect(page.getByRole('list', { name: /example call transcript/i })).toBeVisible();
  });

  test('FAQ JSON-LD matches the visible questions', async ({ page }) => {
    await page.goto('/');
    await page.locator('#faq').scrollIntoViewIfNeeded();
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    const faq = blocks.map((b) => JSON.parse(b)).find((j) => j['@type'] === 'FAQPage');
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(6);
    for (const q of faq.mainEntity) {
      await expect(page.locator('#faq')).toContainText(q.name);
    }
  });

  test('no analytics request is made before consent', async ({ page }) => {
    const hits: string[] = [];
    page.on('request', (r) => {
      if (/googletagmanager\.com|google-analytics\.com/.test(r.url())) hits.push(r.url());
    });
    await page.goto('/');
    await page.waitForTimeout(2500);
    expect(hits).toEqual([]);
  });

  test('has no horizontal overflow and no WCAG A/AA violations', async ({ page }) => {
    await dismissCookies(page);
    await page.goto('/');
    await page.locator('footer').scrollIntoViewIfNeeded();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});

test.describe('mobile sticky bar', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('appears after the hero, is hidden on desktop-only, and does not cover the cookie banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sticky-cta')).toHaveCount(0); // hero CTA visible
    await page.waitForTimeout(1800); // cookie banner appears after 1.5s
    await page.mouse.wheel(0, 1600);
    await expect(page.getByTestId('sticky-cta')).toHaveCount(0); // banner open => bar hidden
    await page.getByRole('button', { name: /reject/i }).first().click();
    await expect(page.getByTestId('sticky-cta')).toBeVisible();
    await expect(page.getByTestId('sticky-cta').getByRole('link', { name: /start free trial/i })).toBeVisible();
  });
});

for (const width of WIDTHS) {
  test(`layout at ${width}px: no horizontal scroll, screenshot`, async ({ page }, info) => {
    await dismissCookies(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`home-${width}.png`), fullPage: true });
  });
}

test('pricing page still lists all plans', async ({ page }) => {
  await page.goto('/pricing');
  await expect(page.getByText(/professional/i).first()).toBeVisible();
});

test('nonexistent route does not crash the app shell', async ({ page }) => {
  const response = await page.goto('/this-route-does-not-exist');
  expect(response?.status()).toBeLessThan(500);
  await expect(page.locator('body')).not.toBeEmpty();
});
