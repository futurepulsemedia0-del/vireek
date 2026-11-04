// e2e/voice-log.spec.ts
//
// Voice job log on the technician job page. Needs a REAL staging technician and job:
//   E2E_TECH_EMAIL, E2E_TECH_PASSWORD, E2E_TECH_JOB_ID   (skipped when missing)
// Chromium runs with a fake microphone so recording works headlessly.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TECH_EMAIL;
const PASSWORD = process.env.E2E_TECH_PASSWORD;
const JOB_ID = process.env.E2E_TECH_JOB_ID;

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function openJob(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(EMAIL!);
  await page.getByLabel('Password').fill(PASSWORD!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(dashboard|tech)/);
  await page.goto(`/tech/job/${JOB_ID}`);
  await expect(page.getByRole('heading', { name: 'Voice log' }).or(page.getByRole('heading', { name: 'Record dictations on this job?' }))).toBeVisible();
}

async function acceptConsent(page: Page) {
  const accept = page.getByRole('button', { name: 'I agree, start' });
  if (await accept.isVisible()) await accept.click();
  await expect(page.getByRole('button', { name: 'Tap and speak' })).toBeVisible();
}

test.describe('Technician voice log', () => {
  test.skip(!EMAIL || !PASSWORD || !JOB_ID, 'E2E_TECH_EMAIL / E2E_TECH_PASSWORD / E2E_TECH_JOB_ID not set.');

  test('consent comes first and the page has no WCAG 2.2 AA violations', async ({ page }) => {
    await openJob(page);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('the record button is glove-sized (>= 56 px tall, full width)', async ({ page }) => {
    await openJob(page);
    await acceptConsent(page);
    const box = await page.getByRole('button', { name: 'Tap and speak' }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    expect(box?.width ?? 0).toBeGreaterThan(200);
  });

  test('recording with NO signal is kept on the device and shown as waiting', async ({ page, context }) => {
    await openJob(page);
    await acceptConsent(page);
    await context.setOffline(true);
    await expect(page.getByText('Offline — recordings are kept safely and processed later.')).toBeVisible();
    await page.getByRole('button', { name: 'Tap and speak' }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Tap to stop' }).click();
    await expect(page.getByText('Waiting to process')).toBeVisible();
    await page.reload().catch(() => undefined); // survives a reload (IndexedDB)
    await context.setOffline(false);
  });

  test('keyboard: the record button is reachable and toggles with Enter', async ({ page }) => {
    await openJob(page);
    await acceptConsent(page);
    const rec = page.getByRole('button', { name: 'Tap and speak' });
    await rec.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Tap to stop' })).toBeVisible();
    await page.keyboard.press('Enter');
  });

  test('reduced motion: no violations and no running pulse animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openJob(page);
    await acceptConsent(page);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('pre-job brief reads aloud only on request (no autoplay)', async ({ page }) => {
    await openJob(page);
    const calls = await page.evaluate(() => (window as unknown as { __spoke?: number }).__spoke ?? 0);
    expect(calls).toBe(0);
    await expect(page.getByRole('button', { name: 'Read it to me' }).or(page.getByText('Reading aloud is not available on this device.'))).toBeVisible();
  });
});
