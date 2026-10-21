import { describe, expect, it } from 'vitest';
import {
  addInterval,
  cardFromCharge,
  cardLabel,
  cardUsable,
  chargeDecision,
  cycleLeadDays,
  daysUntil,
  noticeToSend,
  paymentRoute,
  renewalChargeIdempotencyKey,
  renewalNoticeMessage,
  renewalPricing,
  stageForDaysLeft,
  winBackEventData,
  formatUsd,
} from './logic';

const NOW = new Date('2027-03-01T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('daysUntil / stageForDaysLeft', () => {
  it('rounds partial days up and goes negative once past', () => {
    expect(daysUntil(days(6.2), NOW)).toBe(7);
    expect(daysUntil(days(60), NOW)).toBe(60);
    expect(daysUntil(days(-0.5), NOW)).toBe(-1);
  });
  it('buckets yearly renewals into 60 / 30 / 7 / due', () => {
    expect(stageForDaysLeft(61, 'yearly')).toBe('upcoming_60');
    expect(stageForDaysLeft(31, 'yearly')).toBe('upcoming_60');
    expect(stageForDaysLeft(30, 'yearly')).toBe('upcoming_30');
    expect(stageForDaysLeft(8, 'yearly')).toBe('upcoming_30');
    expect(stageForDaysLeft(7, 'yearly')).toBe('upcoming_7');
    expect(stageForDaysLeft(0, 'yearly')).toBe('due');
  });
  it('monthly plans only ever use the 7-day window', () => {
    expect(cycleLeadDays('monthly')).toBe(7);
    expect(stageForDaysLeft(20, 'monthly')).toBe('upcoming_7');
  });
});

describe('addInterval', () => {
  it('adds a month or a year without mutating the input', () => {
    const d = new Date('2027-01-15T00:00:00Z');
    expect(addInterval(d, 'yearly').getUTCFullYear()).toBe(2028);
    expect(addInterval(d, 'monthly').getUTCMonth()).toBe(1);
    expect(d.getUTCFullYear()).toBe(2027);
  });
});

describe('renewalPricing', () => {
  it('renews at the plan price by default', () => {
    expect(renewalPricing({ price_cents: 29900 })).toEqual({ amountCents: 29900, previousCents: 29900, changed: false });
  });
  it('uses the renewal price override, including a deliberate $0', () => {
    expect(renewalPricing({ price_cents: 29900, renewal_price_cents: 32900 })).toEqual({ amountCents: 32900, previousCents: 29900, changed: true });
    expect(renewalPricing({ price_cents: 29900, renewal_price_cents: 0 }).amountCents).toBe(0);
  });
  it('ignores a nonsense override', () => {
    expect(renewalPricing({ price_cents: 100, renewal_price_cents: Number.NaN }).amountCents).toBe(100);
  });
});

describe('cardUsable / paymentRoute', () => {
  const base = {
    auto_renew: true,
    stripe_customer_id: 'cus_1',
    stripe_payment_method_id: 'pm_1',
    auto_renew_consent_at: '2026-03-01T00:00:00Z',
    card_exp_month: 12,
    card_exp_year: 2030,
  };
  it('needs a saved method, a customer, consent and auto-renew on', () => {
    expect(cardUsable(base, NOW)).toBe(true);
    expect(cardUsable({ ...base, auto_renew: false }, NOW)).toBe(false);
    expect(cardUsable({ ...base, auto_renew_consent_at: null }, NOW)).toBe(false);
    expect(cardUsable({ ...base, stripe_payment_method_id: null }, NOW)).toBe(false);
    expect(cardUsable({ ...base, stripe_customer_id: null }, NOW)).toBe(false);
  });
  it('treats a card as valid through the last day of its expiry month', () => {
    const card = { ...base, card_exp_month: 3, card_exp_year: 2027 };
    expect(cardUsable(card, new Date('2027-03-31T23:00:00Z'))).toBe(true);
    expect(cardUsable(card, new Date('2027-04-01T00:00:00Z'))).toBe(false);
  });
  it('falls back to the pay link when the card is unusable at the renewal date', () => {
    expect(paymentRoute(base, days(30))).toBe('card_on_file');
    expect(paymentRoute({ ...base, card_exp_month: 3, card_exp_year: 2027 }, new Date('2027-05-01T00:00:00Z'))).toBe('pay_link');
  });
});

