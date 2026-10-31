// @vitest-environment node
// Reliability tests for estimate-recovery-agent (the "estimate-to-cash" workflow trigger). They run the REAL index.ts:
// Deno.serve is captured and supabase-js is replaced by the in-memory FakeDb (see _shared/testing).
// Tests named "KNOWN GAP" pin CURRENT behaviour that is a reliability/security weakness; they document it, they do not endorse it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { jsonOf, loadHandler, options, post, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const NOW = '2026-10-28T12:00:00.000Z';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

let db: FakeDb;
let env: Record<string, string | undefined>;
let handler: Handler;

async function boot(extraEnv: Record<string, string | undefined> = {}) {
  env = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', CRON_SECRET: 'cron-s3cret', ...extraEnv };
  handler = await loadHandler(() => import('./index.ts'), env);
}
const run = (headers: Record<string, string> = { 'X-Cron-Secret': 'cron-s3cret' }) => handler(post({}, headers));

const quote = (o: Record<string, unknown> = {}) => ({
  id: 'q1', user_id: A, lead_id: 'lead1', customer_name: 'Ann', customer_phone: '+15550001', customer_email: 'ann@x.test',
  line_items: { subtotal_cents: 100000 }, tax_percent: 0, status: 'sent', sent_at: daysAgo(4), responded_at: null, ...o,
});
const ledger = () => db.rows('revenue_recovery_events');
const enrolls = () => db.rpcCalls('append_activity_event');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  db.uniques.revenue_recovery_events = ['source_table', 'source_id'];
  db.rpcHandlers.quote_line_items_subtotal_cents = (a) => a.p_line_items?.subtotal_cents ?? null;
  sb.create = db.createClient;
  await boot();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('estimate-recovery-agent — auth', () => {
  it('answers CORS preflight without touching the database', async () => {
    const res = await handler(options());
    expect(res.status).toBe(200);
    expect(db.log).toHaveLength(0);
  });

  it('rejects a missing X-Cron-Secret with 401 and reads/writes nothing', async () => {
    db.seed('quotes', [quote()]);
    const res = await run({});
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });

  it('rejects a wrong X-Cron-Secret with 401 and reads/writes nothing', async () => {
    db.seed('quotes', [quote()]);
    const res = await run({ 'X-Cron-Secret': 'nope' });
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: 'Unauthorized' });
    expect(db.log).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
  });

  it('accepts the correct secret', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);
  });

  it('KNOWN GAP: fails OPEN when CRON_SECRET is not configured (any caller can trigger a cross-tenant scan)', async () => {
    await boot({ CRON_SECRET: undefined });
    db.seed('quotes', [quote()]);
    const res = await run({});
    expect(res.status).toBe(200);
    expect(ledger()).toHaveLength(1);
  });

  it('uses the service-role key (RLS bypassed) — so tenant scoping must come from the row data', async () => {
    await run();
    expect(db.clients[0]).toMatchObject({ url: 'http://db.test', key: 'service-key' });
  });
});

