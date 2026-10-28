import { describe, expect, it } from 'vitest';
import {
  amountsCompatible, bankRowsToCardRows, dateCompatible, detectKind, matchCardTransaction, normalizeCardCsv, parseCardForm,
  parseFeedSettingsForm, pickCategoryId, receiptDueAt, receiptRequirement, receiptState, summarizeCardTxns,
  type CardTransaction, type MatchContext, type MatchRowInput,
} from '@/lib/cardFeed';
import { detectMapping, parseCsv } from '@/lib/fuelCards';

const T1 = 'tech-1';
const T2 = 'tech-2';
const ctx: MatchContext = {
  cards: [
    { id: 'c-1111', provider: 'wex', card_last4: '1111', kind: 'fuel', status: 'active', vehicle_id: 'v-1', technician_id: null },
    { id: 'c-2222', provider: 'ramp', card_last4: '2222', kind: 'expense', status: 'active', vehicle_id: null, technician_id: T2 },
    { id: 'c-3333a', provider: 'wex', card_last4: '3333', kind: 'fuel', status: 'active', vehicle_id: 'v-2', technician_id: null },
    { id: 'c-3333b', provider: 'ramp', card_last4: '3333', kind: 'expense', status: 'active', vehicle_id: null, technician_id: T1 },
    { id: 'c-4444', provider: 'wex', card_last4: '4444', kind: 'fuel', status: 'cancelled', vehicle_id: 'v-1', technician_id: T1 },
  ],
  vehicles: [
    { id: 'v-1', license_plate: 'abc-123', assigned_technician_id: null },
    { id: 'v-2', license_plate: 'XYZ 789', assigned_technician_id: T2 },
    { id: 'v-3', license_plate: 'DUP 1', assigned_technician_id: null },
    { id: 'v-4', license_plate: 'dup1', assigned_technician_id: null },
  ],
  assignments: [
    { vehicle_id: 'v-1', technician_id: T1, assigned_at: '2026-01-01T00:00:00Z', unassigned_at: '2026-06-01T00:00:00Z' },
    { vehicle_id: 'v-1', technician_id: T2, assigned_at: '2026-06-01T00:00:00Z', unassigned_at: null },
  ],
};
const row = (over: Partial<MatchRowInput>): MatchRowInput => ({ transaction_at: '2026-03-10T14:00:00Z', card_last4: null, plate: null, ...over });

describe('matchCardTransaction', () => {
  it('matches a card to its vehicle and the driver who had the vehicle at purchase time', () => {
    const early = matchCardTransaction(row({ card_last4: '1111' }), ctx);
    expect(early).toMatchObject({ cardId: 'c-1111', vehicleId: 'v-1', technicianId: T1, method: 'card', kind: 'fuel' });
    expect(early.flags).toEqual([]);
    const late = matchCardTransaction(row({ card_last4: '1111', transaction_at: '2026-08-01T10:00:00Z' }), ctx);
    expect(late.technicianId).toBe(T2);
  });

  it('uses the card holder when the card names a technician', () => {
    const m = matchCardTransaction(row({ card_last4: '2222' }), ctx);
    expect(m).toMatchObject({ cardId: 'c-2222', vehicleId: null, technicianId: T2, kind: 'expense' });
  });

  it('falls back to the licence plate (formatting ignored) when there is no card', () => {
    const m = matchCardTransaction(row({ plate: 'ABC 123' }), ctx);
    expect(m).toMatchObject({ cardId: null, vehicleId: 'v-1', technicianId: T1, method: 'plate' });
  });

  it('never guesses on an ambiguous plate', () => {
    const m = matchCardTransaction(row({ plate: 'dup-1' }), ctx);
    expect(m).toMatchObject({ vehicleId: null, technicianId: null, method: 'none' });
    expect(m.flags).toContain('no_driver');
  });

  it('disambiguates shared last-4 digits by provider, and refuses to guess otherwise', () => {
    expect(matchCardTransaction(row({ card_last4: '3333', provider: 'RAMP' }), ctx)).toMatchObject({ cardId: 'c-3333b', technicianId: T1 });
    expect(matchCardTransaction(row({ card_last4: '3333', provider: 'WEX' }), ctx)).toMatchObject({ cardId: 'c-3333a', vehicleId: 'v-2' });
    const none = matchCardTransaction(row({ card_last4: '3333' }), ctx);
    expect(none.cardId).toBeNull();
    expect(none.flags).toContain('ambiguous_card');
    expect(none.flags).not.toContain('unregistered_card');
  });

  it('flags unregistered and inactive cards', () => {
    expect(matchCardTransaction(row({ card_last4: '9999' }), ctx).flags).toEqual(['unregistered_card', 'no_driver']);
    const inactive = matchCardTransaction(row({ card_last4: '4444' }), ctx);
    expect(inactive.cardId).toBe('c-4444');
    expect(inactive.flags).toContain('card_inactive');
  });

  it('uses the legacy vehicle driver only when there is no assignment history', () => {
    expect(matchCardTransaction(row({ card_last4: '3333', provider: 'wex' }), ctx).technicianId).toBe(T2);
    // v-1 has history but nobody was assigned before 2026-01-01 -> no legacy fallback.
    const before = matchCardTransaction(row({ card_last4: '1111', transaction_at: '2025-12-01T00:00:00Z' }), ctx);
    expect(before.technicianId).toBeNull();
  });

  it('keeps the kind hint for unmatched rows and defaults to expense', () => {
    expect(matchCardTransaction(row({ kind: 'fuel' }), ctx).kind).toBe('fuel');
    expect(matchCardTransaction(row({}), ctx).kind).toBe('expense');
  });
});

