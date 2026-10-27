import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import {
  allocateSplit,
  computePayerStandings,
  draftFromPayers,
  isSplitStale,
  newDraftRow,
  parsePercentInput,
  rowsFromPreset,
  saveInvoiceSplit,
  recordSplitPayment,
  unattributedNetCents,
  validateSplitDraft,
  type SplitPayer,
} from './invoiceSplit';

const F = (v: string) => ({ shareType: 'fixed' as const, shareValue: v });
const P = (v: string) => ({ shareType: 'percent' as const, shareValue: v });
const R = () => ({ shareType: 'remainder' as const, shareValue: '' });

const payer = (over: Partial<SplitPayer> = {}): SplitPayer => ({
  id: 'a', user_id: 'u', invoice_id: 'i', sort_order: 1, role: 'insurer', name: 'Acme Insurance', email: null, phone: null,
  share_type: 'fixed', share_value: 80000, amount_cents: 80000, plan_total_cents: 100000, public_token: 't', stripe_payment_intent_id: null,
  needs_review: false, link_sent_at: null, created_at: '', updated_at: '', ...over,
});

describe('allocateSplit', () => {
  it('gives a fixed share to one payer and the rest to the remainder payer', () => {
    expect(allocateSplit(100000, [F('800.00'), R()])).toEqual({ ok: true, amounts: [80000, 20000] });
  });
  it('never loses a cent on percentage splits', () => {
    const r = allocateSplit(13751, [P('50'), P('50')]);
    expect(r).toEqual({ ok: true, amounts: [6876, 6875] });
    const t = allocateSplit(10000, [P('33.33'), P('33.33'), P('33.34')]);
    expect(t.ok && t.amounts.reduce((a, b) => a + b, 0)).toBe(10000);
  });
  it('rejects shares that do not add up', () => {
    const r = allocateSplit(10000, [P('60'), P('30')]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/90%/);
    expect(allocateSplit(10000, [F('50'), F('40')]).ok).toBe(false);
  });
  it('rejects two remainders, an overspent remainder and bad input', () => {
    expect(allocateSplit(10000, [R(), R()]).ok).toBe(false);
    expect(allocateSplit(10000, [F('100'), R()]).ok).toBe(false);
    expect(allocateSplit(10000, [F('abc'), R()]).ok).toBe(false);
    expect(allocateSplit(0, [F('1'), R()]).ok).toBe(false);
    expect(allocateSplit(10000, [P('100')]).ok).toBe(false);
  });
});

describe('parsePercentInput', () => {
  it('parses up to two decimals between 0.01 and 100', () => {
    expect(parsePercentInput('12.5%')).toBe(1250);
    expect(parsePercentInput('0')).toBeNull();
    expect(parsePercentInput('100.01')).toBeNull();
  });
});

describe('validateSplitDraft', () => {
  const rows = () => [
    newDraftRow({ role: 'insurer', name: 'Acme', email: 'c@acme.com', shareType: 'fixed', shareValue: '800' }),
    newDraftRow({ role: 'customer', name: 'Ada', shareType: 'remainder' }),
  ];
  it('builds the exact RPC payload', () => {
    const v = validateSplitDraft(rows(), 100000);
    expect(v.ok && v.payload.map((p) => p.amount_cents)).toEqual([80000, 20000]);
    expect(v.ok && v.payload[1].share_value).toBeNull();
  });
  it('requires a name and a valid email', () => {
    expect(validateSplitDraft([{ ...rows()[0], name: ' ' }, rows()[1]], 100000).ok).toBe(false);
    expect(validateSplitDraft([{ ...rows()[0], email: 'nope' }, rows()[1]], 100000).ok).toBe(false);
  });
  it('keeps the id of an existing payer', () => {
    const [a, b] = rows();
    const v = validateSplitDraft([{ ...a, id: 'existing' }, b], 100000);
    expect(v.ok && v.payload[0].id).toBe('existing');
  });
});

describe('standings', () => {
  const payers = [payer({ id: 'a', sort_order: 2, amount_cents: 5000 }), payer({ id: 'b', sort_order: 1, amount_cents: 8750 })];
  const pays = [
    { id: 'p1', amount_cents: 5000, payer_id: 'a' },
    { id: 'p2', amount_cents: 100, payer_id: null },
    { id: 'p3', amount_cents: 3000, payer_id: 'b' },
  ];
  const refs = [{ payment_id: 'p3', amount_cents: 500 }];
  it('derives each payer from the shared ledger, net of refunds', () => {
    const s = computePayerStandings(payers, pays, refs);
    expect(s[0].payer.id).toBe('b');
    expect(s[0]).toMatchObject({ netPaidCents: 2500, remainingCents: 6250, state: 'partial' });
    expect(s[1]).toMatchObject({ state: 'paid', remainingCents: 0 });
  });
  it('reports money paid above a share and unassigned money', () => {
    expect(computePayerStandings([payer({ amount_cents: 1000 })], [{ id: 'x', amount_cents: 1500, payer_id: 'a' }], [])[0].overCents).toBe(500);
    expect(unattributedNetCents(payers, pays, refs)).toBe(100);
  });
  it('flags a stale split only when the total moved', () => {
    expect(isSplitStale([payer()], 100000)).toBe(false);
    expect(isSplitStale([payer()], 100001)).toBe(true);
    expect(isSplitStale([], 5)).toBe(false);
  });
});

describe('drafts and presets', () => {
  it('round-trips saved payers into editor rows', () => {
    const rows = draftFromPayers([payer(), payer({ id: 'b', sort_order: 2, share_type: 'percent', share_value: 12.5, amount_cents: 12500 }), payer({ id: 'c', sort_order: 3, share_type: 'remainder', share_value: null })]);
    expect(rows.map((r) => r.shareValue)).toEqual(['800.00', '12.5', '']);
  });
  it('every preset is a valid starting point', () => {
    expect(rowsFromPreset('customer-insurer')).toHaveLength(2);
    expect(rowsFromPreset('landlord-tenant').map((r) => r.shareValue)).toEqual(['50', '50']);
    expect(rowsFromPreset('missing')).toHaveLength(2);
  });
});

describe('data access', () => {
  beforeEach(() => rpc.mockReset());
  it('calls the RPCs with the expected parameters', async () => {
    rpc.mockResolvedValue({ error: null });
    await saveInvoiceSplit('inv', []);
    expect(rpc).toHaveBeenCalledWith('save_invoice_split', { p_invoice_id: 'inv', p_payers: [] });
    await recordSplitPayment({ payerId: 'a', amountCents: 500, method: 'check', reference: ' 12 ' });
    expect(rpc).toHaveBeenCalledWith('record_split_payment', expect.objectContaining({ p_payer_id: 'a', p_amount_cents: 500, p_reference: '12', p_note: null }));
  });
  it('surfaces database errors', async () => {
    rpc.mockResolvedValue({ error: new Error('Shares add up to $1.00') });
    await expect(saveInvoiceSplit('inv', [])).rejects.toThrow('Shares add up');
  });
});