describe('estimate-recovery-agent — detectors', () => {
  it('financing: flags a stalled high-value quote with ledger row + activity event + risk score', async () => {
    db.seed('quotes', [quote()]);
    const body = await jsonOf(await run());
    expect(body.flagged).toMatchObject({ financing: 1, booking: 0, invoice: 0, collection: 0, parts: 0, paymentFailed: 0 });
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({
      user_id: A, source_type: 'quote_financing_stalled', source_table: 'quotes', source_id: 'q1',
      estimated_value_cents: 100000, estimated_value_basis: 'quote_amount',
    });
    const up = db.calls('revenue_recovery_events', 'upsert')[0];
    expect(up.options).toEqual({ onConflict: 'source_table,source_id', ignoreDuplicates: true });
    expect(enrolls()).toHaveLength(1);
    expect(enrolls()[0].payload).toMatchObject({
      p_aggregate_type: 'quote', p_aggregate_id: 'q1', p_event_type: 'quote.financing_needed', p_actor_type: 'ai', p_user_id: A,
      // 96h -> 24, $1000 -> 20
      p_event_data: { amount_cents: 100000, risk_score: 44, customer_name: 'Ann', customer_phone: '+15550001', customer_email: 'ann@x.test' },
    });
  });

  it('financing: applies tax, honours the $500 threshold exactly, and ignores quotes newer than 72h', async () => {
    db.seed('quotes', [
      quote({ id: 'edge', line_items: { subtotal_cents: 50000 } }),
      quote({ id: 'below', line_items: { subtotal_cents: 49999 } }),
      quote({ id: 'taxed', line_items: { subtotal_cents: 48000 }, tax_percent: 10 }), // 52800
      quote({ id: 'fresh', sent_at: hoursAgo(71) }),
    ]);
    await run();
    expect(ledger().map((r) => r.source_id).sort()).toEqual(['edge', 'taxed']);
    expect(ledger().find((r) => r.source_id === 'taxed')?.estimated_value_cents).toBe(52800);
  });

  it('booking: flags accepted quotes with no job, skips ones that already have a job or no lead', async () => {
    db.seed('quotes', [
      quote({ id: 'ok', status: 'accepted', responded_at: hoursAgo(30), lead_id: 'L1' }),
      quote({ id: 'booked', status: 'accepted', responded_at: hoursAgo(30), lead_id: 'L2' }),
      quote({ id: 'nolead', status: 'accepted', responded_at: hoursAgo(30), lead_id: null }),
      quote({ id: 'recent', status: 'accepted', responded_at: hoursAgo(5), lead_id: 'L3' }),
    ]);
    db.seed('jobs', [{ id: 'j2', lead_id: 'L2', user_id: A }]);
    const body = await jsonOf(await run());
    expect(body.flagged.booking).toBe(1);
    expect(ledger().map((r) => r.source_id)).toEqual(['ok']);
    expect(ledger()[0].source_type).toBe('quote_accepted_unbooked');
    expect(enrolls()[0].payload.p_event_type).toBe('quote.accepted_not_booked');
  });

  it('invoice: needs a job.completed event older than 24h; no event or a fresh one is skipped; zero amount => basis none', async () => {
    db.seed('jobs', [
      { id: 'old', user_id: A, lead_id: 'L1', customer_name: 'Old', invoice_amount: 250.5, job_status: 'completed', invoice_status: 'not_sent' },
      { id: 'fresh', user_id: A, lead_id: null, customer_name: 'Fresh', invoice_amount: 100, job_status: 'completed', invoice_status: 'not_sent' },
      { id: 'noevent', user_id: A, lead_id: null, customer_name: 'None', invoice_amount: 100, job_status: 'completed', invoice_status: 'not_sent' },
      { id: 'zero', user_id: A, lead_id: null, customer_name: 'Zero', invoice_amount: null, job_status: 'completed', invoice_status: 'not_sent' },
      { id: 'sent', user_id: A, lead_id: null, customer_name: 'Sent', invoice_amount: 100, job_status: 'completed', invoice_status: 'sent' },
    ]);
    const ev = (id: string, h: number) => ({ aggregate_type: 'job', aggregate_id: id, event_type: 'job.completed', occurred_at: hoursAgo(h) });
    db.seed('business_activity_events', [ev('old', 30), ev('fresh', 10), ev('zero', 48), ev('sent', 48)]);
    db.seed('leads', [{ id: 'L1', phone: '+15559', email: 'x@y.z' }]);
    const body = await jsonOf(await run());
    expect(body.flagged.invoice).toBe(2);
    const old = ledger().find((r) => r.source_id === 'old')!;
    expect(old).toMatchObject({ source_type: 'job_completed_unbilled', estimated_value_cents: 25050, estimated_value_basis: 'job_invoice', customer_phone: '+15559' });
    expect(ledger().find((r) => r.source_id === 'zero')).toMatchObject({ estimated_value_cents: 0, estimated_value_basis: 'none' });
    expect(ledger().find((r) => r.source_id === 'fresh')).toBeUndefined();
    expect(ledger().find((r) => r.source_id === 'noevent')).toBeUndefined();
  });

  it('collection: flags sent/overdue requests older than 14 days only', async () => {
    const pr = (id: string, status: string, age: number) => ({ id, user_id: A, job_id: 'J', customer_name: 'C', customer_phone: '1', customer_email: 'c@x.test', amount: 80, status, created_at: daysAgo(age) });
    db.seed('payment_requests', [pr('p15', 'sent', 15), pr('p13', 'sent', 13), pr('pov', 'overdue', 20), pr('ppaid', 'paid', 30)]);
    db.seed('jobs', [{ id: 'J', lead_id: 'L9', user_id: A }]);
    const body = await jsonOf(await run());
    expect(body.flagged.collection).toBe(2);
    expect(ledger().map((r) => r.source_id).sort()).toEqual(['p15', 'pov']);
    expect(ledger()[0]).toMatchObject({ source_type: 'invoice_overdue', source_table: 'payment_requests', estimated_value_cents: 8000, lead_id: 'L9' });
  });

  it('parts leak: prefers the price-book price, needs a gap of at least $15, ignores un-installed parts', async () => {
    db.seed('jobs', [
      { id: 'leak', user_id: A, lead_id: null, customer_name: 'L', invoice_amount: 100, job_status: 'completed', invoice_status: 'sent' },
      { id: 'small', user_id: A, lead_id: null, customer_name: 'S', invoice_amount: 100, job_status: 'completed', invoice_status: 'paid' },
      { id: 'noparts', user_id: A, lead_id: null, customer_name: 'N', invoice_amount: 0, job_status: 'completed', invoice_status: 'sent' },
    ]);
    db.seed('inventory_parts', [{ id: 'part1', unit_cost_cents: 1000, price_book_item_id: 'pb1' }, { id: 'part2', unit_cost_cents: 5000, price_book_item_id: null }]);
    db.seed('price_book_items', [{ id: 'pb1', price_cents: 7500 }]);
    db.seed('job_parts_required', [
      { job_id: 'leak', part_id: 'part1', quantity_required: 2, status: 'installed' },   // 2 * 7500 = 15000 -> gap 5000
      { job_id: 'small', part_id: 'part2', quantity_required: 1, status: 'installed' },  // 5000 vs 10000 invoiced -> no gap
      { job_id: 'noparts', part_id: 'part2', quantity_required: 9, status: 'planned' },  // not installed
    ]);
    const body = await jsonOf(await run());
    expect(body.flagged.parts).toBe(1);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ source_id: 'leak', source_type: 'job_parts_unbilled', estimated_value_cents: 5000, estimated_value_basis: 'price_book_match' });
  });

  it('payment failed: flags failed requests the same day', async () => {
    db.seed('payment_requests', [{ id: 'pf', user_id: A, job_id: null, customer_name: 'C', customer_phone: '1', customer_email: 'c@x.test', amount: 42.1, status: 'failed', created_at: hoursAgo(1) }]);
    const body = await jsonOf(await run());
    expect(body.flagged.paymentFailed).toBe(1);
    expect(ledger()[0]).toMatchObject({ source_type: 'payment_failed', estimated_value_cents: 4210, lead_id: null });
    expect(enrolls()[0].payload).toMatchObject({ p_event_type: 'invoice.payment_failed', p_aggregate_type: 'payment_request' });
  });

  it('caps the risk score at 100 (60 time + 40 value)', async () => {
    db.seed('quotes', [quote({ sent_at: daysAgo(100), line_items: { subtotal_cents: 99_000_000 } })]);
    await run();
    expect(enrolls()[0].payload.p_event_data.risk_score).toBe(100);
  });
});