describe('detectKind', () => {
  it('recognises fuel by gallons, product or merchant', () => {
    expect(detectKind({ gallons: 12 })).toBe('fuel');
    expect(detectKind({ product: 'diesel' })).toBe('fuel');
    expect(detectKind({ merchant: 'SHELL OIL 574' })).toBe('fuel');
    expect(detectKind({ merchant: "LOVE'S TRAVEL STOP #221" })).toBe('fuel');
    expect(detectKind({ merchant: 'THE HOME DEPOT #6811' })).toBe('expense');
    expect(detectKind({ merchant: 'Gastro Pub', product: 'other' })).toBe('expense');
  });
});

describe('bankRowsToCardRows', () => {
  const accounts = [{ id: 'a-1', name: 'Business Visa', mask: '4242', account_type: 'credit' }, { id: 'a-2', name: 'Checking', mask: '0001', account_type: 'depository' }];
  const base = { posted_date: '2026-10-05', pending: false };

  it('keeps purchases only, from the chosen accounts, with the account mask as the card', () => {
    const res = bankRowsToCardRows([
      { id: 'b1', account_id: 'a-1', amount_cents: -4217, merchant_name: 'Shell', ...base },
      { id: 'b2', account_id: 'a-1', amount_cents: 5000, description: 'PAYMENT THANK YOU', ...base },
      { id: 'b3', account_id: 'a-1', amount_cents: -999, ...base, pending: true },
      { id: 'b4', account_id: 'a-2', amount_cents: -100, ...base },
      { id: 'b5', bank_account_id: 'a-1', amount_cents: -12000, name: 'HOME DEPOT', posted_date: '2026-10-06', pending: false },
      { id: 'b6', account_id: 'a-1', amount_cents: 'oops', ...base },
    ], accounts, ['a-1']);
    expect(res.skipped).toEqual({ pending: 1, credits: 1, outsideAccounts: 1, invalid: 1 });
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ amount: 42.17, card_last4: '4242', merchant: 'Shell', kind: 'fuel', external_id: 'b1', transaction_at: '2026-10-05T12:00:00', provider: null });
    expect(res.rows[1]).toMatchObject({ amount: 120, merchant: 'HOME DEPOT', kind: 'expense', external_id: 'b5' });
  });

  it('is idempotent in its keys: the same bank row always yields the same external id', () => {
    const rows = [{ id: 'same', account_id: 'a-1', amount_cents: -500, ...base }];
    expect(bankRowsToCardRows(rows, accounts, ['a-1']).rows[0].external_id).toBe(bankRowsToCardRows(rows, accounts, ['a-1']).rows[0].external_id);
  });
});

describe('normalizeCardCsv', () => {
  it('tags CSV rows with their kind', () => {
    const table = parseCsv('Date,Card Number,Merchant,Total Amount\n10/08/2026,XXXX1234,Shell #44,71.74\n10/09/2026,XXXX1234,Lowes,32.10\n');
    const [header, ...data] = table;
    const out = normalizeCardCsv(data, detectMapping(header));
    expect(out.rejected).toEqual([]);
    expect(out.rows.map((r) => r.kind)).toEqual(['fuel', 'expense']);
  });
});

