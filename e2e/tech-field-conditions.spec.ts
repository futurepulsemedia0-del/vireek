// e2e/tech-field-conditions.spec.ts — core technician flows under throttled network + CPU.
//
// WHAT THIS IS: a regression proxy. It runs /tech/today → open job → advance status → add note while Chromium
// is CPU-throttled and the real network (the app's own static assets) is bandwidth/latency-throttled, and while
// the mocked Supabase API answers slowly, fails, or drops. It checks that the UI shows loading/error/retry states,
// does not lose typed data, and keeps the primary action tappable.
//
// WHAT THIS IS NOT: evidence about real technicians. It says nothing about gloves, glare, noise or what people
// understand. Those are answered only by the field sessions in docs/research/FIELD_USABILITY_TEST_SCRIPT.md.
// The throttle numbers below are our own proxy choices, not measured field data. [VERIFY against real field logs]
//
// MOCKING NOTE: requests fulfilled by page.route() never reach Chromium's network stack, so CDP network throttling
// does NOT slow them. The mock therefore adds its own delay (apiDelayMs) and can abort requests to simulate a dropped
// connection. CDP throttling still applies to the real app bundle served by `vite preview`.
//
// Chromium only (uses a CDP session). Telephony and payments are never contacted: every Supabase call is mocked.
import { test, expect, type Page, type Route } from '@playwright/test';
import { PROFILE, SUPABASE_URL, USER, signIn } from './helpers/mockSupabase';

interface Profile {
  /** CDP Network.emulateNetworkConditions: bytes per second and milliseconds. */
  downBytesPerSec: number;
  upBytesPerSec: number;
  latencyMs: number;
  /** CDP Emulation.setCPUThrottlingRate: 1 = none, 4 = 4x slower. */
  cpuRate: number;
  /** Extra delay the mocked API adds to every call (see MOCKING NOTE). */
  apiDelayMs: number;
}

const WEAK_SIGNAL: Profile = { downBytesPerSec: 200 * 1024, upBytesPerSec: 100 * 1024, latencyMs: 300, cpuRate: 4, apiDelayMs: 900 };
const WEAK_SIGNAL_OLD_PHONE: Profile = { ...WEAK_SIGNAL, cpuRate: 6 };

const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = 'Avery Customer';

const job = (status: string) => ({
  id: JOB_ID,
  customer_name: CUSTOMER,
  address: '12 Example Street',
  service_type: 'AC repair',
  scheduled_datetime: new Date(Date.now() + 3_600_000).toISOString(),
  job_status: status,
  arrived_at: null,
  started_at: null,
  completed_at: null,
  expected_duration_minutes: 60,
  safety_flag: false,
});

/** Mutable simulation state, one per test, observed by assertions. */
interface Sim {
  apiDelayMs: number;
  offline: boolean;
  failTodayRequests: number;
  status: string;
  advanceCalls: number;
  noteCalls: string[];
}
const newSim = (apiDelayMs: number): Sim => ({ apiDelayMs, offline: false, failTodayRequests: 0, status: 'scheduled', advanceCalls: 0, noteCalls: [] });

