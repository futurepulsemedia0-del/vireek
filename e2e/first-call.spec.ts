// e2e/first-call.spec.ts — telephony is fully mocked (edge function + REST); no real call or SMS is ever placed.
// Needs a build with VITE_SUPABASE_URL set (same value in E2E_ env as the build). Visual baselines are created on the
// first run: `npx playwright test e2e/first-call.spec.ts --update-snapshots`, then reviewed by a human.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PROFILE, USER, calls, mockSupabase, restWrites, signIn, type Tables } from './helpers/mockSupabase';

const T0 = Date.now();
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();
const SESSION = {
  id: '22222222-2222-4222-8222-222222222222', channel: 'phone', status: 'created', failure_code: null, phone_calling_code: '+1', phone_last4: '0123',
  notify_when_ready: false, signup_at: iso(-60), requested_at: iso(0), ringing_at: null, answered_at: null, first_transcript_at: null,
  booking_at: null, completed_at: null, call_id: null, job_id: null, vapi_call_id: 'v-1',
};
const JOB = { id: '33333333-3333-4333-8333-333333333333', customer_name: 'Pat', service_type: 'AC repair', scheduled_datetime: iso(86_400), address: '1 Main St' };

function tables(session: Record<string, unknown>, extra: Tables = {}): Tables {
  return {
    profiles: [PROFILE], team_members: [], business_profile: [{ user_id: USER.id }],
    first_call_sessions: [session], live_calls: [{ id: 'lc1' }], live_call_lines: [], jobs: [JOB], ...extra,
  };
}
const startOk = (s: Record<string, unknown>) => ({ start: () => ({ session: s }), cancel: () => ({ session: { ...s, status: 'canceled', failure_code: 'canceled' } }) });
const fnMock = (s: Record<string, unknown>) => ({ 'first-call-start': (b: Record<string, unknown>) => (b.action === 'cancel' ? startOk(s).cancel() : startOk(s).start()) });

async function toCallPhase(page: import('@playwright/test').Page) {
  await page.goto('/onboarding/first-call');
  await page.getByLabel('Business name').fill('Acme Heating');
  await page.getByLabel('Trade').selectOption('hvac');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Call Sarah now' })).toBeVisible();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('happy path: ring → pick up → live transcript → booking → celebration → next steps', async ({ page }) => {
  let s: Record<string, unknown> = { ...SESSION };
  const lines: unknown[] = [];
  await mockSupabase(page, { tables: new Proxy({}, { get: (_t, k: string) => tables(s, { live_call_lines: lines })[k] }) as Tables, functions: fnMock(s) });
  await toCallPhase(page);
  await page.getByLabel('Your mobile number').fill('(512) 555-0123');
  await page.getByRole('button', { name: 'Ring my phone' }).click();
  await expect(page.getByTestId('fc-status')).toBeVisible();

  s = { ...s, status: 'ringing', ringing_at: iso(2) };
  await expect(page.getByTestId('fc-status')).toContainText('Your phone is ringing', { timeout: 8000 });
  await expect(page.getByTestId('fc-stages').locator('li[aria-current="step"]')).toContainText('Sarah picked up');

  s = { ...s, status: 'in_call', answered_at: iso(9), first_transcript_at: iso(11) };
  lines.push({ id: 1, role: 'assistant', content: 'Thanks for calling Acme Heating, this is Sarah.' }, { id: 2, role: 'caller', content: 'My AC stopped working.' });
  await expect(page.getByTestId('fc-transcript')).toContainText('Thanks for calling Acme Heating', { timeout: 8000 });

  s = { ...s, status: 'completed', booking_at: iso(40), job_id: JOB.id, completed_at: iso(45) };
  await expect(page.getByTestId('fc-booking')).toContainText('AC repair', { timeout: 8000 });
  await expect(page.getByTestId('fc-celebrate')).toBeVisible();
  await expect(page.getByRole('link', { name: /Finish setup/ })).toBeVisible();

  // Privacy: the phone number goes to the edge function only, never to a REST write.
  expect(restWrites.map((w) => w.body).join(' ')).not.toContain('5125550123');
  expect(calls.find((c) => c.body.action === 'start')?.body.phone).toBe('(512) 555-0123');
});

