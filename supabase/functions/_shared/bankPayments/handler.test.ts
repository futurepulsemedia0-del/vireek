import { describe, it, expect, vi } from 'vitest';
import { mapIntentEvent, processBankDisputeEvent, processBankIntentEvent, processBankMethodEvent, type BankEventDeps } from './handler';

function setup(opts: { rpc?: (name: string, args: any) => any; pm?: any } = {}) {
  const calls: { name: string; args: any }[] = [];
  const admin = {
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      const r = opts.rpc?.(name, args);
      return r ?? { data: name === 'bank_attempt_apply' ? { result: 'applied', attempt_id: 'att_1', status: args.p?.status } : null, error: null };
    },
  };
  const deps: BankEventDeps = {
    fetchPaymentMethod: vi.fn(async () => opts.pm ?? { id: 'pm_1', type: 'us_bank_account', us_bank_account: { bank_name: 'Chase', last4: '6789', financial_connections_account: 'fca_1' } }),
    activateMembership: vi.fn(async () => {}),
    notifyCustomer: vi.fn(async () => {}),
    buildLink: (k, id) => `https://x.test/${k}/${id}`,
    log: () => {},
  };
  return { admin, deps, calls };
}

const pi = (extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: 'pi_1', amount: 50000, status: 'processing', payment_method: 'pm_1', payment_method_types: ['card', 'us_bank_account'],
  metadata: { payment_request_id: 'req_1', tip_cents: '0', ...meta }, ...extra,
});
const ev = (type: string, object: any, id = 'evt_1') => ({ id, type, created: 1_800_000_000, data: { object } });
const applyCall = (calls: { name: string; args: any }[]) => calls.find((c) => c.name === 'bank_attempt_apply')!.args.p;

describe('mapIntentEvent', () => {
  it('maps lifecycle events', () => {
    expect(mapIntentEvent('payment_intent.processing', {})).toBe('processing');
    expect(mapIntentEvent('payment_intent.succeeded', {})).toBe('succeeded');
    expect(mapIntentEvent('payment_intent.payment_failed', {})).toBe('failed');
    expect(mapIntentEvent('payment_intent.canceled', {})).toBe('canceled');
    expect(mapIntentEvent('payment_intent.requires_action', { next_action: { type: 'verify_with_microdeposits' } })).toBe('verification_required');
    expect(mapIntentEvent('payment_intent.requires_action', { next_action: { type: 'redirect_to_url' } })).toBeNull();
    expect(mapIntentEvent('charge.succeeded', {})).toBeNull();
  });
});

