import { describe, it, expect } from 'vitest';
import {
  buildReferralLink,
  conversionRate,
  countConversionTabs,
  defaultMethodFor,
  describeRule,
  emptyRuleForm,
  filterConversions,
  formatMoney,
  formatReward,
  isPayable,
  mailtoHref,
  pickRule,
  rankLeaderboard,
  ruleToPayload,
  shareMessage,
  smsHref,
  sumPayable,
  summarizeBoard,
  validateRule,
  whatsappHref,
  type ConversionDetail,
  type LeaderboardRow,
  type RewardRule,
  type RuleFormValues,
} from './referrals';

const rule = (over: Partial<RewardRule> = {}): RewardRule => ({
  id: 'r', user_id: 'u', name: 'Base', reward_type: 'credit', reward_value: 25,
  min_invoice_amount: 0, min_conversions: 0, is_active: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});

const row = (over: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
  referral_code_id: 'c', code: 'AAAA', referrer_customer_id: null, referrer_name: 'Zed', clicks: 0,
  conversions: 0, rewarded: 0, earned: 0, unpaid: 0, last_converted_at: null, ...over,
});

const conv = (over: Partial<ConversionDetail> = {}): ConversionDetail => ({
  id: 'v', referral_code_id: 'c', code: 'AAAA', referrer_customer_id: null, referrer_name: 'Sara',
  referred_customer_id: null, referred_name: 'Omid', status: 'converted', created_at: '2026-10-01T00:00:00Z',
  converted_at: '2026-10-02T00:00:00Z', rewarded_at: null, reward_type: 'credit', reward_value: 25,
  reward_amount: 25, qualifying_amount: 500, payout_id: null, payout_method: null, payout_paid_at: null, ...over,
});

const form = (over: Partial<RuleFormValues> = {}): RuleFormValues => ({
  ...emptyRuleForm(), name: 'Standard', rewardValue: '25', ...over,
});

describe('formatting', () => {
  it('formats money without noisy decimals', () => {
    expect(formatMoney(25)).toBe('$25');
    expect(formatMoney(12.5)).toBe('$12.50');
    expect(formatMoney(1200)).toBe('$1,200');
    expect(formatMoney(0)).toBe('$0');
  });
  it('labels rewards by type', () => {
    expect(formatReward('credit', 25)).toBe('$25 account credit');
    expect(formatReward('cash', 12.5)).toBe('$12.50 cash');
    expect(formatReward('discount', 10)).toBe('10% off');
    expect(formatReward('discount', 12.5)).toBe('12.5% off');
  });
});

describe('links and sharing', () => {
  it('builds the /r/ tracking link and encodes the code', () => {
    expect(buildReferralLink('https://vireek.com', 'AB12')).toBe('https://vireek.com/r/AB12');
    expect(buildReferralLink('https://vireek.com/', 'A B')).toBe('https://vireek.com/r/A%20B');
  });
  it('encodes share hrefs', () => {
    expect(smsHref('Hi & bye')).toBe('sms:?&body=Hi%20%26%20bye');
    expect(mailtoHref('Sub', 'Body line')).toBe('mailto:?subject=Sub&body=Body%20line');
    expect(whatsappHref('x y')).toBe('https://wa.me/?text=x%20y');
  });
  it('puts the link and the reward in the message', () => {
    const m = shareMessage('https://vireek.com/r/AB12', '$25 account credit');
    expect(m).toContain('https://vireek.com/r/AB12');
    expect(m).toContain('$25 account credit');
    expect(shareMessage('https://x/r/A')).not.toContain('you\'ll get');
  });
});

