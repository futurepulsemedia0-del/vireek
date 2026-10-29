import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, formatMoney, isOpen, lineDelta, statusTone, summarizeReview, totalMismatch, validateConnection, type PunchoutLine } from './punchout';

const line = (o: Partial<PunchoutLine>): PunchoutLine => ({
  id: 'l', session_id: 's', line_no: 1, sku: 'A', name: 'A', mpn: null, manufacturer: null, uom: 'each', quantity: 1,
  unit_price_cents: 1000, lead_time_days: null, catalog_item_id: null, catalog_cost_cents: null, ...o,
});

describe('summarizeReview', () => {
  it('totals units and money and counts price changes and new parts', () => {
    const s = summarizeReview([
      line({ quantity: 2, unit_price_cents: 1250, catalog_cost_cents: 1000 }), // +250 x2
      line({ id: '2', quantity: 1, unit_price_cents: 900, catalog_cost_cents: 1000 }), // -100
      line({ id: '3', quantity: 3, unit_price_cents: 500, catalog_cost_cents: 500 }), // same
      line({ id: '4', quantity: 1, unit_price_cents: 700 }), // new
    ]);
    expect(s).toEqual({ lineCount: 4, unitCount: 7, totalCents: 2500 + 900 + 1500 + 700, changed: 2, increased: 1, newParts: 1, deltaCents: 400 });
  });
  it('handles an empty cart', () => {
    expect(summarizeReview([]).totalCents).toBe(0);
  });
});

describe('lineDelta / totalMismatch', () => {
  it('returns null for new parts', () => expect(lineDelta(line({}))).toBeNull());
  it('ignores 1-cent rounding and missing supplier totals', () => {
    expect(totalMismatch(null, 1000)).toBeNull();
    expect(totalMismatch(1001, 1000)).toBeNull();
    expect(totalMismatch(1500, 1000)).toBe(500);
  });
});

describe('validateConnection', () => {
  const ok = { ...EMPTY_FORM, vendor_id: 'v', setup_url: 'https://punchout.example.com/cxml', buyer_identity: 'b', sender_identity: 's', supplier_identity: 'x', shared_secret: 'secret1' };
  it('accepts a complete form', () => expect(validateConnection(ok, false)).toEqual({}));
  it('requires a secret only for new connections', () => {
    expect(validateConnection({ ...ok, shared_secret: '' }, false).shared_secret).toBeTruthy();
    expect(validateConnection({ ...ok, shared_secret: '' }, true).shared_secret).toBeUndefined();
  });
  it('flags http URLs, short secrets and bad currency', () => {
    const e = validateConnection({ ...ok, setup_url: 'http://x.com', shared_secret: 'ab', currency: 'US' }, false);
    expect(e.setup_url && e.shared_secret && e.currency).toBeTruthy();
  });
});

describe('misc', () => {
  it('formats money and survives bad input', () => {
    expect(formatMoney(1250)).toBe('$12.50');
    expect(formatMoney(NaN)).toBe('$0.00');
    expect(formatMoney(100, 'zz')).toBe('$1.00');
  });
  it('maps status to tone and open-ness', () => {
    expect(statusTone('ordered')).toBe('success');
    expect(isOpen({ status: 'started' })).toBe(true);
    expect(isOpen({ status: 'returned' })).toBe(false);
  });
});
