import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __cls: number;
    __lcp: number;
  }
}

const ROUTES = ['/', '/pricing', '/login', '/faq', '/security'];
const VISUAL_ROUTES = ['/', '/pricing', '/login'];
const LOCALES = ['en', 'es', 'fr', 'de', 'ar', 'fa', 'hi', 'ja', 'zh'] as const;
const NATIVE_HINT: Record<(typeof LOCALES)[number], string> = {
  en: 'Inter', es: 'Inter', fr: 'Inter', de: 'Inter',
  ar: 'Segoe UI', fa: 'Segoe UI', hi: 'Nirmala UI', ja: 'Hiragino Sans', zh: 'PingFang SC',
};
const THIRD_PARTY = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
const CLS_BUDGET = 0.05;
const LCP_BUDGET_MS = Number(process.env.LCP_BUDGET_MS ?? 3000); // tune after the Phase 0 measurement

for (const path of ROUTES) {
  test(`${path} sends no request to Google Fonts and loads fonts same-origin`, async ({ page }) => {
    const hosts: string[] = [];
    const fontOrigins: string[] = [];
    page.on('request', (r) => {
      hosts.push(new URL(r.url()).hostname);
      if (r.resourceType() === 'font') fontOrigins.push(new URL(r.url()).origin);
    });
    await page.goto(path, { waitUntil: 'networkidle' });
    expect(hosts.filter((h) => THIRD_PARTY.test(h))).toEqual([]);
    const own = new URL(page.url()).origin;
    expect(fontOrigins.filter((o) => o !== own)).toEqual([]);
  });
}

test('Inter and Source Serif 4 are served from our origin and actually load', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const loaded = await page.evaluate(async () => {
    await Promise.all([document.fonts.load('400 16px Inter'), document.fonts.load('450 32px "Source Serif 4"')]);
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', ''));
  });
  expect(loaded).toEqual(expect.arrayContaining(['Inter', 'Source Serif 4']));
});

test('swapping in the web fonts (1.5 s late) stays within the CLS budget', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'layout-shift is Chromium-only');
  await page.route('**/fonts/*.woff2', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const s = e as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!s.hadRecentInput) window.__cls += s.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  expect(await page.evaluate(() => window.__cls)).toBeLessThanOrEqual(CLS_BUDGET);
});

test('LCP stays within budget on throttled mobile-like conditions', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP throttling is Chromium-only');
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
  });
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.__lcp = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  expect(await page.evaluate(() => window.__lcp)).toBeLessThanOrEqual(LCP_BUDGET_MS);
});

for (const locale of LOCALES) {
  for (const path of VISUAL_ROUTES) {
    test(`locale ${locale} on ${path}: font stack, letter-spacing and screenshot`, async ({ page }, testInfo) => {
      await page.goto(`${path}?lang=${locale}`, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const style = await page.evaluate(() => {
        const heading = document.querySelector('h1, h2');
        return {
          body: getComputedStyle(document.body).fontFamily,
          tracking: heading ? getComputedStyle(heading).letterSpacing : 'none',
        };
      });
      expect(style.body).toContain('Inter');
      expect(style.body).toContain(NATIVE_HINT[locale]);
      if (['ar', 'fa', 'hi', 'ja', 'zh'].includes(locale)) {
        expect(['normal', '0px', 'none']).toContain(style.tracking);
      }
      await testInfo.attach(`${locale}-${path === '/' ? 'home' : path.slice(1)}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });
  }
}
