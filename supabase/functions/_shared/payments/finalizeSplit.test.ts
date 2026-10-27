import { describe, it, expect, vi } from 'vitest';
import { buildSplitIntentMetadata, isSplitIntent, splitIntentDescription } from './splitPayment';
import { finalizeSplitPaymentFromIntent } from './finalizeSplit';

const META = buildSplitIntentMetadata({ payerId: 'payer_1', invoiceId: 'inv_1', userId: 'user_1', amountCents: 80000 });
const pi = (over: Record<string, unknown> = {}) => ({
  id: 'pi_1', status: 'succeeded', currency: 'usd', amount: 80000, amount_received: 80000, metadata: META, ...over,
});
const fakeAdmin = (reply: { data?: unknown; error?: unknown }) => ({ rpc: vi.fn(async () => ({ data: reply.data ?? null, error: reply.error ?? null })) });

describe('split intent metadata', () => {
  it('carries only the server-set split keys', () => {
    expect(META).toEqual({ flow: 'split_v1', split_payer_id: 'payer_1', invoice_id: 'inv_1', user_id: 'user_1', base_cents: '80000' });
  });
  it('recognises split intents and ignores everything else', () => {
    expect(isSplitIntent(pi())).toBe(true);
    expect(isSplitIntent({ metadata: { flow: 'tip_v1', payment_request_id: 'r1' } })).toBe(false);
    expect(isSplitIntent({ metadata: { flow: 'split_v1' } })).toBe(false);
    expect(isSplitIntent(null)).toBe(false);
  });
  it('builds a bounded description', () => {
    expect(splitIntentDescription('Acme HVAC', 'INV-7', 'Ada')).toBe('Invoice INV-7 from Acme HVAC (share of Ada)');
    expect(splitIntentDescription(null, 'INV-7', 'Ada')).toBe('Invoice INV-7 (share of Ada)');
    expect(splitIntentDescription('x'.repeat(900), 'INV-7', 'Ada').length).toBe(500);
  });
});

describe('finalizeSplitPaymentFromIntent', () => {
  it('leaves non-split intents to the other handlers', async () => {
    const admin = fakeAdmin({});
    expect(await finalizeSplitPaymentFromIntent(admin, { id: 'pi_x', metadata: { payment_request_id: 'r1' } })).toEqual({ handled: false });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('does not book anything until the intent has succeeded', async () => {
    const admin = fakeAdmin({});
    expect(await finalizeSplitPaymentFromIntent(admin, pi({ status: 'requires_payment_method' }))).toEqual({ handled: true, status: 'requires_payment_method' });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('refuses a non-USD charge and flags it', async () => {
    const admin = fakeAdmin({});
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await finalizeSplitPaymentFromIntent(admin, pi({ currency: 'eur' }))).toEqual({ handled: true, status: 'currency_mismatch' });
    expect(admin.rpc).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('books the amount actually received, tied to the payer and owner from the metadata', async () => {
    const admin = fakeAdmin({ data: { status: 'recorded', payment_id: 'pay_1' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await finalizeSplitPaymentFromIntent(admin, pi({ amount_received: 79900 }))).toEqual({ handled: true, status: 'recorded' });
    expect(admin.rpc).toHaveBeenCalledWith('finalize_split_payment', {
      p_payer_id: 'payer_1', p_user_id: 'user_1', p_payment_intent_id: 'pi_1', p_amount_cents: 79900,
    });
    log.mockRestore();
  });

  it('falls back to the intent amount and treats a webhook retry as success', async () => {
    const admin = fakeAdmin({ data: { status: 'already_recorded' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await finalizeSplitPaymentFromIntent(admin, pi({ amount_received: 0 }))).toEqual({ handled: true, status: 'already_recorded' });
    expect(admin.rpc).toHaveBeenCalledWith('finalize_split_payment', expect.objectContaining({ p_amount_cents: 80000 }));
    log.mockRestore();
  });

  it('surfaces a needs-review result instead of hiding it', async () => {
    const admin = fakeAdmin({ data: { status: 'needs_review' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await finalizeSplitPaymentFromIntent(admin, pi())).toEqual({ handled: true, status: 'needs_review' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('throws on an RPC error so Stripe retries the webhook', async () => {
    const admin = fakeAdmin({ error: new Error('db down') });
    await expect(finalizeSplitPaymentFromIntent(admin, pi())).rejects.toThrow('db down');
  });
});