describe('receipt rules', () => {
  it('requires a receipt above the threshold (0 = every purchase)', () => {
    expect(receiptRequirement(1, 0)).toBe('required');
    expect(receiptRequirement(7500, 7500)).toBe('not_required');
    expect(receiptRequirement(7501, 7500)).toBe('required');
  });
  it('computes the due date', () => {
    expect(receiptDueAt('2026-03-10T14:00:00Z', 7)).toBe('2026-03-17T14:00:00.000Z');
  });
  it('accepts a tip-sized difference but not a different purchase', () => {
    expect(amountsCompatible(4500, 4217)).toBe(false);
    expect(amountsCompatible(4400, 4217)).toBe(true);
    expect(amountsCompatible(150, 100)).toBe(true);
    expect(amountsCompatible(1200, 10000)).toBe(false);
  });
  it('accepts receipt dates close to the purchase', () => {
    expect(dateCompatible('2026-03-09', '2026-03-10T03:00:00Z')).toBe(true);
    expect(dateCompatible('2026-01-01', '2026-03-10T03:00:00Z')).toBe(false);
  });
  it('derives the receipt state', () => {
    const now = Date.parse('2026-03-20T00:00:00Z');
    const t = (over: Partial<CardTransaction>) => ({ receipt_status: 'required', receipt_due_at: '2026-03-25T00:00:00Z', expense: null, ...over }) as CardTransaction;
    expect(receiptState(t({}), now)).toBe('needs_receipt');
    expect(receiptState(t({ receipt_due_at: '2026-03-15T00:00:00Z' }), now)).toBe('overdue');
    expect(receiptState(t({ receipt_status: 'waived' }), now)).toBe('waived');
    expect(receiptState(t({ receipt_status: 'attached', expense: { id: 'e', status: 'submitted', amount_cents: 1, review_note: null } }), now)).toBe('in_review');
    expect(receiptState(t({ receipt_status: 'attached', expense: { id: 'e', status: 'approved', amount_cents: 1, review_note: null } }), now)).toBe('approved');
    expect(receiptState(t({ receipt_status: 'attached', expense: { id: 'e', status: 'rejected', amount_cents: 1, review_note: 'x' } }), now)).toBe('rejected');
    expect(receiptState(t({ receipt_status: 'attached', expense: null }), now)).toBe('needs_receipt');
  });
});

describe('categories, summary and forms', () => {
  const cats = [{ id: 'c-fuel', name: 'Fuel & Vehicle', active: true }, { id: 'c-sup', name: 'Supplies', active: true }, { id: 'c-old', name: 'Retired', active: false }];
  it('prefers the OCR suggestion, then falls back to fuel for fuel cards', () => {
    expect(pickCategoryId('expense', 'supplies', cats)).toBe('c-sup');
    expect(pickCategoryId('fuel', null, cats)).toBe('c-fuel');
    expect(pickCategoryId('expense', null, cats)).toBe('');
    expect(pickCategoryId('expense', 'Retired', cats)).toBe('');
  });
  it('summarises the feed', () => {
    const now = Date.parse('2026-03-20T00:00:00Z');
    const list = [
      { amount_cents: 1000, technician_id: 't', receipt_status: 'required', receipt_due_at: '2026-03-01T00:00:00Z', expense: null },
      { amount_cents: 500, technician_id: null, receipt_status: 'required', receipt_due_at: '2026-03-30T00:00:00Z', expense: null },
      { amount_cents: 250, technician_id: 't', receipt_status: 'waived', receipt_due_at: null, expense: null },
    ] as CardTransaction[];
    expect(summarizeCardTxns(list, now)).toEqual({ total: 3, spendCents: 1750, needReceipt: 2, overdue: 1, unassigned: 1, rejected: 0, matchRate: 67 });
  });
  it('validates the card and settings forms', () => {
    expect(parseCardForm({ label: '', kind: 'expense', provider: '', last4: '12', vehicle_id: '', technician_id: '', status: 'active', notes: '' }).ok).toBe(false);
    const ok = parseCardForm({ label: ' Mike Ramp ', kind: 'expense', provider: '', last4: '4242', vehicle_id: '', technician_id: 't', status: 'active', notes: '' });
    expect(ok).toEqual({ ok: true, value: { label: 'Mike Ramp', kind: 'expense', provider: 'other', last4: '4242', vehicle_id: null, technician_id: 't', status: 'active', notes: null } });
    expect(parseFeedSettingsForm({ over: '75', days: '7' })).toEqual({ ok: true, value: { receipt_required_over_cents: 7500, receipt_due_days: 7 } });
    expect(parseFeedSettingsForm({ over: '-1', days: '0' }).ok).toBe(false);
  });
});
