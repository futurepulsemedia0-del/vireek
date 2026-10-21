import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntentMetadata, buildPaymentIntentParams } from './paymentIntent';
import { finalizePaymentRequestFromIntent, saveMembershipCard } from './finalizeIntent';

const CHARGE = { payment_method_details: { card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2031 } } };

function fakeAdmin() {
  const updates: { table: string; values: any; eqs: [string, unknown][] }[] = [];
  const admin = {
    from(table: string) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { stripe_checkout_session_id: null } }) }) }),
        update: (values: any) => {
          const eqs: [string, unknown][] = [];
          const chain: any = { eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain; }, then: (r: any) => { updates.push({ table, values, eqs }); return Promise.resolve({}).then(r); } };
          return chain;
        },
      };
    },
    rpc: async () => ({ data: { status: 'paid' }, error: null }),
  };
  return { admin, updates };
}

describe('save-card intent building', () => {
  const base = { baseCents: 29900, tipCents: 0, destinationAccountId: 'acct_1', description: 'Plan', metadata: {} };
  it('only attaches the customer and setup_future_usage when the customer opted in', () => {
    expect(buildPaymentIntentParams({ ...base, customerId: 'cus_1', saveCard: true })).toMatchObject({ customer: 'cus_1', setup_future_usage: 'off_session' });
    const plain = buildPaymentIntentParams({ ...base, customerId: 'cus_1', saveCard: false });
    expect(plain).not.toHaveProperty('customer');
    expect(plain).not.toHaveProperty('setup_future_usage');
    expect(buildPaymentIntentParams({ ...base, saveCard: true })).not.toHaveProperty('setup_future_usage');
  });
  it('flags save_card in metadata only for membership payments', () => {
    expect(buildIntentMetadata({ requestId: 'r', userId: 'u', baseCents: 1, tipCents: 0, membershipId: 'm', saveCard: true }).save_card).toBe('true');
    expect(buildIntentMetadata({ requestId: 'r', userId: 'u', baseCents: 1, tipCents: 0, saveCard: true })).not.toHaveProperty('save_card');
    expect(buildIntentMetadata({ requestId: 'r', userId: 'u', baseCents: 1, tipCents: 0, membershipId: 'm' })).not.toHaveProperty('save_card');
  });
});

describe('saveMembershipCard', () => {
  it('stores customer, method, card details and consent, scoped to the owner', async () => {
    const { admin, updates } = fakeAdmin();
    const now = new Date('2027-03-01T00:00:00Z');
    await saveMembershipCard(admin, 'm1', { customer: 'cus_1', payment_method: 'pm_1', metadata: { user_id: 'u1' } }, CHARGE, now);
    expect(updates[0].values).toMatchObject({
      stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1', card_brand: 'visa', card_last4: '4242',
      card_exp_month: 9, card_exp_year: 2031, auto_renew: true, auto_renew_consent_at: now.toISOString(),
    });
    expect(updates[0].eqs).toEqual([['id', 'm1'], ['user_id', 'u1']]);
  });
  it('does nothing without a saved method', async () => {
    const { admin, updates } = fakeAdmin();
    await saveMembershipCard(admin, 'm1', { customer: 'cus_1', metadata: { user_id: 'u1' } }, CHARGE);
    expect(updates).toHaveLength(0);
  });
});

describe('finalize + save card', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());
  const pi = (metadata: Record<string, string>) => ({
    id: 'pi_1', status: 'succeeded', currency: 'usd', amount: 29900, amount_received: 29900, customer: 'cus_1', payment_method: 'pm_1', latest_charge: CHARGE,
    metadata: { payment_request_id: 'r1', user_id: 'u1', membership_id: 'm1', ...metadata },
  });
  it('saves the card only when the customer opted in', async () => {
    const a = fakeAdmin();
    await finalizePaymentRequestFromIntent(a.admin, pi({ save_card: 'true' }));
    expect(a.updates.some((u) => u.table === 'memberships' && u.values.stripe_payment_method_id === 'pm_1')).toBe(true);
    const b = fakeAdmin();
    await finalizePaymentRequestFromIntent(b.admin, pi({}));
    expect(b.updates).toHaveLength(0);
  });
  it('a card-save failure never fails the payment', async () => {
    const { admin } = fakeAdmin();
    (admin as any).from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {} }) }) }), update: () => { throw new Error('db down'); } });
    await expect(finalizePaymentRequestFromIntent(admin, pi({ save_card: 'true' }))).resolves.toMatchObject({ handled: true, status: 'paid' });
  });
});