async function installApi(page: Page, sim: Sim) {
  await page.route(`${SUPABASE_URL}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (sim.offline) return route.abort('internetdisconnected');
    if (sim.apiDelayMs) await new Promise((r) => setTimeout(r, sim.apiDelayMs));
    if (sim.offline) return route.abort('internetdisconnected'); // went offline while the request was "in flight"

    if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER.id, email: USER.email, aud: 'authenticated' });

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop()!;
      const body = (req.postDataJSON?.() ?? {}) as Record<string, unknown>;
      switch (name) {
        case 'get_my_team_member_id':
          return json(200, 'tm-1');
        case 'get_technician_today_jobs':
          if (sim.failTodayRequests > 0) {
            sim.failTodayRequests -= 1;
            return json(500, { message: 'simulated upstream failure' });
          }
          return json(200, [job(sim.status)]);
        case 'get_my_crew_jobs':
          return json(200, []);
        case 'get_job_brief':
          return json(200, {
            job: { ...job(sim.status), notes: null, invoice_amount: null, safety_flag_note: null },
            customer: { id: 'c1', name: CUSTOMER, phone: null, address: '12 Example Street', lifecycle_stage: 'customer', tags: [] },
            equipment: [], previous_notes: [], warranty_claims: [], likely_diagnosis: null, customer_preferences: [], parts_check: [],
          });
        case 'compliance_start_status':
          return json(200, { has_review: true, needs_ack: false, unresolved: 0 });
        case 'advance_job_status':
          sim.advanceCalls += 1;
          sim.status = String(body.p_new_status ?? sim.status);
          return json(200, { success: true });
        case 'add_job_note':
          sim.noteCalls.push(String(body.p_note ?? ''));
          return json(200, { success: true });
        default:
          return json(404, { message: `not_mocked: ${name}` }); // unknown RPCs behave like an error, never like fake data
      }
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return route.fulfill({ status: 204, headers: cors });
      const wantsObject = (req.headers()['accept'] ?? '').includes('pgrst.object');
      if (table === 'profiles') return wantsObject ? json(200, { ...PROFILE, role: 'technician' }) : json(200, [{ ...PROFILE, role: 'technician' }]);
      return wantsObject ? json(406, { code: 'PGRST116', message: 'no rows' }) : json(200, []);
    }

    if (url.pathname.startsWith('/functions/v1/')) return json(404, { error: 'not_mocked' });
    return route.continue();
  });
}

async function throttle(page: Page, p: Profile) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: p.latencyMs,
    downloadThroughput: p.downBytesPerSec,
    uploadThroughput: p.upBytesPerSec,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpuRate });
}

const FIRST_PAINT_TIMEOUT = 60_000; // generous on purpose: this suite checks behaviour, not speed budgets
const rowButton = (page: Page) => page.getByRole('button', { name: new RegExp(CUSTOMER) }).filter({ hasText: CUSTOMER });

test.describe('technician flows under throttled network + CPU (proxy, Chromium only)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP throttling is Chromium-only');
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('Today: loading state first, then the job list; records time-to-jobs for trend only', async ({ page }, testInfo) => {
    const sim = newSim(WEAK_SIGNAL.apiDelayMs);
    await installApi(page, sim);
    await throttle(page, WEAK_SIGNAL);

    const t0 = Date.now();
    await page.goto('/tech/today');
    await expect(page.getByRole('status', { name: 'Loading jobs' })).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });
    await expect(rowButton(page)).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });
    testInfo.annotations.push({ type: 'time-to-jobs-ms (throttled proxy, trend only)', description: String(Date.now() - t0) });

    await expect(page.getByRole('status', { name: 'Loading jobs' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Technician shortcuts' })).toBeVisible();
  });

  test('Today: upstream failure shows an alert with Retry, and Retry recovers without a reload', async ({ page }) => {
    const sim = newSim(WEAK_SIGNAL.apiDelayMs);
    sim.failTodayRequests = 1;
    await installApi(page, sim);
    await throttle(page, WEAK_SIGNAL);

    await page.goto('/tech/today');
    const alert = page.getByRole('alert').filter({ hasText: "Couldn't load today's jobs." });
    await expect(alert).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });
    const retry = alert.getByRole('button', { name: 'Retry' });
    const box = await retry.boundingBox();
    expect(box?.height ?? 0, 'Retry must be at least 44px tall (repo touch-target convention)').toBeGreaterThanOrEqual(44);

    await retry.click();
    await expect(rowButton(page)).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });
    await expect(alert).toHaveCount(0);
  });

  test('Today → Job: open a job from the list on a 6x CPU throttle and see the primary action', async ({ page }) => {
    const sim = newSim(WEAK_SIGNAL_OLD_PHONE.apiDelayMs);
    await installApi(page, sim);
    await throttle(page, WEAK_SIGNAL_OLD_PHONE);

    await page.goto('/tech/today');
    await rowButton(page).click({ timeout: FIRST_PAINT_TIMEOUT });
    await expect(page).toHaveURL(new RegExp(`/tech/job/${JOB_ID}$`));
    await expect(page.getByRole('heading', { name: CUSTOMER })).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });

    const primary = page.getByRole('button', { name: 'Mark as En Route' });
    await expect(primary).toBeVisible();
    const box = await primary.boundingBox();
    expect(box?.height ?? 0, 'primary action tall enough for a gloved thumb (>= 44px repo convention)').toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('Job: one tap advances status exactly once, even when the connection is slow', async ({ page }) => {
    // Suspected from static reading (NOT yet observed): handleAdvance only sets `busy` AFTER the async compliance guard,
    // so a second tap during that window can send a second advance_job_status. A gloved double-tap on a slow connection
    // is the realistic trigger. test.fail() keeps CI green while documenting it; if this starts "unexpectedly passing",
    // the guard was fixed — delete the test.fail() line. [VERIFY by running this spec]
    test.fail(true, 'suspected double-submit window before busy=true; verify by running');

    const sim = newSim(WEAK_SIGNAL.apiDelayMs);
    await installApi(page, sim);
    await throttle(page, WEAK_SIGNAL);

    await page.goto(`/tech/job/${JOB_ID}`);
    const primary = page.getByRole('button', { name: 'Mark as En Route' });
    await expect(primary).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });

    await primary.click();
    await primary.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => undefined); // second tap; may be blocked once disabled
    await expect.poll(() => sim.status, { timeout: FIRST_PAINT_TIMEOUT }).toBe('en_route');
    await page.waitForTimeout(WEAK_SIGNAL.apiDelayMs * 3);
    expect(sim.advanceCalls).toBe(1);
  });

  test('Job: a note typed while signal drops is not lost, and saves after the connection returns', async ({ page }) => {
    const sim = newSim(WEAK_SIGNAL.apiDelayMs);
    await installApi(page, sim);
    await throttle(page, WEAK_SIGNAL);

    await page.goto(`/tech/job/${JOB_ID}`);
    const noteBox = page.getByPlaceholder('What did you find / do?');
    await expect(noteBox).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT });
    const text = 'Capacitor swapped, unit cooling again';
    await noteBox.fill(text);

    sim.offline = true; // signal drops
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.waitForTimeout(WEAK_SIGNAL.apiDelayMs + 500);
    await expect(noteBox, 'typed text must survive a failed save').toHaveValue(text);
    expect(sim.noteCalls, 'nothing should have been recorded while offline').toHaveLength(0);

    sim.offline = false; // signal returns; technician taps Save again
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect.poll(() => sim.noteCalls.length, { timeout: FIRST_PAINT_TIMEOUT }).toBe(1);
    expect(sim.noteCalls[0]).toBe(text);
    await expect(noteBox).toHaveValue('');
  });
});
