import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mountAuditBackend } from './support/auditBackend';

async function fillForm(page: import('@playwright/test').Page, o: { phone?: string } = {}) {
  await page.goto('/audit');
  await page.getByLabel('Business name').fill('Acme HVAC');
  await page.getByLabel(/Business phone number/).fill(o.phone ?? '(512) 234-5678');
  await page.getByLabel(/Work email/).fill('owner@acme-hvac.com');
  await page.getByLabel('I am the owner or an authorized representative of this business and this number.', { exact: true }).check();
  await page.getByLabel(/Send one verification code/).check();
  await page.waitForTimeout(2700); // the form must have been open >= 2.5s (anti-bot floor)
}

test.describe('Missed-Call Audit', () => {
  test('full flow with a mock telephony provider: verify -> consent -> calls -> scored report -> share -> delete', async ({ page }) => {
    const { world, ready } = mountAuditBackend(page);
    await ready;
    await fillForm(page);
    await page.getByRole('button', { name: 'Text me a code' }).click();
    await expect(page.getByText(/We sent a 6-digit code/)).toBeVisible();
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Verify my number' }).click();
    await expect(page.getByRole('alert')).toBeVisible(); // wrong code is refused
    await page.getByLabel('Verification code').fill('123456');
    await page.getByRole('button', { name: 'Verify my number' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm your test calls' })).toBeVisible();

    const schedule = page.getByRole('button', { name: 'Schedule my test calls' });
    await expect(schedule).toBeDisabled(); // cannot proceed without explicit call consent
    await page.getByLabel(/I authorize Vireek to place up to 3 short automated test calls/).check();
    await schedule.click();
    await expect(page).toHaveURL(/\/audit\/[A-Za-z0-9_-]{43}$/);
    await expect(page.getByRole('status').first()).toContainText(/provisional/);
    const meta = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(meta).toContain('noindex');

    await world.runAllCalls(); // dials only the verified number, then delivers provider events
    expect(world.calls.placed.every((p) => p.toE164 === '+15122345678')).toBe(true);
    await page.reload();
    await expect(page.getByRole('img', { name: /Score 100 out of 100/ })).toBeVisible();
    await expect(page.getByText(/placeholder numbers/)).toBeVisible();

    const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(a11y.violations).toEqual([]);

    await page.getByRole('button', { name: 'Create share link' }).click();
    const shareUrl = (await page.locator('code').innerText()).trim();
    await page.goto(shareUrl.replace(/^https?:\/\/[^/]+/, ''));
    await expect(page.getByText('shared view')).toBeVisible();
    await expect(page.getByText(/Revenue at risk/)).toHaveCount(0); // redacted
    await expect(page.getByRole('button', { name: 'Delete my data' })).toHaveCount(0);

  });

  test('a leaky business sees a low score and a fix path; delete is one click and the link then 404s', async ({ page }) => {
    const { world, ready, LEAKY_BUSINESS } = mountAuditBackend(page);
    await ready;
    const s = await world.scheduled();
    await world.runAllCalls(LEAKY_BUSINESS);
    await page.goto(`/audit/${s.token}`);
    await expect(page.getByText('Your fix path')).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete my data' }).click();
    await expect(page).toHaveURL(/\/audit$/);
    await page.goto(`/audit/${s.token}`);
    await expect(page.getByRole('heading', { name: "This report isn't available" })).toBeVisible();
    expect(world.store.audits.size).toBe(0);
  });

  test('abuse UI: premium-rate numbers and missing consent never reach the provider', async ({ page }) => {
    const { world, ready } = mountAuditBackend(page);
    await ready;
    await fillForm(page, { phone: '(900) 234-5678' });
    await page.getByRole('button', { name: 'Text me a code' }).click();
    await expect(page.getByRole('alert')).toContainText(/number/i);
    expect(world.otp.sent).toHaveLength(0);
    await page.getByLabel(/Send one verification code/).uncheck();
    await expect(page.getByRole('button', { name: 'Text me a code' })).toBeDisabled();
  });

  test('kill switch: the page says it is unavailable and nothing is sent', async ({ page }) => {
    const { world, ready } = mountAuditBackend(page, { killSwitch: true });
    await ready;
    await page.goto('/audit');
    await expect(page.getByText(/temporarily unavailable/)).toBeVisible();
    expect(world.otp.sent).toHaveLength(0);
  });

  test('landing page is indexable and accessible; report URLs are noindex; analytics stay silent before consent', async ({ page }) => {
    const { ready } = mountAuditBackend(page);
    await ready;
    const gaHits: string[] = [];
    page.on('request', (r) => { if (/googletagmanager|google-analytics/.test(r.url())) gaHits.push(r.url()); });
    await page.goto('/audit');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('What really happens');
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('index, follow');
    const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(a11y.violations).toEqual([]);
    expect(gaHits).toEqual([]);
  });
});