describe('processBankIntentEvent — scoping', () => {
  it('ignores non-payment_intent events and intents we do not own', async () => {
    const { admin, deps, calls } = setup();
    expect(await processBankIntentEvent(admin, ev('charge.succeeded', {}), deps)).toEqual({ handled: false });
    expect(await processBankIntentEvent(admin, ev('payment_intent.succeeded', pi({}, { payment_request_id: '' })), deps)).toEqual({ handled: false });
    expect(calls).toEqual([]);
  });
  it('costs card-only accounts nothing (no PaymentMethod fetch, no RPC)', async () => {
    const { admin, deps, calls } = setup();
    const r = await processBankIntentEvent(admin, ev('payment_intent.succeeded', pi({ payment_method_types: ['card'] })), deps);
    expect(r).toEqual({ handled: false });
    expect(deps.fetchPaymentMethod).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it('ignores a card payment on an ACH-enabled account', async () => {
    const { admin, deps, calls } = setup({ pm: { id: 'pm_c', type: 'card' } });
    expect(await processBankIntentEvent(admin, ev('payment_intent.succeeded', pi()), deps)).toEqual({ handled: false });
    expect(calls).toEqual([]);
  });
});

describe('processBankIntentEvent — lifecycle', () => {
  it('records processing with bank details, instant verification and a settlement estimate', async () => {
    const { admin, deps, calls } = setup();
    const r = await processBankIntentEvent(admin, ev('payment_intent.processing', pi({}, { tip_cents: '1500' })), deps);
    expect(r).toMatchObject({ handled: true, result: 'applied', status: 'processing' });
    expect(applyCall(calls)).toMatchObject({
      provider_payment_id: 'pi_1', status: 'processing', provider_event_id: 'evt_1', rail: 'ach_debit', amount_cents: 50000, tip_cents: 1500,
      payment_request_id: 'req_1', bank_name: 'Chase', account_last4: '6789', verification_method: 'instant', retryable: null,
    });
    expect(applyCall(calls).expected_settlement_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls.map((c) => c.name)).toEqual(['bank_attempt_apply']);
  });

  it('posts accounting once the debit succeeds', async () => {
    const { admin, deps, calls } = setup();
    await processBankIntentEvent(admin, ev('payment_intent.succeeded', pi({ status: 'succeeded' })), deps);
    expect(calls.map((c) => c.name)).toEqual(['bank_attempt_apply', 'bank_attempt_post_accounting']);
    expect(calls[1].args).toEqual({ p_attempt_id: 'att_1' });
  });

  it('does nothing further for a duplicate or stale delivery', async () => {
    for (const result of ['duplicate', 'stale', 'ignored']) {
      const { admin, deps, calls } = setup({ rpc: () => ({ data: { result, status: 'succeeded' }, error: null }) });
      const r = await processBankIntentEvent(admin, ev('payment_intent.succeeded', pi()), deps);
      expect(r).toMatchObject({ handled: true, result });
      expect(calls.map((c) => c.name)).toEqual(['bank_attempt_apply']);
      expect(deps.notifyCustomer).not.toHaveBeenCalled();
    }
  });

  it('classifies a retryable failure and tells the customer how to pay again', async () => {
    const contact = { name: 'Ann', email: 'a@x.test', phone: null, link_kind: 'pay', link_id: 'tok123' };
    const { admin, deps, calls } = setup({ rpc: () => ({ data: { result: 'applied', attempt_id: 'att_1', contact }, error: null }) });
    await processBankIntentEvent(admin, ev('payment_intent.payment_failed', pi({ last_payment_error: { code: 'insufficient_funds', message: 'NSF' } })), deps);
    expect(applyCall(calls)).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds', retryable: true });
    expect(calls.some((c) => c.name === 'bank_method_set_status')).toBe(false);
    const [, subject, text] = (deps.notifyCustomer as any).mock.calls[0];
    expect(subject).toContain('$500.00');
    expect(text).toContain('https://x.test/pay/tok123');
  });

  it('blocks the saved account on a non-retryable failure', async () => {
    const { admin, deps, calls } = setup();
    await processBankIntentEvent(admin, ev('payment_intent.payment_failed', pi({ last_payment_error: { code: 'account_closed' } })), deps);
    expect(applyCall(calls)).toMatchObject({ retryable: false });
    expect(calls.find((c) => c.name === 'bank_method_set_status')!.args).toEqual({ p_pm: 'pm_1', p_status: 'blocked', p_reason: 'account_closed' });
  });

  it('sends the microdeposit verification link', async () => {
    const contact = { name: 'Ann', email: 'a@x.test', link_kind: 'pay', link_id: 'tok' };
    const { admin, deps, calls } = setup({ rpc: () => ({ data: { result: 'applied', attempt_id: 'a', contact }, error: null }) });
    await processBankIntentEvent(admin, ev('payment_intent.requires_action', pi({ status: 'requires_action', next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: 'https://pay.stripe.test/v' } } })), deps);
    expect(applyCall(calls)).toMatchObject({ status: 'verification_required', verification_method: 'microdeposits' });
    expect((deps.notifyCustomer as any).mock.calls[0][2]).toContain('https://pay.stripe.test/v');
  });

  it('grants provisional membership access only when the database allows it', async () => {
    const { admin, deps, calls } = setup({ rpc: (n) => (n === 'bank_attempt_apply' ? { data: { result: 'applied', attempt_id: 'att_9', provisional_allowed: true }, error: null } : undefined) });
    await processBankIntentEvent(admin, ev('payment_intent.processing', pi({}, { membership_id: 'mem_1', membership_signup: 'true' })), deps);
    expect(deps.activateMembership).toHaveBeenCalledWith(admin, 'mem_1');
    expect(calls.map((c) => c.name)).toContain('bank_attempt_mark_provisional');
    const none = setup();
    await processBankIntentEvent(none.admin, ev('payment_intent.processing', pi({}, { membership_id: 'mem_1', membership_signup: 'true' })), none.deps);
    expect(none.deps.activateMembership).not.toHaveBeenCalled();
  });

  it('throws on database errors so Stripe retries', async () => {
    const { admin, deps } = setup({ rpc: () => ({ data: null, error: new Error('db down') }) });
    await expect(processBankIntentEvent(admin, ev('payment_intent.succeeded', pi()), deps)).rejects.toThrow('db down');
  });

  it('never fails the webhook because a notification failed', async () => {
    const contact = { name: 'Ann', email: 'a@x.test', link_kind: 'pay', link_id: 'tok' };
    const { admin, deps } = setup({ rpc: () => ({ data: { result: 'applied', attempt_id: 'a', contact }, error: null }) });
    (deps.notifyCustomer as any).mockRejectedValueOnce(new Error('sms down'));
    await expect(processBankIntentEvent(admin, ev('payment_intent.payment_failed', pi({ last_payment_error: { code: 'insufficient_funds' } })), deps)).resolves.toMatchObject({ result: 'applied' });
  });

  it('handles plan installment intents (no payment_request_id)', async () => {
    const { admin, deps, calls } = setup();
    await processBankIntentEvent(admin, ev('payment_intent.processing', pi({}, { payment_request_id: '', installment_id: 'inst_1', payment_plan_id: 'plan_1' })), deps);
    expect(applyCall(calls)).toMatchObject({ installment_id: 'inst_1', payment_request_id: null });
  });
});