describe('estimate-recovery-agent — tenant isolation', () => {
  it('stamps every ledger row and activity event with the SOURCE row\'s tenant, never mixing A and B', async () => {
    db.seed('quotes', [quote({ id: 'qa', user_id: A }), quote({ id: 'qb', user_id: B, customer_name: 'Bob' })]);
    db.seed('payment_requests', [{ id: 'pb', user_id: B, job_id: null, customer_name: 'Bea', customer_phone: '2', customer_email: 'b@x.test', amount: 10, status: 'failed', created_at: hoursAgo(1) }]);
    await run();
    const owner = (id: string) => ledger().find((r) => r.source_id === id)?.user_id;
    expect(owner('qa')).toBe(A);
    expect(owner('qb')).toBe(B);
    expect(owner('pb')).toBe(B);
    for (const c of enrolls()) {
      const expected = ledger().find((r) => r.source_id === c.payload.p_aggregate_id)!.user_id;
      expect(c.payload.p_user_id).toBe(expected);
    }
    expect(enrolls().find((c) => c.payload.p_aggregate_id === 'qb')!.payload.p_event_data.customer_name).toBe('Bob');
  });
});

describe('estimate-recovery-agent — idempotent re-runs', () => {
  it('a second run does not create a second ledger row and never overwrites a human-triaged one', async () => {
    db.seed('quotes', [quote({ id: 'q1' }), quote({ id: 'q2' })]);
    db.seed('revenue_recovery_events', [{ id: 'led-q2', user_id: A, source_table: 'quotes', source_id: 'q2', source_type: 'quote_financing_stalled', status: 'contacted', notes: 'called her' }]);
    await run();
    await run();
    expect(ledger().filter((r) => r.source_id === 'q1')).toHaveLength(1);
    const triaged = ledger().find((r) => r.source_id === 'q2')!;
    expect(triaged).toMatchObject({ id: 'led-q2', status: 'contacted', notes: 'called her' });
    expect(ledger()).toHaveLength(2);
  });

  it('KNOWN GAP: the activity event is re-appended on EVERY run (append_activity_event is append-only); de-duplication relies on the workflow trigger, not on this function', async () => {
    db.seed('quotes', [quote()]);
    await run();
    await run();
    await run();
    expect(enrolls()).toHaveLength(3);
  });
});

