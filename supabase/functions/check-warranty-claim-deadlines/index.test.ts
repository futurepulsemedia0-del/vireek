// @vitest-environment node
// Reliability tests for check-warranty-claim-deadlines (the "warranty recovery" deadline alerts).
// Real index.ts, supabase-js replaced by the in-memory FakeDb. "KNOWN GAP"/"KNOWN QUIRK" tests pin CURRENT behaviour
// that is a weakness; they document it, they do not endorse it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { jsonOf, loadHandler, options, post, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const NOW = '2026-10-28T12:00:00.000Z';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const inDays = (d: number) => new Date(Date.parse(NOW) + d * 86400_000).toISOString();

let db: FakeDb;
let handler: Handler;
const claim = (o: Record<string, unknown> = {}) => ({
  id: 'c1', user_id: A, customer_name: 'Ann Lee', manufacturer: 'Carrier', claim_deadline: inDays(3), deadline_alert_stage: null, status: 'submitted', ...o,
});
const run = () => handler(post({}));
const notes = () => db.rows('notifications');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  sb.create = db.createClient;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  handler = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('check-warranty-claim-deadlines — auth', () => {
  it('answers CORS preflight without DB access', async () => {
    expect((await handler(options())).status).toBe(200);
    expect(db.log).toHaveLength(0);
  });

  it('KNOWN GAP: the handler itself has NO cron-secret or JWT check — any request that reaches it runs a cross-tenant scan with the service-role key. Protection depends entirely on the platform (verify_jwt defaults to true since supabase/config.toml does not list this function)', async () => {
    db.seed('warranty_claims', [claim()]);
    const res = await handler(new Request('http://edge.test/fn', { method: 'POST' })); // no headers at all
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).alertsCreated).toBe(1);
    expect(db.clients[0].key).toBe('svc');
  });
});

describe('check-warranty-claim-deadlines — alert staging', () => {
  it('due_soon: creates one notification and stamps the claim with the stage', async () => {
    db.seed('warranty_claims', [claim()]);
    const body = await jsonOf(await run());
    expect(body).toEqual({ alertsCreated: 1, checked: 1 });
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({
      user_id: A, type: 'warranty_claim_deadline', title: 'Warranty claim deadline approaching',
      action_url: '/dashboard/warranty-claims', warranty_claim_id: 'c1',
    });
    expect(notes()[0].message).toBe('The manufacturer warranty claim for Ann Lee (Carrier) must be submitted within 3 days.');
    expect(db.rows('warranty_claims')[0]).toMatchObject({ deadline_alert_stage: 'due_soon' });
    expect(db.rows('warranty_claims')[0].deadline_alert_sent_at).toBe(NOW);
  });

  it('overdue: a missed deadline gets its own distinct one-time alert', async () => {
    db.seed('warranty_claims', [claim({ claim_deadline: inDays(-2), deadline_alert_stage: 'due_soon' })]);
    await run();
    expect(notes()[0]).toMatchObject({ title: 'Warranty claim deadline missed' });
    expect(notes()[0].message).toContain('2 days ago');
    expect(db.rows('warranty_claims')[0].deadline_alert_stage).toBe('overdue');
  });

  it('uses singular "1 day" and a fallback label for a missing manufacturer', async () => {
    db.seed('warranty_claims', [claim({ claim_deadline: inDays(1), manufacturer: null }), claim({ id: 'c2', claim_deadline: inDays(-1), manufacturer: '' })]);
    await run();
    const msgs = notes().map((n) => n.message);
    expect(msgs).toContain('The manufacturer warranty claim for Ann Lee (this unit) must be submitted within 1 day.');
    expect(msgs).toContain('The manufacturer warranty claim for Ann Lee (this unit) missed its filing deadline 1 day ago.');
  });

  it('window boundary: exactly 7 days out alerts, 8 days out does not', async () => {
    db.seed('warranty_claims', [claim({ id: 'seven', claim_deadline: inDays(7) }), claim({ id: 'eight', claim_deadline: inDays(8) })]);
    const body = await jsonOf(await run());
    expect(body).toEqual({ alertsCreated: 1, checked: 2 });
    expect(notes()[0].warranty_claim_id).toBe('seven');
  });

  it('closed-out claims (denied / closed / credit_received) and claims without a deadline are never selected', async () => {
    db.seed('warranty_claims', [
      claim({ id: 'd', status: 'denied' }), claim({ id: 'cl', status: 'closed' }), claim({ id: 'cr', status: 'credit_received' }),
      claim({ id: 'nodl', claim_deadline: null }), claim({ id: 'live' }),
    ]);
    const body = await jsonOf(await run());
    expect(body).toEqual({ alertsCreated: 1, checked: 1 });
    expect(notes()[0].warranty_claim_id).toBe('live');
  });

  it('KNOWN QUIRK: a deadline that passed less than 24h ago is still "due_soon" (Math.ceil(-0.04) is -0, not < 0) and says "within 0 days"', async () => {
    db.seed('warranty_claims', [claim({ claim_deadline: new Date(Date.parse(NOW) - 3600_000).toISOString() })]);
    await run();
    expect(db.rows('warranty_claims')[0].deadline_alert_stage).toBe('due_soon');
    expect(notes()[0].message).toContain('within 0 days');
  });
});

