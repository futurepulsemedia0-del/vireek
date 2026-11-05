import { describe, it, expect } from 'vitest';
import {
  EMPTY_POLICY_FORM,
  PricePolicyFormError,
  formToPayload,
  legalWarnings,
  parseStates,
  previewPolicy,
  recordToForm,
  slugifyServiceKey,
  type PricePolicyForm,
  type PricePolicyRecord,
} from './pricePolicy';

const NOW = new Date('2028-04-01T12:00:00Z');
const VALUE = { licensed_techs: true, warranty_months: 12, on_time_guarantee: false };
const form = (o: Partial<PricePolicyForm> = {}): PricePolicyForm => ({ ...EMPTY_POLICY_FORM, display_name: 'AC repair', trade: 'hvac', mode: 'range', low: '200', high: '400', approved_states: 'tx', legal_review_status: 'approved', ...o });
const code = (f: PricePolicyForm): string | null => {
  try { formToPayload(f, 'u1', NOW.toISOString()); return null; } catch (e) { return e instanceof PricePolicyFormError ? e.code : 'other'; }
};

describe('formToPayload', () => {
  it('maps dollars to integer cents, uppercases states, stamps verified_at', () => {
    const p = formToPayload(form({ low: '199.99', high: '400.5' }), 'u1', NOW.toISOString());
    expect(p.amount_low_cents).toBe(19999);
    expect(p.amount_high_cents).toBe(40050);
    expect(p.approved_states).toEqual(['TX']);
    expect(p.verified_at).toBe(NOW.toISOString());
    expect(p.service_key).toBe('ac_repair');
  });
  it('rejects each invalid input with a stable code', () => {
    expect(code(form({ display_name: '  ' }))).toBe('name_required');
    expect(code(form({ low: '' }))).toBe('amount_invalid');
    expect(code(form({ low: '-5' }))).toBe('amount_invalid');
    expect(code(form({ low: 'abc' }))).toBe('amount_invalid');
    expect(code(form({ high: '100' }))).toBe('range_order');
    expect(code(form({ mode: 'diagnostic_fee_only', fee: '' }))).toBe('fee_invalid');
    expect(code(form({ mode: 'needs_visit', fee: '0' }))).toBe('fee_invalid');
    expect(code(form({ source_kind: 'price_book', price_book_item_id: '' }))).toBe('book_item_required');
    expect(code(form({ approved_states: 'TX, ZZ' }))).toBe('states_invalid');
    expect(code(form({ approved_states: '' }))).toBe('approval_needs_states');
  });
  it('price-book policies store no amounts; needs_visit needs none', () => {
    const p = formToPayload(form({ source_kind: 'price_book', price_book_item_id: 'item-1', low: '', high: '' }), 'u1', NOW.toISOString());
    expect(p.amount_low_cents).toBeNull();
    expect(p.price_book_item_id).toBe('item-1');
    expect(formToPayload(form({ mode: 'needs_visit', low: '', high: '', approved_states: '', legal_review_status: 'pending' }), 'u1', NOW.toISOString()).amount_low_cents).toBeNull();
  });
  it('splits includes/changes by line and caps lists', () => {
    const p = formToPayload(form({ includes: 'labor\n\n parts \n', changes_price: 'a\nb' }), 'u1', NOW.toISOString());
    expect(p.includes).toEqual(['labor', 'parts']);
    expect(p.changes_price).toEqual(['a', 'b']);
  });
  it('round-trips through recordToForm', () => {
    const p = formToPayload(form({ fee: '89', includes: 'labor' }), 'u1', NOW.toISOString());
    const rec: PricePolicyRecord = { ...p, id: 'x', created_at: '', updated_at: '' };
    const f2 = recordToForm(rec);
    expect(f2.low).toBe('200');
    expect(f2.fee).toBe('89');
    expect(formToPayload(f2, 'u1', NOW.toISOString())).toEqual(p);
  });
});

describe('helpers', () => {
  it('slugify', () => {
    expect(slugifyServiceKey('Água & Café!')).toBe('agua_cafe');
    expect(slugifyServiceKey('%%%')).toBe('service');
    expect(slugifyServiceKey('x'.repeat(200))).toHaveLength(80);
  });
  it('parseStates dedupes', () => {
    expect(parseStates('tx, TX  ca')).toEqual(['TX', 'CA']);
    expect(parseStates('')).toEqual([]);
  });
});

describe('previewPolicy', () => {
  const payload = formToPayload(form({ fee: '89', fee_credited_on_repair: true }), 'u1', '2028-03-25T00:00:00Z');
  it('shows the allowed answer and passes the audit for an approved state', () => {
    const p = previewPolicy(payload, null, 'TX', NOW, VALUE);
    expect(p.reply.answer.mode_used).toBe('range');
    expect(p.reply.text).toContain('$200');
    expect(p.reply.text).toContain('$89 diagnostic fee');
    expect(p.violations).toEqual([]);
    expect(p.sourceLabels.length).toBeGreaterThan(0);
  });
  it('shows the fail-closed answer for an unapproved state and when state is unknown', () => {
    expect(previewPolicy(payload, null, 'CA', NOW, VALUE).reply.answer.downgraded_reason).toBe('legal_gate');
    expect(previewPolicy(payload, null, null, NOW, VALUE).reply.answer.downgraded_reason).toBe('region_unknown');
  });
  it('reads live amounts from the price book for price_book policies', () => {
    const pb = formToPayload(form({ source_kind: 'price_book', price_book_item_id: 'i', mode: 'exact_flat', low: '', high: '' }), 'u1', '2028-03-25T00:00:00Z');
    const p = previewPolicy(pb, { pricing_model: 'flat', price_cents: 31000, price_max_cents: null }, 'TX', NOW, VALUE);
    expect(p.reply.text).toContain('$310');
  });
});

describe('legalWarnings', () => {
  const base = { legal_review_status: 'approved' as const, approved_states: ['TX'], verified_at: '2028-03-25T00:00:00Z', mode: 'range' as const };
  it('flags pending review, missing states and stale figures', () => {
    expect(legalWarnings(base, NOW)).toEqual([]);
    expect(legalWarnings({ ...base, legal_review_status: 'pending' }, NOW)).toEqual(['pending_review']);
    expect(legalWarnings({ ...base, approved_states: [] }, NOW)).toEqual(['no_states']);
    expect(legalWarnings({ ...base, verified_at: '2027-01-01T00:00:00Z' }, NOW)).toEqual(['stale']);
    expect(legalWarnings({ ...base, mode: 'needs_visit', legal_review_status: 'pending' }, NOW)).toEqual([]);
  });
});
