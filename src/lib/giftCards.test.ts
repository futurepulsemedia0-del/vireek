import { describe, expect, it } from 'vitest';
import {
  deriveStatus,
  formatCode,
  invoiceTotalCents,
  maskCode,
  maxRedeemable,
  normalizeCode,
  parseAmountToCents,
  remainingDueCents,
  summarize,
  type GiftCard,
} from '@/lib/giftCards';

const NOW = new Date('2027-04-02T12:00:00Z');
const DAY = 86_400_000;

function card(over: Partial<GiftCard> = {}): GiftCard {
  return {
    id: 'c1',
    code: 'ABCD-EFGH-JK23',
    kind: 'gift_card',
    initial_cents: 10_000,
    balance_cents: 10_000,
    currency: 'usd',
    status: 'active',
    recipient_name: null,
    recipient_email: null,
    note: null,
    expires_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

describe('code helpers', () => {
  it('normalizes pasted or typed codes', () => {
    expect(normalizeCode(' abcd-efgh jk23 ')).toBe('ABCDEFGHJK23');
  });

  it('formats complete codes and rejects incomplete ones', () => {
    expect(formatCode('abcdefghjk23')).toBe('ABCD-EFGH-JK23');
    expect(formatCode('ABCD-EFGH')).toBeNull();
  });

  it('masks everything but the last block', () => {
    expect(maskCode('ABCD-EFGH-JK23')).toBe('••••-••••-JK23');
  });
});

describe('deriveStatus', () => {
  it('is active without an expiry', () => {
    expect(deriveStatus(card(), NOW)).toBe('active');
  });

  it('flips to expired once expires_at has passed', () => {
    expect(deriveStatus(card({ expires_at: new Date(NOW.getTime() - 1).toISOString() }), NOW)).toBe('expired');
    expect(deriveStatus(card({ expires_at: new Date(NOW.getTime() + DAY).toISOString() }), NOW)).toBe('active');
  });

  it('keeps depleted and voided regardless of expiry', () => {
    const past = new Date(NOW.getTime() - DAY).toISOString();
    expect(deriveStatus(card({ status: 'voided', expires_at: past }), NOW)).toBe('voided');
    expect(deriveStatus(card({ status: 'depleted', expires_at: past }), NOW)).toBe('depleted');
  });
});

describe('parseAmountToCents', () => {
  it('parses plain, decimal and formatted amounts exactly', () => {
    expect(parseAmountToCents('25')).toBe(2500);
    expect(parseAmountToCents('25.5')).toBe(2550);
    expect(parseAmountToCents('$1,250.07')).toBe(125_007);
    expect(parseAmountToCents('0.29')).toBe(29);
  });

  it('rejects invalid, zero, negative and over-cap values', () => {
    for (const bad of ['', 'abc', '0', '-5', '1.234', '100000.01', '1e3']) {
      expect(parseAmountToCents(bad)).toBeNull();
    }
    expect(parseAmountToCents('100000')).toBe(10_000_000);
  });
});

describe('invoice redemption math', () => {
  it('computes the invoice total with tax', () => {
    expect(
      invoiceTotalCents({ line_items: [{ description: 'Repair', quantity: 2, unit_price_cents: 10_000 }], tax_percent: 8.25 }),
    ).toBe(21_650);
  });

  it('never lets remaining due go negative', () => {
    expect(remainingDueCents(10_000, 4_000)).toBe(6_000);
    expect(remainingDueCents(10_000, 12_000)).toBe(0);
  });

  it('caps redemption at the lower of balance and amount owed', () => {
    expect(maxRedeemable(5_000, 8_000)).toBe(5_000);
    expect(maxRedeemable(9_000, 8_000)).toBe(8_000);
    expect(maxRedeemable(5_000, null)).toBe(5_000);
    expect(maxRedeemable(5_000, 0)).toBe(0);
  });
});

describe('summarize', () => {
  it('separates outstanding liability from expired, voided and used-up cards', () => {
    const cards = [
      card({ id: 'a', balance_cents: 7_500 }),
      card({ id: 'b', balance_cents: 2_000, expires_at: new Date(NOW.getTime() + 10 * DAY).toISOString() }),
      card({ id: 'c', balance_cents: 3_000, expires_at: new Date(NOW.getTime() - DAY).toISOString() }),
      card({ id: 'd', status: 'voided', balance_cents: 0 }),
      card({ id: 'e', status: 'depleted', balance_cents: 0 }),
    ];
    expect(summarize(cards, NOW)).toEqual({
      outstandingCents: 9_500,
      issuedCents: 40_000,
      activeCount: 2,
      expiringSoonCount: 1,
      expiredCents: 3_000,
    });
  });
});
