// Money correctness for the golden path (vitest). NOT RUN when authored (no node_modules in the review sandbox).
import { describe, expect, it } from 'vitest';
import { calculateVat, VAT_RATES } from '@/lib/tax';
import { taxOnBase } from '@/lib/salesTax';
import { calculateQuoteTotals } from '@/lib/quotes';
import { computeInvoiceLedger, parseMoneyInput, refundableForPayment } from '@/lib/invoiceDetail';
import { invoiceTotalsSqlParity } from '@/lib/invoiceMoney';

// Independent exact reference (BigInt) of the SQL: round(sub + round(sub*tax/100)), half away from zero.
function sqlReference(qty: number, unitCents: number, taxPercent: number): number {
  const q = BigInt(Math.round(qty * 100));
  const tp = BigInt(Math.round(taxPercent * 10000));
  const subS = q * BigInt(unitCents); // 1/100 cent
  const tax = (subS * tp * 2n + 100000000n) / 200000000n;
  return Number((subS + tax * 100n + 50n) / 100n);
}

describe('VAT (calculateVat) uses exact half-up rounding', () => {
  it('19% of 42.50 is 8.08, not the float result 8.07', () => {
    const r = calculateVat({ sellerCountry: 'DE', customerCountry: 'DE', subtotal: 42.5 });
    expect(r.vatAmount).toBe(8.08);
    expect(r.total).toBe(50.58);
  });
  it('matches integer arithmetic for every cent amount up to 2000.00 across several rates', () => {
    for (const country of ['DE', 'FR', 'FI', 'CH', 'LU']) {
      const rate = VAT_RATES[country];
      const scaled = Math.round(rate * 10000);
      for (let cents = 1; cents <= 200000; cents += 7) {
        const expected = Math.floor((cents * scaled + 500000) / 1000000) / 100;
        expect(calculateVat({ sellerCountry: country, customerCountry: country, subtotal: cents / 100 }).vatAmount).toBe(expected);
      }
    }
  });
  it('reverse charge and unknown country stay at zero VAT', () => {
    expect(calculateVat({ sellerCountry: 'DE', customerCountry: 'FR', customerVatNumber: 'FR12345678901', subtotal: 100 }).vatAmount).toBe(0);
    expect(calculateVat({ sellerCountry: null, customerCountry: 'FR', subtotal: 100 }).vatAmount).toBe(0);
  });
});

describe('sales tax rounding', () => {
  it('rounds half up in integer cents', () => {
    expect(taxOnBase(1000, 8.25)).toBe(83); // 82.5 -> 83
    expect(taxOnBase(1, 50)).toBe(1); // 0.5 -> 1
    expect(taxOnBase(0, 8.25)).toBe(0);
    expect(taxOnBase(1000, 0)).toBe(0);
  });
});

describe('invoice totals match the database function', () => {
  it('fractional quantity never leaves half-cents', () => {
    expect(invoiceTotalsSqlParity([{ quantity: 1.25, unit_price_cents: 1 }], 0).totalCents).toBe(1);
    expect(invoiceTotalsSqlParity([{ quantity: 1.5, unit_price_cents: 333 }], 0).totalCents).toBe(500);
    expect(invoiceTotalsSqlParity([{ quantity: 1.5, unit_price_cents: 333 }], 8.25)).toEqual({ subtotalCents: 500, taxCents: 41, totalCents: 541 });
  });
  it('is always an integer and equals subtotal + tax', () => {
    for (const q of [1, 2, 3, 0.5, 1.5, 0.25, 2.5, 0.1]) {
      for (const tp of [0, 5, 6.25, 7.5, 8.25, 8.875, 10, 19, 25.5]) {
        for (let p = 1; p <= 400; p += 3) {
          const r = invoiceTotalsSqlParity([{ quantity: q, unit_price_cents: p }], tp);
          expect(Number.isInteger(r.totalCents)).toBe(true);
          expect(r.totalCents).toBe(r.subtotalCents + r.taxCents);
          expect(r.totalCents).toBe(sqlReference(q, p, tp));
        }
      }
    }
  });
  it('sums several lines exactly before rounding', () => {
    const r = invoiceTotalsSqlParity([{ quantity: 0.5, unit_price_cents: 1 }, { quantity: 0.5, unit_price_cents: 1 }], 0);
    expect(r.totalCents).toBe(1); // 0.5 + 0.5 = 1, not round(0.5)+round(0.5) = 2
  });
  it('empty invoice is zero', () => {
    expect(invoiceTotalsSqlParity([], 10)).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });
});

