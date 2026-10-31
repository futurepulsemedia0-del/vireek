// @vitest-environment node
// Reliability tests for send-payment-reminders. Real index.ts + real i18n templates; supabase-js is the in-memory FakeDb,
// SMS/email delivery and customer-language lookup are mocked. "KNOWN GAP" tests pin CURRENT behaviour that is a weakness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, jsonOf, loadHandler, options, post, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const deliver = vi.hoisted(() => ({ sendSms: vi.fn(), sendEmail: vi.fn(), lang: vi.fn() }));
vi.mock('../_shared/notify/deliver.ts', () => ({ sendSms: (...a: unknown[]) => deliver.sendSms(...a), sendEmail: (...a: unknown[]) => deliver.sendEmail(...a) }));
vi.mock('../_shared/i18n/customerLanguage.ts', () => ({ resolveCustomerLanguage: (...a: unknown[]) => deliver.lang(...a) }));

const NOW = '2026-10-28T12:00:00.000Z';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86400_000).toISOString();

let db: FakeDb;
let env: Record<string, string | undefined>;
let handler: Handler;

const pr = (o: Record<string, unknown> = {}) => ({
  id: 'r1', user_id: A, customer_name: 'Ann', customer_email: 'ann@x.test', customer_phone: '+15550001', amount: 120.5,
  payment_link_url: 'https://pay.test/r1', reminder_count: 0, created_at: daysAgo(5), status: 'sent', settlement_status: 'none', last_reminder_sent_at: daysAgo(4), ...o,
});
const run = (headers: Record<string, string> = { 'X-Cron-Secret': 'rem-secret' }) => handler(post({}, headers));
const table = () => db.rows('payment_requests');

