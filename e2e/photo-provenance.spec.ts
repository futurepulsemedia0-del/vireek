// e2e/photo-provenance.spec.ts
//
// Public photo-evidence verification page (/verify/photo/:token): states, honest limits, privacy (no coordinates),
// local file check (SHA-256 computed in the browser), and WCAG 2.2 AA via axe in light, dark and RTL.
// The Supabase RPC is mocked at the network layer, so this tests the page contract, not the database.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';

const TOKEN = 'a'.repeat(64);
const FILE = Buffer.from('fake-jpeg-bytes-for-test');
const FILE_SHA = createHash('sha256').update(FILE).digest('hex');

const capture = (over: Record<string, unknown>) => ({
  id: '11111111-1111-4111-8111-111111111111', short_id: '11111111', original_sha256: FILE_SHA, original_bytes: 24, original_mime: 'image/jpeg',
  capture_source: 'in_app_camera', device_captured_at: '2028-11-03T10:00:00Z', device_time_status: 'ok', server_received_at: '2028-11-03T10:00:02Z',
  time_skew_seconds: 2, offline_queued: false, status: 'unmodified', flags: [],
  location: { status: 'recorded', accuracy_m: 8, accuracy_class: 'high', within_job_window: true, purged: false, coordinates: null },
  derivatives: [{ id: 'd1', kind: 'redacted', sha256: 'b'.repeat(64), parent_sha256: FILE_SHA, width: 10, height: 10, bytes: 5, created_at: '2028-11-03T10:05:00Z', modified: true, verified: true }],
  verification: { chain_ok: true, commit_ok: true, location_commit_ok: true, entry_seq: 4, entry_hash: 'x', prev_hash: 'y' },
  files_erased: false, erasure_requested: false, ...over,
});

async function mock(page: Page, body: unknown) {
  await page.route('**/rest/v1/rpc/verify_evidence_photo_share', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
}
const active = {
  found: true, state: 'active', issued_at: '2028-11-03T11:00:00Z', expires_at: '2028-12-03T11:00:00Z', chain_valid: true,
  captures: [
    capture({}),
    capture({ id: '22222222-2222-4222-8222-222222222222', short_id: '22222222', original_sha256: 'c'.repeat(64), capture_source: 'gallery_import', status: 'imported', derivatives: [], location: { status: 'not_requested', accuracy_m: null, accuracy_class: 'unknown', within_job_window: false, purged: false } }),
    capture({ id: '33333333-3333-4333-8333-333333333333', short_id: '33333333', original_sha256: 'd'.repeat(64), offline_queued: true, status: 'offline', derivatives: [] }),
  ],
};

test.describe('public photo evidence page', () => {
  test('shows statuses, honest limits and never coordinates', async ({ page }) => {
    await mock(page, active);
    await page.goto(`/verify/photo/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Photo evidence verification' })).toBeVisible();
    await expect(page.getByText('Unmodified since capture')).toBeVisible();
    await expect(page.getByText('Imported', { exact: true })).toBeVisible();
    await expect(page.getByText('Offline capture')).toBeVisible();
    await expect(page.getByText('What this does and does not prove')).toBeVisible();
    await expect(page.getByText(/does not prove the work was done correctly/i).first()).toBeVisible();
    expect(await page.content()).not.toMatch(/latitude|longitude/i);
  });

  test('checks a local file by hash without uploading it', async ({ page }) => {
    await mock(page, active);
    let uploaded = false;
    page.on('request', (r) => { if (r.method() === 'POST' && r.postDataBuffer()?.includes(FILE)) uploaded = true; });
    await page.goto(`/verify/photo/${TOKEN}`);
    await page.locator('input[type=file]').setInputFiles({ name: 'p.jpg', mimeType: 'image/jpeg', buffer: FILE });
    await expect(page.getByText(/this file is the original of photo 11111111/i)).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({ name: 'q.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('different') });
    await expect(page.getByText(/No match/i)).toBeVisible();
    expect(uploaded).toBe(false);
  });

  test('a broken chain is announced as an alert', async ({ page }) => {
    await mock(page, { ...active, chain_valid: false });
    await page.goto(`/verify/photo/${TOKEN}`);
    await expect(page.getByRole('alert').filter({ hasText: /failed its integrity check/i })).toBeVisible();
  });

  for (const [state, title] of [['expired', 'This link has expired'], ['revoked', 'This link was revoked']] as const) {
    test(`${state} link`, async ({ page }) => {
      await mock(page, { found: true, state });
      await page.goto(`/verify/photo/${TOKEN}`);
      await expect(page.getByRole('alert')).toContainText(title);
    });
  }

  test('unknown token', async ({ page }) => {
    await mock(page, { found: false });
    await page.goto(`/verify/photo/${TOKEN}`);
    await expect(page.getByRole('alert')).toContainText('Link not found');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`no WCAG 2.2 AA violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await mock(page, active);
      await page.goto(`/verify/photo/${TOKEN}`);
      await expect(page.getByText('Unmodified since capture')).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

});

// Language comes from navigator.language (resolveInitialLanguage), so a Persian browser locale exercises RTL.
test.describe('public photo evidence page (Persian, RTL)', () => {
  test.use({ locale: 'fa-IR' });
  test('renders RTL with no axe violations', async ({ page }) => {
    await mock(page, active);
    await page.goto(`/verify/photo/${TOKEN}`);
    await expect(page.getByText('راستی‌آزمایی شواهد عکس')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