describe('reward rules', () => {
  it('validates and converts a form', () => {
    expect(validateRule(form())).toEqual({});
    expect(Object.keys(validateRule(emptyRuleForm())).sort()).toEqual(['name', 'rewardValue']);
    expect(validateRule(form({ rewardType: 'discount', rewardValue: '150' })).rewardValue).toMatch(/100%/);
    expect(validateRule(form({ minInvoice: 'abc' })).minInvoice).toBeDefined();
    expect(validateRule(form({ minConversions: '1.5' })).minConversions).toBeDefined();
    const p = ruleToPayload(form({ rewardType: 'cash', rewardValue: '1,200.50', minInvoice: '500', minConversions: '5' }));
    expect(p).toMatchObject({ reward_type: 'cash', reward_value: 1200.5, min_invoice_amount: 500, min_conversions: 5 });
    expect(ruleToPayload(form()).min_conversions).toBe(0);
  });

  const rules = [
    rule({ id: 'A', reward_value: 25 }),
    rule({ id: 'B', reward_value: 40, min_invoice_amount: 500 }),
    rule({ id: 'C', reward_value: 50, min_conversions: 5 }),
    rule({ id: 'D', reward_value: 99, min_conversions: 10, is_active: false }),
  ];
  it('picks the most specific active rule, like the database trigger', () => {
    expect(pickRule(rules, { amount: 100, priorConversions: 0 })?.id).toBe('A');
    expect(pickRule(rules, { amount: 600, priorConversions: 0 })?.id).toBe('B');
    expect(pickRule(rules, { amount: 100, priorConversions: 5 })?.id).toBe('C');
    expect(pickRule(rules, { amount: 600, priorConversions: 10 })?.id).toBe('C'); // D is paused
    expect(pickRule([], { amount: 100, priorConversions: 0 })).toBeNull();
  });
  it('prefers the newest rule when two are equally specific', () => {
    const tied = [rule({ id: 'old' }), rule({ id: 'new', created_at: '2026-06-01T00:00:00Z' })];
    expect(pickRule(tied, { amount: 0, priorConversions: 0 })?.id).toBe('new');
  });
  it('describes a rule in plain language', () => {
    expect(describeRule(rule())).toBe('Converted referrals earn $25 account credit.');
    expect(describeRule(rule({ reward_type: 'cash', reward_value: 50, min_conversions: 5, min_invoice_amount: 500 }))).toBe(
      'Converted referrals earn $50 cash once the referrer has 5+ earlier conversions and the referred customer pays $500+.',
    );
  });
});

describe('leaderboard', () => {
  it('computes click-to-conversion rate safely', () => {
    expect(conversionRate(0, 3)).toBeNull();
    expect(conversionRate(10, 3)).toBe(30);
    expect(conversionRate(3, 1)).toBe(33.3);
    expect(conversionRate(2, 5)).toBe(100);
  });
  it('ranks by conversions then rewards, and shares rank on ties', () => {
    const ranked = rankLeaderboard([
      row({ referral_code_id: 'd', referrer_name: 'D' }),
      row({ referral_code_id: 'b', referrer_name: 'B', conversions: 3, unpaid: 75 }),
      row({ referral_code_id: 'c', referrer_name: 'C', conversions: 5 }),
      row({ referral_code_id: 'a', referrer_name: 'A', conversions: 3, unpaid: 75 }),
    ]);
    expect(ranked.map((r) => [r.referral_code_id, r.rank])).toEqual([['c', 1], ['a', 2], ['b', 2], ['d', 4]]);
  });
  it('totals the board', () => {
    const s = summarizeBoard([
      row({ clicks: 10, conversions: 2, earned: 25, unpaid: 25 }),
      row({ clicks: 10, conversions: 3, rewarded: 1, earned: 0, unpaid: 75 }),
    ]);
    expect(s).toMatchObject({ links: 2, clicks: 20, conversions: 5, earned: 25, unpaid: 100, rate: 25 });
  });
});

describe('payouts', () => {
  const list = [
    conv({ id: '1' }),
    conv({ id: '2', reward_type: null, reward_value: null, reward_amount: null }),
    conv({ id: '3', status: 'pending', converted_at: null, reward_type: null }),
    conv({ id: '4', status: 'rewarded', payout_id: 'p1' }),
  ];
  it('only pays converted referrals that have a reward', () => {
    expect(isPayable(list[0])).toBe(true);
    expect(isPayable(list[1])).toBe(false);
    expect(isPayable(list[3])).toBe(false);
  });
  it('filters and counts by tab', () => {
    expect(countConversionTabs(list)).toEqual({ to_pay: 1, pending: 1, paid: 1, all: 4 });
    expect(filterConversions(list, { tab: 'paid', query: '' }).map((c) => c.id)).toEqual(['4']);
    expect(filterConversions(list, { tab: 'all', query: 'OMID' })).toHaveLength(4);
    expect(filterConversions(list, { tab: 'all', query: 'nobody' })).toHaveLength(0);
  });
  it('sums dollars separately from percent discounts', () => {
    expect(
      sumPayable([
        { reward_type: 'credit', reward_amount: 25 },
        { reward_type: 'discount', reward_amount: null },
        { reward_type: 'cash', reward_amount: 15 },
      ]),
    ).toEqual({ cash: 40, discounts: 1 });
  });
  it('suggests a sensible default method', () => {
    expect(defaultMethodFor(['credit'])).toBe('account_credit');
    expect(defaultMethodFor(['cash', 'cash'])).toBe('cash');
    expect(defaultMethodFor(['discount'])).toBe('invoice_discount');
    expect(defaultMethodFor(['credit', 'cash'])).toBe('other');
    expect(defaultMethodFor([])).toBe('other');
  });
});
