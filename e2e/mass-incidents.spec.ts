// e2e/mass-incidents.spec.ts
//
// Mass Incident Mode dashboard. Needs a real staging account like the other authenticated specs:
// set E2E_TEST_EMAIL and E2E_TEST_PASSWORD. Non-destructive: it never saves settings or sends a message.
// axe needs: npm install -D @axe-core/playwright (already required by accessibility.spec.ts).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(EMAIL!);
  await page.getByLabel('Password').fill(PASSWORD!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/dashboard/);
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test.describe('Mass Incident Mode', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated flows.');

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/mass-incidents');
    await expect(page.getByRole('heading', { level: 1, name: 'Mass Incident Mode' })).toBeVisible();
  });

  test('shows an honest empty or disabled state, never a blank page', async ({ page }) => {
    const incidentsPanel = page.getByRole('tabpanel', { name: 'Incidents' });
    await expect(incidentsPanel.getByText(/Mass Incident Mode is off|No incidents right now|Contacts in this incident|Cluster|Possible/).first()).toBeVisible();
  });

  test('tabs are keyboard operable and expose the right ARIA state', async ({ page }) => {
    const tabs = page.getByRole('tablist');
    const incidents = tabs.getByRole('tab', { name: 'Incidents' });
    await incidents.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Evidence & directory' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Evidence & directory' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  });

  test('official notice needs an https source: invalid input is blocked before any request', async ({ page }) => {
    let rpcCalls = 0;
    await page.route('**/rest/v1/rpc/mass_incident_add_notice', (route) => {
      rpcCalls += 1;
      return route.abort();
    });
    await page.getByRole('tab', { name: 'Evidence & directory' }).click();
    const form = page.getByRole('heading', { name: 'Add an official notice' });
    test.skip((await form.count()) === 0, 'Account cannot manage incidents (read-only view).');
    await page.getByLabel('What the notice says').fill('Water main repair on Elm St');
    await page.getByLabel('Link to the official page (https)').fill('http://not-secure.example');
    await page.getByRole('button', { name: 'Save notice' }).click();
    await expect(page.getByLabel('Link to the official page (https)')).toHaveAttribute('aria-invalid', 'true');
    expect(rpcCalls).toBe(0);
  });

  test('directory form rejects a number that is not in international format', async ({ page }) => {
    let rpcCalls = 0;
    await page.route('**/rest/v1/rpc/mass_incident_directory_upsert', (route) => {
      rpcCalls += 1;
      return route.abort();
    });
    await page.getByRole('tab', { name: 'Evidence & directory' }).click();
    test.skip((await page.getByRole('heading', { name: 'Add a verified contact' }).count()) === 0, 'Read-only view.');
    await page.getByLabel('Organisation name').fill('City Water');
    await page.getByLabel(/Phone \(international format/).fill('512-555-0100');
    await page.getByLabel('Where you verified it (https link)').fill('https://example.org/contact');
    await page.getByLabel('Verified by').fill('Test Owner');
    await page.getByRole('button', { name: 'Save contact' }).click();
    expect(rpcCalls).toBe(0);
  });

  for (const tab of ['Incidents', 'Evidence & directory', 'Settings']) {
    test(`axe: ${tab} has no serious or critical WCAG 2.2 AA violations`, async ({ page }) => {
      await page.getByRole('tab', { name: tab }).click();
      await expectNoSeriousA11yViolations(page);
    });
  }

  test('respects prefers-reduced-motion and works at a narrow RTL viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mass Incident Mode' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