describe('processBankDisputeEvent', () => {
  const dispute = (extra: Record<string, unknown> = {}) => ev('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_1', reason: 'insufficient_funds', status: 'lost', ...extra });
  it('maps bank returns and customer disputes, then reverses accounting', async () => {
    const a = setup();
    await processBankDisputeEvent(a.admin, dispute(), a.deps);
    expect(applyCall(a.calls)).toMatchObject({ status: 'returned', return_code: 'insufficient_funds', provider_event_id: 'evt_1:bank' });
    expect(a.calls.map((c) => c.name)).toEqual(['bank_attempt_apply', 'bank_attempt_post_accounting']);
    const b = setup();
    await processBankDisputeEvent(b.admin, dispute({ reason: 'debit_not_authorized' }), b.deps);
    expect(applyCall(b.calls).status).toBe('disputed');
  });
  it('does not treat a proof-of-authorization enquiry as money moving back', async () => {
    const { admin, deps, calls } = setup();
    expect(await processBankDisputeEvent(admin, dispute({ status: 'warning_needs_response' }), deps)).toMatchObject({ result: 'enquiry' });
    expect(calls).toEqual([]);
  });
  it('ignores disputes on non-bank charges (attempt unknown) and other events', async () => {
    const { admin, deps, calls } = setup({ rpc: () => ({ data: { result: 'ignored' }, error: null }) });
    expect(await processBankDisputeEvent(admin, dispute(), deps)).toMatchObject({ result: 'ignored' });
    expect(calls.map((c) => c.name)).toEqual(['bank_attempt_apply']);
    expect(await processBankDisputeEvent(admin, ev('charge.dispute.closed', {}), deps)).toEqual({ handled: false });
  });
});

describe('processBankMethodEvent', () => {
  it('blocks and unblocks a bank account', async () => {
    const a = setup();
    await processBankMethodEvent(a.admin, ev('payment_method.automatically_updated', { id: 'pm_1', type: 'us_bank_account', us_bank_account: { status_details: { blocked: { reason: 'bank_account_restricted' } } } }), a.deps);
    expect(a.calls[0].args).toEqual({ p_pm: 'pm_1', p_status: 'blocked', p_reason: 'bank_account_restricted' });
    const b = setup();
    await processBankMethodEvent(b.admin, ev('payment_method.automatically_updated', { id: 'pm_1', type: 'us_bank_account', us_bank_account: {} }), b.deps);
    expect(b.calls[0].args).toEqual({ p_pm: 'pm_1', p_status: 'active', p_reason: null });
    const c = setup();
    expect(await processBankMethodEvent(c.admin, ev('payment_method.automatically_updated', { id: 'pm_2', type: 'card' }), c.deps)).toEqual({ handled: false });
  });
});