describe('noticeToSend', () => {
  it('sends the 60-day quote first', () => {
    expect(noticeToSend(58, 'yearly', [])).toEqual({ send: '60', mark: ['60'] });
  });
  it('sends 30 then 7 as the date approaches', () => {
    expect(noticeToSend(29, 'yearly', ['60'])).toEqual({ send: '30', mark: ['30'] });
    expect(noticeToSend(6, 'yearly', ['60', '30'])).toEqual({ send: '7', mark: ['7'] });
  });
  it('never fires several notices at once for a late-opened cycle', () => {
    expect(noticeToSend(20, 'yearly', [])).toEqual({ send: '30', mark: ['60', '30'] });
    expect(noticeToSend(5, 'yearly', [])).toEqual({ send: '7', mark: ['60', '30', '7'] });
  });
  it('is idempotent and silent when nothing is new', () => {
    expect(noticeToSend(58, 'yearly', ['60'])).toEqual({ send: null, mark: [] });
    expect(noticeToSend(0, 'yearly', [])).toEqual({ send: null, mark: [] });
  });
  it('catches up silently if the closest notice was already sent', () => {
    expect(noticeToSend(20, 'yearly', ['30'])).toEqual({ send: null, mark: ['60'] });
  });
  it('monthly plans only get the 7-day notice', () => {
    expect(noticeToSend(20, 'monthly', [])).toEqual({ send: null, mark: [] });
    expect(noticeToSend(6, 'monthly', [])).toEqual({ send: '7', mark: ['7'] });
  });
});

describe('chargeDecision', () => {
  const periodEnd = '2027-03-01T00:00:00Z';
  const at = (offsetDays: number, hours = 12) => new Date(new Date(periodEnd).getTime() + offsetDays * 86_400_000 + hours * 3_600_000);
  it('charges on the renewal date and waits before it', () => {
    expect(chargeDecision({ now: new Date('2027-02-28T23:00:00Z'), periodEnd, attempts: 0, quoteStatus: 'sent' })).toBe('wait');
    expect(chargeDecision({ now: at(0), periodEnd, attempts: 0, quoteStatus: 'sent' })).toBe('charge');
  });
  it('retries at +3 and +7 days, never more than 3 attempts', () => {
    expect(chargeDecision({ now: at(2), periodEnd, attempts: 1, lastAttemptAt: at(0).toISOString(), quoteStatus: 'accepted' })).toBe('wait');
    expect(chargeDecision({ now: at(3), periodEnd, attempts: 1, lastAttemptAt: at(0).toISOString(), quoteStatus: 'accepted' })).toBe('charge');
    expect(chargeDecision({ now: at(7), periodEnd, attempts: 2, lastAttemptAt: at(3).toISOString(), quoteStatus: 'sent' })).toBe('charge');
    expect(chargeDecision({ now: at(20), periodEnd, attempts: 3, quoteStatus: 'sent' })).toBe('skip');
  });
  it('never double-charges within 20 hours of the last attempt', () => {
    expect(chargeDecision({ now: at(0, 14), periodEnd, attempts: 0, lastAttemptAt: at(0, 12).toISOString(), quoteStatus: 'sent' })).toBe('wait');
  });
  it('never charges a member who declined the renewal', () => {
    expect(chargeDecision({ now: at(1), periodEnd, attempts: 0, quoteStatus: 'declined' })).toBe('skip');
  });
});

describe('messages and formatting', () => {
  const ctx = {
    customerName: 'Dana Smith',
    planName: 'Annual Maintenance',
    amountCents: 32900,
    previousCents: 29900,
    periodEnd: '2027-05-01T00:00:00Z',
    route: 'card_on_file' as const,
    cardLabel: 'Visa ending 4242',
    url: 'https://vireek.com/renew/abc',
  };
  it('states the price change and the card that will be charged', () => {
    const { text } = renewalNoticeMessage('60', ctx);
    expect(text).toContain('Hi Dana');
    expect(text).toContain('$329 (was $299)');
    expect(text).toContain('Visa ending 4242');
    expect(text).toContain('May 1, 2027');
    expect(text).toContain('https://vireek.com/renew/abc');
  });
  it('does not promise a charge for pay-link members', () => {
    const { text } = renewalNoticeMessage('30', { ...ctx, route: 'pay_link', amountCents: 29900 });
    expect(text).not.toContain('charge');
    expect(text).not.toContain('was');
  });
  it('formats money', () => {
    expect(formatUsd(29900)).toBe('$299');
    expect(formatUsd(29950)).toBe('$299.50');
    expect(formatUsd(123456)).toBe('$1,234.56');
  });
  it('builds a stable idempotency key per cycle and attempt', () => {
    expect(renewalChargeIdempotencyKey('c1', 0)).toBe(renewalChargeIdempotencyKey('c1', 0));
    expect(renewalChargeIdempotencyKey('c1', 0)).not.toBe(renewalChargeIdempotencyKey('c1', 1));
  });
  it('builds win-back variables, tolerating a plan without a public link', () => {
    expect(winBackEventData({ name: 'Annual', price_cents: 29900, public_slug: 'annual-1' }, 'https://vireek.com/')).toEqual({
      plan_name: 'Annual',
      amount: '$299',
      plan_join_url: 'https://vireek.com/join/annual-1',
    });
    expect(winBackEventData(null, 'https://vireek.com').plan_join_url).toBeNull();
  });
  it('reads card details from a Stripe charge', () => {
    expect(cardFromCharge({ payment_method_details: { card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } })).toEqual({
      brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030,
    });
    expect(cardFromCharge({ payment_method_details: { type: 'us_bank_account' } })).toBeNull();
    expect(cardFromCharge(null)).toBeNull();
    expect(cardLabel('visa', '4242')).toBe('Visa ending 4242');
    expect(cardLabel('visa', null)).toBeNull();
  });
});