describe('discounts (calculateQuoteTotals)', () => {
  const items = [{ description: 'Svc', quantity: 1, unit_price_cents: 10000 }];
  it('promo is pre-tax', () => {
    expect(calculateQuoteTotals(items, 10, 2500)).toEqual({ subtotalCents: 10000, discountCents: 2500, taxCents: 750, totalCents: 8250 });
  });
  it('promo can never exceed the subtotal or go negative', () => {
    expect(calculateQuoteTotals(items, 10, 999999).totalCents).toBe(0);
    expect(calculateQuoteTotals(items, 10, -500).discountCents).toBe(0);
  });
});

describe('partial payments and refunds (computeInvoiceLedger)', () => {
  const inv = { line_items: [{ description: 'Svc', quantity: 1, unit_price_cents: 10000 }], tax_percent: 0, status: 'sent' as const };
  it('unpaid -> partial -> paid -> partial after refund -> refunded', () => {
    expect(computeInvoiceLedger(inv, [], []).state).toBe('unpaid');
    expect(computeInvoiceLedger(inv, [{ amount_cents: 6000 }], []).state).toBe('partial');
    expect(computeInvoiceLedger(inv, [{ amount_cents: 6000 }], []).balanceCents).toBe(4000);
    expect(computeInvoiceLedger(inv, [{ amount_cents: 6000 }, { amount_cents: 4000 }], []).state).toBe('paid');
    expect(computeInvoiceLedger(inv, [{ amount_cents: 10000 }], [{ amount_cents: 1000 }]).state).toBe('partial');
    expect(computeInvoiceLedger(inv, [{ amount_cents: 10000 }], [{ amount_cents: 10000 }]).state).toBe('refunded');
  });
  it('a fractional-quantity invoice is paid by the database total (no phantom balance)', () => {
    const frac = { line_items: [{ description: 'Hrs', quantity: 1.25, unit_price_cents: 1 }], tax_percent: 0, status: 'sent' as const };
    const l = computeInvoiceLedger(frac, [{ amount_cents: 1 }], []);
    expect(l.totalCents).toBe(1);
    expect(l.state).toBe('paid');
  });
  it('refundable amount per payment', () => {
    expect(refundableForPayment({ id: 'p1', amount_cents: 5000 }, [{ payment_id: 'p1', amount_cents: 1200 }, { payment_id: 'p2', amount_cents: 999 }])).toBe(3800);
    expect(refundableForPayment({ id: 'p1', amount_cents: 5000 }, [{ payment_id: 'p1', amount_cents: 9000 }])).toBe(0);
  });
});

describe('typed money input has no float drift', () => {
  it.each([['19.99', 1999], ['0.1', 10], ['1,234.50', 123450], ['$5', 500]])('%s -> %d cents', (raw, cents) => {
    expect(parseMoneyInput(raw, 10_000_000)).toEqual({ ok: true, cents });
  });
  it.each(['0.001', '-5', '', '0', 'abc'])('rejects %j', (raw) => {
    expect(parseMoneyInput(raw, 10_000_000).ok).toBe(false);
  });
  it('rejects above the balance', () => {
    expect(parseMoneyInput('100.01', 10000).ok).toBe(false);
  });
});
