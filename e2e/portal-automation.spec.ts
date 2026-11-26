// Playwright e2e: automation framework against the LOCAL mock portal (never a real site).
// Run:  npx playwright test e2e/portal-automation.spec.ts      NOT RUN in the authoring environment (no Playwright browsers installed).
import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockPortal } from './mock-portal/server.mjs';
import { runRecipe, type Recipe, type RunContext } from '../supabase/functions/_shared/portal/recipe';
import { PlaywrightDriver } from '../worker/portal-runner/playwrightDriver';

type Mock = ReturnType<typeof createMockPortal>;
const recipeFor = (host: string, selectorOverride?: string): Recipe => ({ id: 'mock-portal', version: 1, allowedHosts: [host], steps: [
  { kind: 'goto', url: `http://${host}/login` }, { kind: 'fill', selector: '#u', value: { secret: 'username' } }, { kind: 'fill', selector: '#p', value: { secret: 'password' } },
  { kind: 'click', selector: '#login' }, { kind: 'goto', url: `http://${host}/invoice/new` },
  { kind: 'fill', selector: selectorOverride ?? '#inv', value: { field: 'invoice_number' } }, { kind: 'fill', selector: '#amt', value: { field: 'amount' } },
  { kind: 'screenshot', name: 'pre-submit' }, { kind: 'approvalGate' }, { kind: 'click', selector: '#send', mutates: true }, { kind: 'captureRef', selector: '#ref' }] });
const ctx = (o: Partial<RunContext> = {}): RunContext => ({ fields: { invoice_number: 'INV-1', amount: '1500.00' }, secrets: { username: 'vendor', password: 'correct-horse' }, dryRun: false, requireApproval: true, approved: true, isHalted: async () => false, onEvent: () => undefined, ...o });

let mock: Mock; let host = '';
test.beforeEach(async () => { mock = createMockPortal(); host = `127.0.0.1:${await mock.listen()}`; });
test.afterEach(async () => { await mock.close(); });

test('submit -> reject -> resubmit -> approve', async ({ page }) => {
  const d = new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-')));
  const first = await runRecipe(recipeFor(host), d, ctx(), { allowInsecureLocalhost: true });
  expect(first.status).toBe('succeeded'); expect(first.reference).toMatch(/^MP-/);
  await page.request.post(`http://${host}/__admin/status`, { data: { ref: first.reference, status: 'Rejected', reason: 'Missing PO' } });
  const second = await runRecipe(recipeFor(host), d, ctx(), { allowInsecureLocalhost: true });   // corrected packet = a new run
  expect(second.status).toBe('succeeded'); expect(second.reference).not.toBe(first.reference);
  await page.request.post(`http://${host}/__admin/status`, { data: { ref: second.reference, status: 'Approved' } });
  await page.goto(`http://${host}/invoice/${second.reference}`); await expect(page.locator('#status')).toHaveText('Approved');
});
test('approval gate pauses before submitting; nothing is created on the portal', async ({ page }) => {
  const r = await runRecipe(recipeFor(host), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx({ approved: false }), { allowInsecureLocalhost: true });
  expect([r.status, r.reason]).toEqual(['paused_human', 'approval_required']); expect(mock.invoices.size).toBe(0);
});
test('dry-run creates nothing and types nothing', async ({ page }) => {
  const r = await runRecipe(recipeFor(host), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx({ dryRun: true, approved: false }), { allowInsecureLocalhost: true });
  expect(r.status).toBe('dry_run_complete'); expect(mock.invoices.size).toBe(0);
});
test('drift: a renamed selector fails safe at that step', async ({ page }) => {
  const r = await runRecipe(recipeFor(host, '#invoice-number-renamed'), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx(), { allowInsecureLocalhost: true });
  expect([r.status, r.reason]).toEqual(['drift', 'selector_missing']); expect(mock.invoices.size).toBe(0);
});
test('MFA pause: the run stops and asks the human', async ({ page }) => {
  await mock.close(); mock = createMockPortal({ mfa: true }); host = `127.0.0.1:${await mock.listen()}`;
  const r = await runRecipe(recipeFor(host), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx(), { allowInsecureLocalhost: true });
  expect([r.status, r.reason]).toEqual(['paused_human', 'mfa']); expect(mock.invoices.size).toBe(0);
});
test('CAPTCHA pause: the run stops and asks the human', async ({ page }) => {
  await mock.close(); mock = createMockPortal({ captcha: true }); host = `127.0.0.1:${await mock.listen()}`;
  const r = await runRecipe(recipeFor(host), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx(), { allowInsecureLocalhost: true });
  expect([r.status, r.reason]).toEqual(['paused_human', 'captcha']); expect(mock.invoices.size).toBe(0);
});
test('kill switch flipped mid-run stops before the submit click', async ({ page }) => {
  let n = 0; const r = await runRecipe(recipeFor(host), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx({ isHalted: async () => ++n > 7 }), { allowInsecureLocalhost: true });
  expect(r.status).toBe('halted'); expect(mock.invoices.size).toBe(0);
});
test('credentials never appear in the portal-visible request log paths or in the run result', async ({ page }) => {
  const r = await runRecipe(recipeFor(host), new PlaywrightDriver(page, mkdtempSync(join(tmpdir(), 'shots-'))), ctx(), { allowInsecureLocalhost: true });
  expect(JSON.stringify([r, mock.log])).not.toContain('correct-horse');
});
