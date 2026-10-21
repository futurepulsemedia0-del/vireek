import { describe, expect, it, vi } from 'vitest';
import { runRenewalPipeline, rollMembershipPeriod, type PipelineDeps } from './pipeline';

type Row = Record<string, any>;

const toTime = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(v).getTime() : (v as number));

/** Minimal in-memory stand-in for the Supabase admin client: just the chain the pipeline uses. */
function fakeAdmin(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const log: { table: string; op: string; values?: any; opts?: any }[] = [];
  let seq = 1;

  function from(table: string) {
    tables[table] ??= [];
    let op = 'select';
    let values: any;
    let opts: any;
    let wantRows = false;
    let limit = Infinity;
    let single: 'single' | 'maybe' | null = null;
    const filters: ((r: Row) => boolean)[] = [];
    const f = (fn: (r: Row) => boolean) => { filters.push(fn); return api; };

    const exec = () => {
      const match = () => tables[table].filter((r) => filters.every((fn) => fn(r)));
      if (op === 'select') {
        const rows = match().slice(0, limit);
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      if (op === 'insert') {
        const inserted = (Array.isArray(values) ? values : [values]).map((v) => {
          const id = `${table}-${seq++}`;
          const row = { id, ...(table === 'payment_requests' ? { public_token: `tok-${id}` } : {}), ...v };
          tables[table].push(row);
          return row;
        });
        log.push({ table, op, values });
        return { data: single ? inserted[0] : inserted, error: null };
      }
      if (op === 'update') {
        const matched = match();
        matched.forEach((r) => Object.assign(r, values));
        log.push({ table, op, values });
        return { data: wantRows ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (op === 'upsert') {
        const keys = String(opts?.onConflict ?? 'id').split(',');
        for (const v of Array.isArray(values) ? values : [values]) {
          const dup = tables[table].some((r) => keys.every((k) => toTime(r[k]) === toTime(v[k])));
          if (!dup) tables[table].push({ id: `${table}-${seq++}`, ...v });
        }
        log.push({ table, op, values, opts });
        return { data: null, error: null };
      }
      // delete
      const doomed = new Set(match());
      tables[table] = tables[table].filter((r) => !doomed.has(r));
      log.push({ table, op });
      return { data: null, error: null };
    };

    const api: any = {
      select: () => { if (op !== 'select') wantRows = true; return api; },
      insert: (v: any) => { op = 'insert'; values = v; return api; },
      update: (v: any) => { op = 'update'; values = v; return api; },
      upsert: (v: any, o: any) => { op = 'upsert'; values = v; opts = o; return api; },
      delete: () => { op = 'delete'; return api; },
      eq: (c: string, v: unknown) => f((r) => r[c] === v),
      in: (c: string, vs: unknown[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: unknown) => f((r) => (r[c] ?? null) === v),
      gt: (c: string, v: unknown) => f((r) => toTime(r[c]) > toTime(v)),
      gte: (c: string, v: unknown) => f((r) => toTime(r[c]) >= toTime(v)),
      lt: (c: string, v: unknown) => f((r) => toTime(r[c]) < toTime(v)),
      lte: (c: string, v: unknown) => f((r) => toTime(r[c]) <= toTime(v)),
      limit: (n: number) => { limit = n; return api; },
      maybeSingle: () => { single = 'maybe'; return api; },
      single: () => { single = 'single'; return api; },
      then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
    };
    return api;
  }
  return { admin: { from }, tables, log };
}

const NOW = new Date('2027-03-01T12:00:00Z');
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

const PLAN = { name: 'Annual Maintenance', price_cents: 29900, renewal_price_cents: null, billing_interval: 'yearly', visits_included_per_period: 2, public_slug: 'annual-1' };
const CARD = {
  stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1', card_brand: 'visa', card_last4: '4242',
  card_exp_month: 12, card_exp_year: 2030, auto_renew_consent_at: '2026-03-01T00:00:00Z',
};

function member(over: Row = {}): Row {
  return {
    id: 'm1', user_id: 'u1', plan_id: 'p1', lead_id: null, status: 'active', auto_renew: true,
    customer_name: 'Dana Smith', customer_phone: '+15551230000', customer_email: 'dana@example.com',
    current_period_start: iso(-365), current_period_end: iso(50), last_payment_request_id: null, dunning_stage: 0,
    stripe_customer_id: null, stripe_payment_method_id: null, card_brand: null, card_last4: null,
    card_exp_month: null, card_exp_year: null, auto_renew_consent_at: null,
    membership_plans: PLAN,
    ...over,
  };
}

function cycle(over: Row = {}): Row {
  const m = over.memberships ?? member();
  return {
    id: 'c1', user_id: 'u1', membership_id: m.id, period_end: m.current_period_end, stage: 'upcoming_60',
    amount_cents: 29900, previous_amount_cents: 29900, payment_route: 'pay_link', quote_token: 'qtok', quote_status: 'sent',
    notices_sent: [], charge_attempts: 0, last_charge_attempt_at: null, payment_request_id: null, outcome: null,
    memberships: m, membership_plans: PLAN,
    ...over,
  };
}

function deps(over: Partial<PipelineDeps> = {}) {
  const sms = vi.fn(async () => undefined);
  const email = vi.fn(async () => undefined);
  const enroll = vi.fn(async () => undefined);
  const d: PipelineDeps = { now: NOW, siteUrl: 'https://vireek.com', sendSms: sms, sendEmail: email, enroll, ...over };
  return { d, sms, email, enroll };
}

const CONNECT = [{ user_id: 'u1', stripe_account_id: 'acct_1', charges_enabled: true }];

describe('open cycles', () => {
  it('opens a cycle inside the 60-day window with the renewal price and the right route', async () => {
    const { admin, tables } = fakeAdmin({ memberships: [member({ ...CARD })] });
    const { d } = deps();
    const counts = await runRenewalPipeline(admin, d);
    expect(counts.cycles_opened).toBe(1);
    const c = tables.membership_renewal_cycles[0];
    expect(c).toMatchObject({ membership_id: 'm1', stage: 'upcoming_60', amount_cents: 29900, payment_route: 'card_on_file', quote_status: 'sent' });
  });

  it('skips renewals outside the window, already overdue, free plans, and monthly plans too far out', async () => {
    const { admin, tables } = fakeAdmin({
      memberships: [
        member({ id: 'far', current_period_end: iso(90) }),
        member({ id: 'past', current_period_end: iso(-2) }),
        member({ id: 'free', membership_plans: { ...PLAN, price_cents: 0 } }),
        member({ id: 'm-far', current_period_end: iso(20), membership_plans: { ...PLAN, billing_interval: 'monthly' } }),
      ],
    });
    await runRenewalPipeline(admin, deps().d);
    expect(tables.membership_renewal_cycles ?? []).toHaveLength(0);
  });

  it('opens a monthly plan only inside its 7-day window', async () => {
    const { admin, tables } = fakeAdmin({ memberships: [member({ current_period_end: iso(5), membership_plans: { ...PLAN, billing_interval: 'monthly' } })] });
    await runRenewalPipeline(admin, deps().d);
    expect(tables.membership_renewal_cycles[0].stage).toBe('upcoming_7');
  });

  it('applies a renewal price override and marks a member who turned auto-renew off as declined', async () => {
    const { admin, tables } = fakeAdmin({ memberships: [member({ auto_renew: false, membership_plans: { ...PLAN, renewal_price_cents: 32900 } })] });
    await runRenewalPipeline(admin, deps().d);
    expect(tables.membership_renewal_cycles[0]).toMatchObject({ amount_cents: 32900, previous_amount_cents: 29900, quote_status: 'declined' });
  });

  it('is idempotent: a second run never duplicates the cycle', async () => {
    const { admin, tables } = fakeAdmin({ memberships: [member()] });
    await runRenewalPipeline(admin, deps().d);
    const second = await runRenewalPipeline(admin, deps().d);
    expect(tables.membership_renewal_cycles).toHaveLength(1);
    expect(second.cycles_opened).toBe(0);
  });
});

describe('advance cycles and notices', () => {
  it('sends the 30-day reminder once, with the renewal link, and never again', async () => {
    const m = member({ current_period_end: iso(25), ...CARD });
    const { admin, tables } = fakeAdmin({ memberships: [m], membership_renewal_cycles: [cycle({ memberships: m, notices_sent: ['60'], stage: 'upcoming_60', payment_route: 'card_on_file' })] });
    const { d, sms, email } = deps();
    const first = await runRenewalPipeline(admin, d);
    expect(first.notices_sent).toBe(1);
    expect(sms).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
    const text = (sms.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain('https://vireek.com/renew/qtok');
    expect(text).toContain('Visa ending 4242');
    expect(tables.membership_renewal_cycles[0]).toMatchObject({ stage: 'upcoming_30', notices_sent: ['60', '30'] });

    const second = await runRenewalPipeline(admin, d);
    expect(second.notices_sent).toBe(0);
    expect(sms).toHaveBeenCalledTimes(1);
  });

  it('does not send the 7-day text to pay-link members (the agent invoices them), but still marks it', async () => {
    const m = member({ current_period_end: iso(6) });
    const { admin, tables } = fakeAdmin({ memberships: [m], membership_renewal_cycles: [cycle({ memberships: m, notices_sent: ['60', '30'], stage: 'upcoming_30' })] });
    const { d, sms } = deps();
    await runRenewalPipeline(admin, d);
    expect(sms).not.toHaveBeenCalled();
    expect(tables.membership_renewal_cycles[0]).toMatchObject({ stage: 'upcoming_7', notices_sent: ['60', '30', '7'] });
  });

  it('never notifies a member who turned auto-renew off', async () => {
    const m = member({ auto_renew: false, current_period_end: iso(25) });
    const { admin } = fakeAdmin({ memberships: [m], membership_renewal_cycles: [cycle({ memberships: m, quote_status: 'declined' })] });
    const { d, sms } = deps();
    await runRenewalPipeline(admin, d);
    expect(sms).not.toHaveBeenCalled();
  });

  it('falls back to the pay link when the saved card will have expired by the renewal date', async () => {
    const m = member({ current_period_end: iso(40), ...CARD, card_exp_month: 3, card_exp_year: 2027 }); // renews Apr 10, card dies end of March
    const { admin, tables } = fakeAdmin({ memberships: [m], membership_renewal_cycles: [cycle({ memberships: m, notices_sent: ['60'], payment_route: 'card_on_file' })] });
    await runRenewalPipeline(admin, deps().d);
    expect(tables.membership_renewal_cycles[0].payment_route).toBe('pay_link');
  });

  it('drops an orphan cycle when the renewal date was edited', async () => {
    const m = member({ current_period_end: iso(80) });
    const { admin, tables } = fakeAdmin({ memberships: [m], membership_renewal_cycles: [cycle({ memberships: m, period_end: iso(40) })] });
    await runRenewalPipeline(admin, deps().d);
    expect(tables.membership_renewal_cycles.find((c) => c.id === 'c1')).toBeUndefined();
  });

  it('a failing text message never blocks the email or the run', async () => {
    const m = member({ current_period_end: iso(25) });
    const { admin } = fakeAdmin({ memberships: [m], membership_renewal_cycles: [cycle({ memberships: m, notices_sent: ['60'] })] });
    const { d, email } = deps({ sendSms: vi.fn(async () => { throw new Error('twilio down'); }) });
    const counts = await runRenewalPipeline(admin, d);
    expect(email).toHaveBeenCalledTimes(1);
    expect(counts.errors).toBe(0);
  });
});

describe('card-on-file charge', () => {
  const due = () => member({ current_period_end: iso(-0.1), ...CARD });
  const setup = (over: Row = {}, cycleOver: Row = {}) => {
    const m = due();
    return fakeAdmin({
      memberships: [m],
      stripe_connect_accounts: CONNECT,
      membership_renewal_cycles: [cycle({ memberships: m, stage: 'due', payment_route: 'card_on_file', notices_sent: ['60', '30', '7'], ...cycleOver })],
      ...over,
    });
  };

  it('charges the saved card off-session, records it in the ledger, rolls the period and sends a receipt', async () => {
    const { admin, tables } = setup();
    const charge = vi.fn(async (i: any) => ({ outcome: 'succeeded' as const, intent: { id: 'pi_1', status: 'succeeded', metadata: i.metadata } }));
    const finalize = vi.fn(async () => ({ handled: true, status: 'paid' }));
    const { d, sms } = deps({ charge, finalize });
    const counts = await runRenewalPipeline(admin, d);

    expect(counts.charged).toBe(1);
    const arg = charge.mock.calls[0][0] as any;
    expect(arg).toMatchObject({ amountCents: 29900, customerId: 'cus_1', paymentMethodId: 'pm_1', destinationAccountId: 'acct_1', idempotencyKey: 'membership-renewal-c1-0' });
    expect(arg.metadata).toMatchObject({ payment_request_id: tables.payment_requests[0].id, membership_id: 'm1', renewal_cycle_id: 'c1', tip_cents: '0' });
    expect(tables.payment_requests[0]).toMatchObject({ amount: 299, status: 'sent' });
    expect(finalize).toHaveBeenCalledTimes(1);

    const m = tables.memberships[0];
    expect(m.status).toBe('active');
    expect(new Date(m.current_period_end).getUTCFullYear()).toBe(new Date(m.current_period_start).getUTCFullYear() + 1);
    expect(m.visits_used_current_period).toBe(0);
    expect(m.last_payment_request_id).toBe(tables.payment_requests[0].id);
    expect(tables.membership_renewal_cycles[0]).toMatchObject({ charge_attempts: 1, last_charge_error: null });
    expect((sms.mock.calls[0] as unknown as [string, string])[1]).toContain('renewed');
  });

  it('does not roll the period when the ledger disagrees with the charge', async () => {
    const { admin, tables } = setup();
    const before = tables.memberships[0].current_period_end;
    const charge = vi.fn(async () => ({ outcome: 'succeeded' as const, intent: { id: 'pi_1', status: 'succeeded', metadata: {} } }));
    const counts = await runRenewalPipeline(admin, deps({ charge, finalize: async () => ({ handled: true, status: 'amount_mismatch' }) }).d);
    expect(tables.memberships[0].current_period_end).toBe(before);
    expect(counts.errors).toBe(1);
    expect(tables.membership_renewal_cycles[0].charge_attempts).toBe(3); // stops retrying until a human looks
  });

  it('a decline moves the member to past_due with a grace period and sends the pay link', async () => {
    const { admin, tables } = setup();
    const charge = vi.fn(async () => ({ outcome: 'declined' as const, message: 'Your card was declined.' }));
    const { d, sms } = deps({ charge });
    const counts = await runRenewalPipeline(admin, d);

    expect(counts.charge_declined).toBe(1);
    const m = tables.memberships[0];
    expect(m.status).toBe('past_due');
    expect(m.dunning_stage).toBe(1);
    expect(new Date(m.payment_grace_period_ends_at).getTime() - NOW.getTime()).toBe(14 * 86_400_000);
    expect(tables.membership_renewal_cycles[0]).toMatchObject({ charge_attempts: 1, last_charge_error: 'Your card was declined.' });
    expect((sms.mock.calls[0] as unknown as [string, string])[1]).toContain(`/pay/${tables.payment_requests[0].public_token}`);
  });

  it('does not charge twice in a row, retries after 3 days with a fresh idempotency key, and gives up after 3 attempts', async () => {
    const { admin, tables } = setup();
    const charge = vi.fn(async () => ({ outcome: 'declined' as const, message: 'declined' }));

    await runRenewalPipeline(admin, deps({ charge }).d);
    await runRenewalPipeline(admin, deps({ charge, now: new Date(NOW.getTime() + 3_600_000) }).d);
    expect(charge).toHaveBeenCalledTimes(1);

    // The row the pipeline reads is the one seeded in the cycle embed: reflect the member's new status like Postgres would.
    const sync = () => { tables.membership_renewal_cycles[0].memberships = { ...tables.memberships[0] }; };
    sync();
    await runRenewalPipeline(admin, deps({ charge, now: new Date(NOW.getTime() + 3 * 86_400_000) }).d);
    expect(charge).toHaveBeenCalledTimes(2);
    expect((charge.mock.calls[1][0] as any).idempotencyKey).toBe('membership-renewal-c1-1');

    sync();
    await runRenewalPipeline(admin, deps({ charge, now: new Date(NOW.getTime() + 8 * 86_400_000) }).d);
    expect(charge).toHaveBeenCalledTimes(3);
    sync();
    await runRenewalPipeline(admin, deps({ charge, now: new Date(NOW.getTime() + 12 * 86_400_000) }).d);
    expect(charge).toHaveBeenCalledTimes(3);
    expect(tables.membership_renewal_cycles[0].charge_attempts).toBe(3);
  });

  it('hands off to the pay link when the bank requires authentication, and stops retrying', async () => {
    const { admin, tables } = setup();
    const charge = vi.fn(async () => ({ outcome: 'requires_action' as const }));
    const { d, sms } = deps({ charge });
    const counts = await runRenewalPipeline(admin, d);
    expect(counts.charge_requires_action).toBe(1);
    expect(tables.membership_renewal_cycles[0]).toMatchObject({ charge_attempts: 3, payment_route: 'pay_link', last_charge_error: 'authentication_required' });
    expect((sms.mock.calls[0] as unknown as [string, string])[1]).toContain('/pay/');
  });

  it('leaves the attempt untouched on a transient Stripe error', async () => {
    const { admin, tables } = setup();
    const charge = vi.fn(async () => ({ outcome: 'retry' as const }));
    await runRenewalPipeline(admin, deps({ charge }).d);
    expect(tables.membership_renewal_cycles[0].charge_attempts).toBe(0);
    expect(tables.memberships[0].status).toBe('active');
  });

  it('never charges: a declined renewal, no consent, an expired card, a not-ready Stripe account, or no charge dependency', async () => {
    const charge = vi.fn(async () => ({ outcome: 'succeeded' as const, intent: {} }));
    for (const [name, make, dep] of [
      ['declined quote', () => setup({}, { quote_status: 'declined' }), { charge }],
      ['no consent', () => { const m = member({ current_period_end: iso(-0.1), ...CARD, auto_renew_consent_at: null }); return fakeAdmin({ memberships: [m], stripe_connect_accounts: CONNECT, membership_renewal_cycles: [cycle({ memberships: m })] }); }, { charge }],
      ['expired card', () => { const m = member({ current_period_end: iso(-0.1), ...CARD, card_exp_month: 1, card_exp_year: 2027 }); return fakeAdmin({ memberships: [m], stripe_connect_accounts: CONNECT, membership_renewal_cycles: [cycle({ memberships: m })] }); }, { charge }],
      ['stripe not ready', () => setup({ stripe_connect_accounts: [{ user_id: 'u1', stripe_account_id: 'acct_1', charges_enabled: false }] }), { charge }],
      ['no charge dep', () => setup(), {}],
    ] as const) {
      const { admin } = make();
      await runRenewalPipeline(admin, deps(dep as Partial<PipelineDeps>).d);
      expect(charge, name).not.toHaveBeenCalled();
    }
  });

  it('rolls without charging when the renewal request was already paid through the pay link', async () => {
    const m = due();
    const { admin, tables } = fakeAdmin({
      memberships: [m],
      stripe_connect_accounts: CONNECT,
      payment_requests: [{ id: 'pr1', status: 'paid', public_token: 'tok' }],
      membership_renewal_cycles: [cycle({ memberships: m, payment_request_id: 'pr1', payment_route: 'card_on_file' })],
    });
    const charge = vi.fn();
    await runRenewalPipeline(admin, deps({ charge: charge as any }).d);
    expect(charge).not.toHaveBeenCalled();
    expect(new Date(tables.memberships[0].current_period_end).getUTCFullYear()).toBe(new Date(m.current_period_end).getUTCFullYear() + 1);
  });
});

describe('non-renewing memberships', () => {
  it('closes at the end of the paid period, logs recovery and starts the win-back sequence with a rejoin link', async () => {
    const m = member({ auto_renew: false, current_period_end: iso(-2) });
    const { admin, tables } = fakeAdmin({ memberships: [m] });
    const { d, enroll } = deps();
    const counts = await runRenewalPipeline(admin, d);

    expect(counts.closed_non_renewing).toBe(1);
    expect(tables.memberships[0]).toMatchObject({ status: 'cancelled' });
    expect(tables.revenue_recovery_events[0]).toMatchObject({ source_type: 'membership_cancelled', source_table: 'memberships', source_id: 'm1', estimated_value_cents: 29900 });
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'membership.churned',
      aggregateId: 'm1',
      extra: expect.objectContaining({ reason: 'did_not_renew', plan_join_url: 'https://vireek.com/join/annual-1', amount: '$299' }),
    }));
  });

  it('leaves long-expired legacy rows alone (no surprise win-back texts on first deploy)', async () => {
    const m = member({ auto_renew: false, current_period_end: iso(-90) });
    const { admin, tables } = fakeAdmin({ memberships: [m] });
    const { d, enroll } = deps();
    await runRenewalPipeline(admin, d);
    expect(tables.memberships[0].status).toBe('active');
    expect(enroll).not.toHaveBeenCalled();
  });

  it('keeps renewing members active', async () => {
    const m = member({ auto_renew: true, current_period_end: iso(-2) });
    const { admin, tables } = fakeAdmin({ memberships: [m] });
    await runRenewalPipeline(admin, deps().d);
    expect(tables.memberships[0].status).toBe('active');
  });
});

describe('rollMembershipPeriod', () => {
  it('advances exactly one interval and refuses to roll twice', async () => {
    const m = member({ current_period_end: '2027-03-01T00:00:00.000Z' });
    const { admin, tables } = fakeAdmin({ memberships: [m] });
    const plan = { billing_interval: 'yearly' as const, visits_included_per_period: 2 };
    const first = await rollMembershipPeriod(admin, 'm1', '2027-03-01T00:00:00.000Z', plan, null);
    expect(first.rolled).toBe(true);
    expect(tables.memberships[0].current_period_end).toBe('2028-03-01T00:00:00.000Z');
    expect(tables.memberships[0].visits_included_current_period).toBe(2);
    const second = await rollMembershipPeriod(admin, 'm1', '2027-03-01T00:00:00.000Z', plan, null);
    expect(second.rolled).toBe(false);
    expect(tables.memberships[0].current_period_end).toBe('2028-03-01T00:00:00.000Z');
  });
});