describe('estimate-recovery-agent — malformed / missing data', () => {
  it('treats a missing subtotal as $0 and skips the financing flag', async () => {
    db.seed('quotes', [quote({ line_items: null }), quote({ id: 'q2', line_items: { subtotal_cents: undefined } })]);
    await run();
    expect(ledger()).toHaveLength(0);
  });

  it('KNOWN GAP: a non-numeric tax_percent yields NaN, which slips past the "< $500" guard and is written to the ledger', async () => {
    db.seed('quotes', [quote({ tax_percent: 'abc' })]);
    await run();
    expect(db.calls('revenue_recovery_events', 'upsert')).toHaveLength(1);
    expect(Number.isNaN(db.calls('revenue_recovery_events', 'upsert')[0].payload.estimated_value_cents)).toBe(true);
  });

  it('survives rows with null contact fields', async () => {
    db.seed('quotes', [quote({ customer_phone: null, customer_email: null, customer_name: null })]);
    const res = await run();
    expect(res.status).toBe(200);
    expect(enrolls()[0].payload.p_event_data).toMatchObject({ customer_phone: null, customer_email: null });
  });
});

describe('estimate-recovery-agent — external-service failure', () => {
  it('KNOWN GAP: a failing quotes query is swallowed and the run reports ok:true with zero flags (cron looks healthy while blind)', async () => {
    db.seed('quotes', [quote()]);
    db.failOn({ table: 'quotes', op: 'select', error: { message: 'connection refused' } });
    const res = await run();
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).flagged.financing).toBe(0);
  });

  it('KNOWN GAP: a failed ledger upsert is ignored, yet the item is still counted as flagged and enrolled', async () => {
    db.seed('quotes', [quote()]);
    db.failOn({ table: 'revenue_recovery_events', op: 'upsert', error: { message: 'check constraint violated' } });
    const body = await jsonOf(await run());
    expect(body.flagged.financing).toBe(1);
    expect(ledger()).toHaveLength(0);
    expect(enrolls()).toHaveLength(1);
  });

  it('an RPC that throws (network drop) aborts the run: the handler rejects and later detectors do not run', async () => {
    db.seed('quotes', [quote()]);
    db.seed('payment_requests', [{ id: 'pf', user_id: A, job_id: null, customer_name: 'C', customer_phone: '1', customer_email: 'c@x.test', amount: 5, status: 'failed', created_at: hoursAgo(1) }]);
    db.failOn({ rpc: 'append_activity_event', mode: 'throw', error: { message: 'fetch failed' } });
    await expect(run()).rejects.toThrow('fetch failed');
    expect(ledger().map((r) => r.source_id)).toEqual(['q1']); // payment_failed detector never reached
  });
});
