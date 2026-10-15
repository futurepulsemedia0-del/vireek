import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { activateSignupMembership, finalizePaymentRequestFromIntent } from './finalizeIntent';

interface Call { kind: 'rpc' | 'update'; name: string; args: any }

/** Minimal fake of the Supabase admin client: records rpc calls and updates, serves canned rows. */
function fakeAdmin(opts: { rpcResult?: any; rpcError?: any; sessionId?: string | null; membership?: any } = {}) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: table === 'payment_requests' ? { stripe_checkout_session_id: opts.sessionId ?? null } : opts.membership ?? null,
            }),
          }),
        }),
        update: (values: any) => ({
          eq: () => ({
            eq: async () => {
              calls.push({ kind: 'update', name: table, args: values });
              return {};
            },
          }),
        }),
      };
    },
    rpc: async (name: string, args: any) => {
      calls.push({ kind: 'rpc', name, args });
      return { data: opts.rpcResult ?? { status: 'paid' }, error: opts.rpcError ?? null };
    },
  };
  return { admin, calls };
}

const succeeded = (extra: Record<string, unknown> = {}, metadata: Record<string, string> = {}) => ({
  id: 'pi_1',
  status: 'succeeded',
  currency: 'usd',
  amount: 11800,
  amount_received: 11800,
  latest_charge: null,
  metadata: { payment_request_id: 'req_1', tip_cents: '1800', ...metadata },
  ...extra,
});

// The function logs a structured line on success; keep test output clean.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('finalizePaymentRequestFromIntent', () => {
  it('ignores intents that are not payment requests (e.g. Tap to Pay)', async () => {
    const { admin, calls } = fakeAdmin();
    expect(await finalizePaymentRequestFromIntent(admin, { id: 'pi_x', status: 'succeeded', metadata: { job_payment_id: 'jp_1' } })).toEqual({ handled: false });
    expect(calls).toEqual([]);
  });

  it('claims but does not finalize intents that have not succeeded', async () => {
    const { admin, calls } = fakeAdmin();
    const outcome = await finalizePaymentRequestFromIntent(admin, succeeded({ status: 'requires_payment_method' }));
    expect(outcome).toEqual({ handled: true, status: 'requires_payment_method' });
    expect(calls).toEqual([]);
  });

  it('finalizes with the received amount, the tip, and keeps a stored Checkout session id', async () => {
    const { admin, calls } = fakeAdmin({ sessionId: 'cs_legacy' });
    const outcome = await finalizePaymentRequestFromIntent(admin, succeeded());
    expect(outcome).toEqual({ handled: true, status: 'paid' });
    expect(calls).toEqual([
      {
        kind: 'rpc',
        name: 'finalize_paid_payment_request',
        args: { p_request_id: 'req_1', p_session_id: 'cs_legacy', p_payment_intent_id: 'pi_1', p_amount_total_cents: 11800, p_tip_cents: 1800 },
      },
    ]);
  });

  it('passes a null session id for pure Payment Element payments', async () => {
    const { admin, calls } = fakeAdmin({ sessionId: null });
    await finalizePaymentRequestFromIntent(admin, succeeded());
    expect(calls[0].args.p_session_id).toBeNull();
  });

  it('treats a missing or malformed tip as zero', async () => {
    const { admin, calls } = fakeAdmin();
    await finalizePaymentRequestFromIntent(admin, succeeded({ amount_received: 10000, amount: 10000 }, { tip_cents: 'abc' }));
    expect(calls[0].args.p_tip_cents).toBe(0);
  });

  it('refuses a non-USD intent without touching the database', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, calls } = fakeAdmin();
    expect(await finalizePaymentRequestFromIntent(admin, succeeded({ currency: 'eur' }))).toEqual({ handled: true, status: 'currency_mismatch' });
    expect(calls).toEqual([]);
  });

  it('surfaces an amount mismatch for a human and does not activate memberships', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, calls } = fakeAdmin({ rpcResult: { status: 'amount_mismatch' } });
    const outcome = await finalizePaymentRequestFromIntent(admin, succeeded({}, { membership_signup: 'true', membership_id: 'mem_1' }));
    expect(outcome).toEqual({ handled: true, status: 'amount_mismatch' });
    expect(spy).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.kind === 'update')).toEqual([]);
  });

  it('throws when the RPC fails so Stripe retries the webhook', async () => {
    const { admin } = fakeAdmin({ rpcError: new Error('db down') });
    await expect(finalizePaymentRequestFromIntent(admin, succeeded())).rejects.toThrow('db down');
  });

  it('is idempotent for retried webhooks (already_paid) and still completes a pending signup', async () => {
    const { admin, calls } = fakeAdmin({
      rpcResult: { status: 'already_paid' },
      membership: { id: 'mem_1', status: 'offered', membership_plans: { billing_interval: 'monthly', visits_included_per_period: 2 } },
    });
    const outcome = await finalizePaymentRequestFromIntent(admin, succeeded({}, { membership_signup: 'true', membership_id: 'mem_1' }));
    expect(outcome).toEqual({ handled: true, status: 'already_paid' });
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(1);
  });

  it('does not activate anything for a renewal payment', async () => {
    const { admin, calls } = fakeAdmin({ membership: { id: 'mem_1', status: 'offered', membership_plans: null } });
    await finalizePaymentRequestFromIntent(admin, succeeded({}, { membership_id: 'mem_1' }));
    expect(calls.filter((c) => c.kind === 'update')).toEqual([]);
  });
});

describe('wallet logging', () => {
  const logged = (spy: { mock: { calls: unknown[][] } }) => JSON.parse(String(spy.mock.calls[0][0]));

  it('records Apple Pay / Google Pay from the charge when a charge loader is supplied', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { admin } = fakeAdmin();
    const fetchCharge = vi.fn(async (id: string) => ({ id, payment_method_details: { card: { wallet: { type: 'apple_pay' } } } }));
    await finalizePaymentRequestFromIntent(admin, succeeded({ latest_charge: 'ch_1' }), { fetchCharge });
    expect(fetchCharge).toHaveBeenCalledWith('ch_1');
    expect(logged(spy).wallet).toBe('apple_pay');
  });

  it('never fails a payment because the wallet lookup failed', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { admin } = fakeAdmin();
    const fetchCharge = vi.fn(async () => {
      throw new Error('stripe unreachable');
    });
    expect(await finalizePaymentRequestFromIntent(admin, succeeded({ latest_charge: 'ch_1' }), { fetchCharge })).toEqual({ handled: true, status: 'paid' });
    expect(logged(spy).wallet).toBeNull();
  });
});

describe('activateSignupMembership', () => {
  it('activates an offered membership with the plan period and visits', async () => {
    const { admin, calls } = fakeAdmin({ membership: { id: 'm', status: 'offered', membership_plans: { billing_interval: 'yearly', visits_included_per_period: 3 } } });
    await activateSignupMembership(admin, 'm');
    const update = calls.find((c) => c.kind === 'update')!;
    expect(update.args.status).toBe('active');
    expect(update.args.visits_included_current_period).toBe(3);
    expect(new Date(update.args.current_period_end).getTime()).toBeGreaterThan(new Date(update.args.current_period_start).getTime() + 300 * 86400_000);
  });

  it('does nothing when the membership is missing or already active', async () => {
    const missing = fakeAdmin({ membership: null });
    await activateSignupMembership(missing.admin, 'm');
    expect(missing.calls).toEqual([]);
    const active = fakeAdmin({ membership: { id: 'm', status: 'active', membership_plans: null } });
    await activateSignupMembership(active.admin, 'm');
    expect(active.calls).toEqual([]);
  });
});