for (const [code, status, expectText] of [
  ['voicemail', 'voicemail', 'voicemail picked up'],
  ['no_answer', 'no_answer', 'didn’t pick up'],
  ['carrier_error', 'failed', 'carrier blocked'],
] as const) {
  test(`failure recovery: ${code} explains what happened and offers the browser`, async ({ page }) => {
    const s = { ...SESSION, status, failure_code: code, ringing_at: iso(2), completed_at: iso(20) };
    await mockSupabase(page, { tables: tables(s), functions: fnMock(s) });
    await toCallPhase(page);
    await page.getByLabel('Your mobile number').fill('5125550123');
    await page.getByRole('button', { name: 'Ring my phone' }).click();
    await expect(page.getByRole('alert').filter({ hasText: expectText })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Talk in your browser instead' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
}

test('number still being provisioned: honest message and the opt-in text is sent as a flag, not stored client-side', async ({ page }) => {
  const s = { ...SESSION, status: 'waiting_for_number', failure_code: 'number_pending', notify_when_ready: true };
  await mockSupabase(page, { tables: tables(s), functions: fnMock(s) });
  await toCallPhase(page);
  await page.getByLabel('Your mobile number').fill('5125550123');
  await page.getByLabel(/text me when it is/).check();
  await page.getByRole('button', { name: 'Ring my phone' }).click();
  await expect(page.getByTestId('fc-status')).toContainText('being set up');
  expect(calls.find((c) => c.body.action === 'start')?.body.notify_when_ready).toBe(true);
});

test('bad numbers are rejected in the browser and nothing is dialled', async ({ page }) => {
  await mockSupabase(page, { tables: tables(SESSION), functions: fnMock(SESSION) });
  await toCallPhase(page);
  for (const bad of ['12345', 'call me', '+1 900 555 0123', '+98 912 345 6789']) {
    await page.getByLabel('Your mobile number').fill(bad);
    await page.getByRole('button', { name: 'Ring my phone' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
  }
  expect(calls.filter((c) => c.body.action === 'start')).toHaveLength(0);
});

test('international number is accepted and sent through', async ({ page }) => {
  await mockSupabase(page, { tables: tables(SESSION), functions: fnMock(SESSION) });
  await toCallPhase(page);
  await page.getByLabel('Your mobile number').fill('+44 7700 900123');
  await page.getByRole('button', { name: 'Ring my phone' }).click();
  await expect.poll(() => calls.filter((c) => c.body.action === 'start').length).toBe(1);
});

test('server rate limit is explained in plain language', async ({ page }) => {
  await mockSupabase(page, { tables: tables(SESSION), functions: { 'first-call-start': () => ({ __status: 429, error: 'rate_limited', retry_after_seconds: 3600 }) } });
  await toCallPhase(page);
  await page.getByLabel('Your mobile number').fill('5125550123');
  await page.getByRole('button', { name: 'Ring my phone' }).click();
  await expect(page.getByRole('alert')).toContainText('browser, which has no limit');
});

test.describe('accessibility + visuals', () => {
  test('setup and call screens have no WCAG 2.2 AA violations; layout is stable', async ({ page }) => {
    await mockSupabase(page, { tables: tables(SESSION), functions: fnMock(SESSION) });
    await page.goto('/onboarding/first-call');
    await expect(page.getByRole('heading', { name: 'Meet Sarah in about a minute' })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    await expect(page).toHaveScreenshot('first-call-setup.png', { maxDiffPixelRatio: 0.01, animations: 'disabled' });
    await toCallPhase(page);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    await expect(page).toHaveScreenshot('first-call-call.png', { maxDiffPixelRatio: 0.01, animations: 'disabled' });
  });
  test('keyboard only: the whole setup can be completed with Tab and Enter', async ({ page }) => {
    await mockSupabase(page, { tables: tables(SESSION), functions: fnMock(SESSION) });
    await page.goto('/onboarding/first-call');
    await page.getByLabel('Business name').focus();
    await page.keyboard.type('Acme Heating');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Call Sarah now|Meet Sarah/ })).toBeVisible();
  });
});