async function boot(extra: Record<string, string | undefined> = {}) {
  env = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', PAYMENT_REMINDER_CRON_SECRET: 'rem-secret', ...extra };
  handler = await loadHandler(() => import('./index.ts'), env);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  sb.create = db.createClient;
  deliver.sendSms.mockReset().mockResolvedValue({ ok: true });
  deliver.sendEmail.mockReset().mockResolvedValue({ ok: true });
  deliver.lang.mockReset().mockResolvedValue('en');
  captureErrors();
  await boot();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('send-payment-reminders — auth', () => {
  it('answers CORS preflight without DB access', async () => {
    expect((await handler(options())).status).toBe(200);
    expect(db.log).toHaveLength(0);
  });

  it('rejects a missing or wrong X-Cron-Secret (401) and contacts nobody', async () => {
    table().push(pr());
    expect((await run({})).status).toBe(401);
    expect((await run({ 'X-Cron-Secret': 'bad' })).status).toBe(401);
    expect(db.log).toHaveLength(0);
    expect(deliver.sendSms).not.toHaveBeenCalled();
    expect(deliver.sendEmail).not.toHaveBeenCalled();
  });

  it('accepts the correct secret', async () => {
    expect((await run()).status).toBe(200);
  });

  it('KNOWN GAP: fails OPEN when PAYMENT_REMINDER_CRON_SECRET is unset — anyone can trigger customer SMS/email sends', async () => {
    await boot({ PAYMENT_REMINDER_CRON_SECRET: undefined });
    table().push(pr());
    const res = await run({});
    expect(res.status).toBe(200);
    expect(deliver.sendSms).toHaveBeenCalledTimes(1);
  });
});

describe('send-payment-reminders — selection', () => {
  it('reminds sent/overdue requests that are >3 days since the last reminder and under 3 reminders', async () => {
    table().push(
      pr({ id: 'ok' }),
      pr({ id: 'recent', last_reminder_sent_at: daysAgo(1) }),
      pr({ id: 'maxed', reminder_count: 3 }),
      pr({ id: 'paid', status: 'paid' }),
      pr({ id: 'processing', settlement_status: 'processing' }),
      pr({ id: 'overdue', status: 'overdue', reminder_count: 2 }),
    );
    const body = await jsonOf(await run());
    expect(body.reminders_sent).toBe(2);
    expect(table().filter((r) => r.reminder_count > 0 || r.id === 'overdue').map((r) => r.id).sort()).toEqual(['maxed', 'ok', 'overdue']);
    expect(table().find((r) => r.id === 'ok')!.reminder_count).toBe(1);
    expect(table().find((r) => r.id === 'recent')!.reminder_count).toBe(0);
    expect(table().find((r) => r.id === 'paid')!.reminder_count).toBe(0);
  });

  it('KNOWN FRAGILITY: a request whose last_reminder_sent_at is NULL is never selected (SQL NULL < x is unknown). Safe today only because every creator (create-payment-request, membership-*, recurring-jobs) stamps it at creation', async () => {
    table().push(pr({ last_reminder_sent_at: null }));
    expect((await jsonOf(await run())).reminders_sent).toBe(0);
    expect(deliver.sendSms).not.toHaveBeenCalled();
  });

  it('flips a request created more than 14 days ago to "overdue", and leaves younger ones as they were', async () => {
    table().push(pr({ id: 'old', created_at: daysAgo(15) }), pr({ id: 'young', created_at: daysAgo(10) }));
    await run();
    expect(table().find((r) => r.id === 'old')!.status).toBe('overdue');
    expect(table().find((r) => r.id === 'young')!.status).toBe('sent');
  });
});

describe('send-payment-reminders — delivery', () => {
  it('sends SMS + email with the formatted amount and link, and stamps the reminder', async () => {
    table().push(pr());
    await run();
    expect(deliver.sendSms).toHaveBeenCalledTimes(1);
    const [phone, text] = deliver.sendSms.mock.calls[0];
    expect(phone).toBe('+15550001');
    expect(text).toContain('$120.50');
    expect(text).toContain('https://pay.test/r1');
    const [to, subject, html] = deliver.sendEmail.mock.calls[0];
    expect(to).toBe('ann@x.test');
    expect(subject).toBeTruthy();
    expect(html).toContain('href="https://pay.test/r1"');
    expect(table()[0]).toMatchObject({ reminder_count: 1, last_reminder_sent_at: NOW });
  });

  it('only uses the channels the customer has', async () => {
    table().push(pr({ id: 'smsonly', customer_email: null }), pr({ id: 'mailonly', customer_phone: null }));
    await run();
    expect(deliver.sendSms).toHaveBeenCalledTimes(1);
    expect(deliver.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('KNOWN GAP: a customer with neither phone nor email still burns a reminder (count increments, nothing is sent)', async () => {
    table().push(pr({ customer_phone: null, customer_email: null }));
    expect((await jsonOf(await run())).reminders_sent).toBe(1);
    expect(deliver.sendSms).not.toHaveBeenCalled();
    expect(deliver.sendEmail).not.toHaveBeenCalled();
    expect(table()[0].reminder_count).toBe(1);
  });

  it('HTML-escapes customer-controlled values in the email (name / link)', async () => {
    table().push(pr({ customer_name: '<img src=x onerror=alert(1)>', payment_link_url: 'https://x.test/?a=1&b="2"' }));
    await run();
    const html = deliver.sendEmail.mock.calls[0][2] as string;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('"2"');
    expect(html).toContain('&amp;');
  });

  it('tolerates null name / link / non-numeric amount without throwing', async () => {
    table().push(pr({ customer_name: null, payment_link_url: null, amount: 'abc' }));
    const res = await run();
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).reminders_sent).toBe(1);
  });
});

describe('send-payment-reminders — tenant isolation', () => {
  it('each tenant\'s customer gets only their own link, in the language resolved for that tenant', async () => {
    table().push(
      pr({ id: 'ra', user_id: A, customer_phone: '+1A', customer_email: null, payment_link_url: 'https://pay.test/ra' }),
      pr({ id: 'rb', user_id: B, customer_phone: '+1B', customer_email: null, payment_link_url: 'https://pay.test/rb' }),
    );
    deliver.lang.mockImplementation(async (_db: unknown, userId: string) => (userId === B ? 'es' : 'en'));
    await run();
    expect(deliver.lang.mock.calls.map((c) => c[1]).sort()).toEqual([A, B]);
    for (const [phone, text] of deliver.sendSms.mock.calls) {
      expect(text).toContain(phone === '+1A' ? '/ra' : '/rb');
      expect(text).not.toContain(phone === '+1A' ? '/rb' : '/ra');
    }
  });

  it('updates only the row it just reminded (by id) — other tenants\' rows are untouched', async () => {
    table().push(pr({ id: 'ra', user_id: A }), pr({ id: 'rb', user_id: B, last_reminder_sent_at: daysAgo(1) }));
    await run();
    expect(table().find((r) => r.id === 'ra')!.reminder_count).toBe(1);
    expect(table().find((r) => r.id === 'rb')!.reminder_count).toBe(0);
    expect(db.calls('payment_requests', 'update').every((c) => c.filters.some(([col, op]) => col === 'id' && op === 'eq'))).toBe(true);
  });
});

describe('send-payment-reminders — idempotent re-runs', () => {
  it('a second run right after sends nothing (last_reminder_sent_at is now within the 3-day interval)', async () => {
    table().push(pr());
    await run();
    await run();
    expect(deliver.sendSms).toHaveBeenCalledTimes(1);
  });

  it('after 3 days the next reminder is sent, and it stops for good at 3', async () => {
    table().push(pr());
    for (let i = 0; i < 6; i++) {
      await run();
      vi.setSystemTime(new Date(Date.parse(NOW) + (i + 1) * 3.1 * 86400_000));
    }
    expect(deliver.sendSms).toHaveBeenCalledTimes(3);
    expect(table()[0].reminder_count).toBe(3);
  });
});

describe('send-payment-reminders — external-service failure', () => {
  it('KNOWN GAP: one SMS throw aborts the whole run (500) — customers after it are not reminded; earlier ones keep their stamp', async () => {
    table().push(pr({ id: 'first' }), pr({ id: 'boom', customer_phone: '+boom' }), pr({ id: 'last' }));
    deliver.sendSms.mockImplementation(async (to: string) => { if (to === '+boom') throw new Error('twilio down'); return { ok: true }; });
    const res = await run();
    expect(res.status).toBe(500);
    expect(await jsonOf(res)).toEqual({ error: 'Reminder run failed.' });
    expect(table().find((r) => r.id === 'first')!.reminder_count).toBe(1);
    expect(table().find((r) => r.id === 'boom')!.reminder_count).toBe(0);
    expect(table().find((r) => r.id === 'last')!.reminder_count).toBe(0);
  });

  it('KNOWN GAP: SMS ok but email throws -> the row is not stamped, so the customer gets the SMS again next run', async () => {
    table().push(pr());
    deliver.sendEmail.mockRejectedValueOnce(new Error('resend down'));
    expect((await run()).status).toBe(500);
    expect(table()[0].reminder_count).toBe(0);
    await run();
    expect(deliver.sendSms).toHaveBeenCalledTimes(2);
  });

  it('KNOWN GAP: a { ok:false } result from SMS/email (e.g. Twilio not configured) is ignored — the reminder is still counted as sent', async () => {
    table().push(pr());
    deliver.sendSms.mockResolvedValue({ ok: false, error: 'SMS isn\'t configured yet' });
    deliver.sendEmail.mockResolvedValue({ ok: false, error: 'bad key' });
    expect((await jsonOf(await run())).reminders_sent).toBe(1);
    expect(table()[0].reminder_count).toBe(1);
  });

  it('KNOWN GAP: a failed stamp update is not detected — the customer is re-reminded on the next run', async () => {
    table().push(pr());
    db.failOn({ table: 'payment_requests', op: 'update', times: 1, error: { message: 'write failed' } });
    expect((await jsonOf(await run())).reminders_sent).toBe(1);
    await run();
    expect(deliver.sendSms).toHaveBeenCalledTimes(2);
  });

  it('a failing selection query returns 500 and sends nothing', async () => {
    table().push(pr());
    db.failOn({ table: 'payment_requests', op: 'select', error: { message: 'db down' } });
    const res = await run();
    expect(res.status).toBe(500);
    expect(deliver.sendSms).not.toHaveBeenCalled();
  });
});