describe('check-warranty-claim-deadlines — idempotent re-runs', () => {
  it('each stage fires at most once per claim: repeated runs create no further notifications', async () => {
    db.seed('warranty_claims', [claim()]);
    expect((await jsonOf(await run())).alertsCreated).toBe(1);
    expect((await jsonOf(await run())).alertsCreated).toBe(0);
    expect((await jsonOf(await run())).alertsCreated).toBe(0);
    expect(notes()).toHaveLength(1);
  });

  it('moving due_soon -> overdue later fires the second alert exactly once', async () => {
    db.seed('warranty_claims', [claim()]);
    await run();
    vi.setSystemTime(new Date(Date.parse(NOW) + 5 * 86400_000)); // deadline (3d) now 2 days past
    await run();
    await run();
    expect(notes().map((n) => n.title)).toEqual(['Warranty claim deadline approaching', 'Warranty claim deadline missed']);
  });

  it('a failed notification insert leaves the stage untouched so the next run retries it', async () => {
    db.seed('warranty_claims', [claim()]);
    db.failOn({ table: 'notifications', op: 'insert', times: 1, error: { message: 'rls' } });
    expect((await jsonOf(await run())).alertsCreated).toBe(0);
    expect(db.rows('warranty_claims')[0].deadline_alert_stage).toBeNull();
    expect((await jsonOf(await run())).alertsCreated).toBe(1);
    expect(notes()).toHaveLength(1);
  });

  it('KNOWN GAP: if the stage update fails AFTER the notification insert, the alert is duplicated on the next run (insert and update are not atomic) and the failure is not reported', async () => {
    db.seed('warranty_claims', [claim()]);
    db.failOn({ table: 'warranty_claims', op: 'update', times: 1, error: { message: 'write failed' } });
    expect((await jsonOf(await run())).alertsCreated).toBe(1);
    await run();
    expect(notes()).toHaveLength(2);
  });
});

describe('check-warranty-claim-deadlines — tenant isolation & preferences', () => {
  it('notifications go to the claim\'s own tenant; one tenant opting out does not suppress another', async () => {
    db.seed('warranty_claims', [claim({ id: 'ca', user_id: A }), claim({ id: 'cb', user_id: B, customer_name: 'Bo Kim' })]);
    db.seed('profiles', [{ id: A, notify_warranty_claim_deadline: false }, { id: B, notify_warranty_claim_deadline: true }]);
    const body = await jsonOf(await run());
    expect(body.alertsCreated).toBe(1);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ user_id: B, warranty_claim_id: 'cb' });
    expect(notes()[0].message).toContain('Bo Kim');
    expect(notes()[0].message).not.toContain('Ann Lee');
    expect(db.rows('warranty_claims').find((c) => c.id === 'ca')!.deadline_alert_stage).toBeNull(); // opted-out claim untouched
  });

  it('missing profile row or null preference defaults to "notify" (only an explicit false opts out)', async () => {
    db.seed('warranty_claims', [claim({ id: 'ca', user_id: A }), claim({ id: 'cb', user_id: B })]);
    db.seed('profiles', [{ id: A, notify_warranty_claim_deadline: null }]);
    expect((await jsonOf(await run())).alertsCreated).toBe(2);
  });

  it('looks up preferences only for the tenants that have candidates', async () => {
    db.seed('warranty_claims', [claim({ id: 'far', user_id: B, claim_deadline: inDays(60) }), claim({ id: 'near', user_id: A })]);
    await run();
    const lookup = db.calls('profiles', 'select')[0];
    expect(lookup.filters).toContainEqual(['id', 'in', [A]]);
  });
});

describe('check-warranty-claim-deadlines — malformed data & failures', () => {
  it('an unparseable claim_deadline is skipped (NaN is neither overdue nor due soon) without failing the run', async () => {
    db.seed('warranty_claims', [claim({ id: 'bad', claim_deadline: 'next tuesday-ish' }), claim({ id: 'ok' })]);
    const res = await run();
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ alertsCreated: 1, checked: 2 });
    expect(notes()[0].warranty_claim_id).toBe('ok');
  });

  it('returns {alertsCreated:0} for an empty table', async () => {
    expect(await jsonOf(await run())).toEqual({ alertsCreated: 0, checked: 0 });
  });

  it('a thrown DB failure on the claims query returns 500 with the message', async () => {
    db.failOn({ table: 'warranty_claims', op: 'select', mode: 'throw', error: { message: 'connection reset' } });
    const res = await run();
    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error).toBe('connection reset');
  });

  it('KNOWN GAP: a failing profiles query is ignored, so opted-out users would be notified (preferences silently lost)', async () => {
    db.seed('warranty_claims', [claim()]);
    db.seed('profiles', [{ id: A, notify_warranty_claim_deadline: false }]);
    db.failOn({ table: 'profiles', op: 'select', error: { message: 'timeout' } });
    expect((await jsonOf(await run())).alertsCreated).toBe(1);
  });
});
