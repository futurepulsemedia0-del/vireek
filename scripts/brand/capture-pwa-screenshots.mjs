#!/usr/bin/env node
// Captures REAL app screenshots for the manifest (store policies want true UI, not illustrations).
// Use a DEMO account (demo-seed.sql), never a customer account: the images ship publicly in public/screenshots/.
// Usage: E2E_TEST_EMAIL=... E2E_TEST_PASSWORD=... [E2E_BASE_URL=http://localhost:4173] npm run brand:screenshots
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ROOT, fail } from './lib.mjs';

const { E2E_TEST_EMAIL: EMAIL, E2E_TEST_PASSWORD: PASSWORD, E2E_BASE_URL: BASE = 'http://localhost:4173' } = process.env;
if (!EMAIL || !PASSWORD) fail('Set E2E_TEST_EMAIL and E2E_TEST_PASSWORD (a demo account) and start the app (npm run build && npm run preview).');

const PAGES = [['dashboard', '/dashboard'], ['calls', '/dashboard/calls'], ['jobs', '/dashboard/jobs']];
const FORMS = [
  ['wide', { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }],
  ['narrow', { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ args: process.env.CI ? ['--no-sandbox'] : [] });
await mkdir(path.join(ROOT, 'public/screenshots'), { recursive: true });
try {
  for (const [form, opts] of FORMS) {
    const ctx = await browser.newContext({ ...opts, colorScheme: 'light', locale: 'en-US', serviceWorkers: 'block' });
    // keep the install banner and onboarding nudges out of the shots
    await ctx.addInitScript(() => localStorage.setItem('vireek.pwa.install.dismissedAt', String(Date.now())));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email address').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(dashboard|tech|onboarding)/, { timeout: 30000 });
    for (const [name, route] of PAGES) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      const file = path.join(ROOT, 'public/screenshots', `${form}-${name}.png`);
      await page.screenshot({ path: file });
      console.log(`[shots] ${path.relative(ROOT, file)}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
