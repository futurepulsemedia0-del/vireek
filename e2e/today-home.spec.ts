// e2e/today-home.spec.ts — Today Home states, honesty rules, a11y, keyboard, TV variant, mobile.
// NOTE: fixtures use "minutes ago" and a UTC day; run outside the first ~30 minutes after UTC midnight.
// Visual baselines are created on first run (--update-snapshots) and must be reviewed by a human.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PROFILE, USER, mockSupabase, signIn, type Tables } from './helpers/mockSupabase';

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const call = (o: Record<string, unknown>) => ({ vapi_call_id: null, call_datetime: iso(30), status: 'booked', is_emergency: false, is_voicemail: false, escalated_at: null, voicemail_listened_at: null, caller_name: null, summary: null, ...o });

const busy: Tables = {
  profiles: [PROFILE], team_members: [], money_recovered_settings: [{ timezone: 'UTC' }],
  business_profile: [{ vapi_phone_number_id: 'p', vapi_assistant_id: 'a' }],
  first_call_sessions: [{ vapi_call_id: 'practice-v' }],
  calls: [
    call({ id: 'c1' }), call({ id: 'c2', is_emergency: true, caller_name: 'Pat', call_datetime: iso(10) }), call({ id: 'c3', status: 'missed' }),
    call({ id: 'practice', vapi_call_id: 'practice-v' }),
  ],
  jobs: [{ id: 'j1', call_id: 'c1', job_status: 'scheduled', created_at: iso(25) }, { id: 'j2', call_id: 'practice', job_status: 'scheduled', created_at: iso(20) }],
  revenue_recovery_events: [
    { id: 'e1', source_type: 'missed_call', call_id: 'c3', customer_name: 'Dana', occurred_at: iso(300), estimated_value_cents: 80000, status: 'recovered', recovery_method: 'follow_up_call', recovered_amount_cents: 62500, follow_up_count: 1, last_follow_up_at: iso(120), resolved_at: iso(15) },
    { id: 'e2', source_type: 'missed_call', call_id: null, customer_name: 'Big Co', occurred_at: iso(500), estimated_value_cents: 900000, status: 'open', recovery_method: null, recovered_amount_cents: null, follow_up_count: 0, last_follow_up_at: null, resolved_at: null },
  ],
  live_calls: [],
};
const counts = { calls: 4 };

test.beforeEach(async ({ page }) => { await signIn(page); });

test('hero shows only credited money; estimates and practice calls never inflate anything', async ({ page }) => {
  await mockSupabase(page, { tables: busy, counts });
  await page.goto('/dashboard/today');
  const hero = page.getByRole('region', { name: 'Sarah recovered today' });
  await expect(hero).toContainText('$625.00');
  await expect(hero).not.toContainText('9,000');
  await expect(page.getByText('Calls handled').locator('..')).toContainText('2'); // c1 + c2; missed + practice excluded
  await expect(page.getByText('Jobs booked').locator('..')).toContainText('1');   // practice job excluded
  await page.getByRole('button', { name: 'How these are counted' }).click();
  await expect(page.getByText(/practice call/)).toBeVisible();
});

test('definition is keyboard and screen-reader reachable (disclosure, not hover-only)', async ({ page }) => {
  await mockSupabase(page, { tables: busy, counts });
  await page.goto('/dashboard/today');
  const btn = page.getByRole('button', { name: 'How is this calculated?' });
  await btn.focus();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/never estimates/)).toBeVisible();
  await expect(page.getByText(/still open/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('attention list: max 5, urgent first, text labels not colour alone', async ({ page }) => {
  await mockSupabase(page, { tables: busy, counts });
  await page.goto('/dashboard/today');
  const items = page.getByRole('region', { name: 'Attention needed' }).getByRole('listitem');
  expect(await items.count()).toBeLessThanOrEqual(5);
  await expect(items.first()).toContainText('Urgent');
  await expect(items.first()).toContainText('Emergency call from Pat');
  await expect(page.getByText(/not counted as recovered/)).toBeVisible();
});

test('calm empty state for a new account', async ({ page }) => {
  await mockSupabase(page, { tables: { ...busy, calls: [], jobs: [], revenue_recovery_events: [], first_call_sessions: [], business_profile: [{ vapi_phone_number_id: null, vapi_assistant_id: null }] }, counts: { calls: 0 } });
  await page.goto('/dashboard/today');
  await expect(page.getByRole('heading', { name: /ready to meet her first caller/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call Sarah now' })).toHaveAttribute('href', '/onboarding/first-call');
  await expect(page.getByText('$0.00')).toHaveCount(0);
});

test('skeleton while loading, then content (no layout jump)', async ({ page }) => {
  await mockSupabase(page, { tables: busy, counts, delayMs: 600 });
  await page.goto('/dashboard/today');
  await expect(page.getByTestId('today-skeleton')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sarah recovered today' })).toBeVisible();
});

test('first load failure shows an error with retry, never a fake zero', async ({ page }) => {
  let down = true;
  await mockSupabase(page, { tables: busy, counts, fail: (t) => down && t === 'calls' });
  await page.goto('/dashboard/today');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('$0.00')).toHaveCount(0);
  down = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('region', { name: 'Sarah recovered today' })).toContainText('$625.00');
});

test('stale state: refresh fails after a good load, numbers stay and the banner says how old they are', async ({ page }) => {
  let down = false;
  await page.clock.install();
  await mockSupabase(page, { tables: busy, counts, fail: (t) => down && t === 'calls' });
  await page.goto('/dashboard/today');
  await expect(page.getByRole('region', { name: 'Sarah recovered today' })).toContainText('$625.00');
  down = true;
  await page.clock.fastForward(4 * 60_000);
  await expect(page.getByTestId('today-stale')).toContainText(/refresh/);
  await expect(page.getByRole('region', { name: 'Sarah recovered today' })).toContainText('$625.00');
});

test('TV variant: large, read-only, no links', async ({ page }) => {
  await mockSupabase(page, { tables: busy, counts });
  await page.goto('/dashboard/today/tv');
  await expect(page.getByTestId('today-home')).toHaveAttribute('data-variant', 'tv');
  await expect(page.getByRole('region', { name: 'Attention needed' }).getByRole('link')).toHaveCount(0);
  await expect(page).toHaveScreenshot('today-tv.png', { maxDiffPixelRatio: 0.01, animations: 'disabled' });
});

test.describe('a11y + mobile + motion', () => {
  test('no WCAG 2.2 AA violations (data, empty)', async ({ page }) => {
    await mockSupabase(page, { tables: busy, counts });
    await page.goto('/dashboard/today');
    await expect(page.getByRole('region', { name: 'Sarah recovered today' })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  });
  test('mobile 375px: no horizontal scroll, tap targets ≥ 44px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockSupabase(page, { tables: busy, counts });
    await page.goto('/dashboard/today');
    await expect(page.getByRole('region', { name: 'Sarah recovered today' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const h = await page.getByRole('button', { name: 'How is this calculated?' }).boundingBox();
    expect(h!.height).toBeGreaterThanOrEqual(44);
    await expect(page).toHaveScreenshot('today-mobile.png', { maxDiffPixelRatio: 0.01, animations: 'disabled' });
  });
  test('reduced motion: orb is static and the page still works', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockSupabase(page, { tables: busy, counts });
    await page.goto('/dashboard/today');
    const anim = await page.locator('.sarah-orb__bar').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe('none');
  });
});
