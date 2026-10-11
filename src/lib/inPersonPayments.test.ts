import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

import {
  PaymentError, computeCashChange, createCardIntent, createDepositBatch, describePaymentError, fetchDepositOverview,
  fetchJobPaymentSummary, formatCents, newRequestId, parseMoneyToCents, recordManualPayment, summarizeSelection, validateCheckNumber,
} from './inPersonPayments';

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); });

describe('parseMoneyToCents', () => {
  it.each([['20', 2000], ['$20.5', 2050], ['1,234.50', 123450], ['0.99', 99], [' 7.05 ', 705]])('parses %s', (i, c) => expect(parseMoneyToCents(i)).toBe(c));
  it.each(['', 'abc', '-5', '0', '0.00', '1.234', '12,50', '1,23', '1e3', '2000000'])('rejects %s', (i) => expect(parseMoneyToCents(i)).toBeNull());
});

describe('validateCheckNumber', () => {
  it('normalizes', () => expect(validateCheckNumber(' ab-12 ')).toEqual({ ok: true, value: 'AB-12' }));
  it('rejects empty and bad chars', () => {
    expect(validateCheckNumber('  ').ok).toBe(false);
    expect(validateCheckNumber('12 34').ok).toBe(false);
    expect(validateCheckNumber('1'.repeat(21)).ok).toBe(false);
  });
});

describe('cash + deposit math', () => {
  it('computes change and caps applied amount', () => {
    expect(computeCashChange(10000, 7550)).toEqual({ appliedCents: 7550, changeCents: 2450 });
    expect(computeCashChange(5000, 7550)).toEqual({ appliedCents: 5000, changeCents: 0 });
  });
  it('summarizes selections', () => {
    expect(summarizeSelection([{ method: 'cash', amount_cents: 1000 }, { method: 'check', amount_cents: 2500 }, { method: 'check', amount_cents: 500 }]))
      .toEqual({ cashCents: 1000, checkCents: 3000, cashCount: 1, checkCount: 2, totalCents: 4000, count: 3 });
    expect(summarizeSelection([]).totalCents).toBe(0);
  });
});

describe('misc helpers', () => {
  it('formats cents', () => expect(formatCents(123456)).toBe('$1,234.56'));
  it('generates uuid-shaped ids', () => expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  it('maps error codes', () => {
    expect(describePaymentError('exceeds_balance')).toMatch(/more than the balance/);
    expect(describePaymentError('nope')).toMatch(/Something went wrong/);
  });
});

describe('RPC wrappers', () => {
  it('sends the right params for manual payments', async () => {
    rpc.mockResolvedValue({ data: { success: true, payment_id: 'p1' }, error: null });
    const res = await recordManualPayment({ jobId: 'j1', method: 'check', amountCents: 5000, clientRequestId: 'r1', checkNumber: '1001' });
    expect(res.success).toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_manual_payment', expect.objectContaining({
      p_job_id: 'j1', p_method: 'check', p_amount_cents: 5000, p_check_number: '1001', p_client_request_id: 'r1', p_tendered_cents: null,
    }));
  });
  it('throws on transport errors but returns domain errors', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('boom') });
    await expect(recordManualPayment({ jobId: 'j', method: 'cash', amountCents: 1, clientRequestId: 'r' })).rejects.toThrow('boom');
    rpc.mockResolvedValueOnce({ data: { success: false, error: 'exceeds_balance' }, error: null });
    expect((await recordManualPayment({ jobId: 'j', method: 'cash', amountCents: 1, clientRequestId: 'r' })).error).toBe('exceeds_balance');
  });
  it('surfaces forbidden summaries as errors', async () => {
    rpc.mockResolvedValue({ data: { error: 'forbidden' }, error: null });
    await expect(fetchJobPaymentSummary('j')).rejects.toThrow(/can't take payments/);
  });
  it('loads the deposit overview and creates batches', async () => {
    rpc.mockResolvedValueOnce({ data: { undeposited: [], batches: [] }, error: null });
    expect((await fetchDepositOverview()).undeposited).toEqual([]);
    rpc.mockResolvedValueOnce({ data: { success: true, batch_id: 'b1' }, error: null });
    await createDepositBatch({ paymentIds: ['a', 'b'], depositedAt: '2026-10-10', slipNumber: '42' });
    expect(rpc).toHaveBeenLastCalledWith('create_deposit_batch', { p_payment_ids: ['a', 'b'], p_deposited_at: '2026-10-10', p_bank_reference: null, p_slip_number: '42', p_notes: null });
  });
});

describe('terminal edge function wrapper', () => {
  it('returns intent data', async () => {
    invoke.mockResolvedValue({ data: { job_payment_id: 'p', client_secret: 's' }, error: null });
    expect((await createCardIntent({ jobId: 'j', amountCents: 500, clientRequestId: 'r' })).client_secret).toBe('s');
    expect(invoke).toHaveBeenCalledWith('terminal-payments', { body: { action: 'create_intent', job_id: 'j', amount_cents: 500, client_request_id: 'r' } });
  });
  it('reads server error messages from failed responses', async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ error: 'Amount is more than the balance due.', code: 'exceeds_balance' }) } } });
    await expect(createCardIntent({ jobId: 'j', amountCents: 500, clientRequestId: 'r' })).rejects.toMatchObject({ message: 'Amount is more than the balance due.', code: 'exceeds_balance' });
  });
  it('wraps errors in PaymentError', async () => {
    invoke.mockResolvedValue({ data: { error: 'x', code: 'c' }, error: null });
    await expect(createCardIntent({ jobId: 'j', amountCents: 500, clientRequestId: 'r' })).rejects.toBeInstanceOf(PaymentError);
  });
});
