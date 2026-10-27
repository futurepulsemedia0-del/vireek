import { describe, expect, it } from 'vitest';
import {
  basePoints,
  canAfford,
  countPending,
  DEFAULT_SETUP,
  describeEarnRule,
  earnRuleToPayload,
  emptyEarnRuleForm,
  filterMembers,
  filterRedemptions,
  floorSafe,
  formatMoney,
  formatMultiplier,
  formatPoints,
  formatRewardValue,
  formatSigned,
  nextTier,
  pointsShort,
  previewEarn,
  redemptionTone,
  rewardToPayload,
  sortMembers,
  tierForLifetime,
  tierProgress,
  timeAgo,
  validateAdjust,
  validateEarnRule,
  validateReward,
  validateSettings,
  validateTier,
  type EarnRule,
  type LoyaltyTier,
  type MemberSummary,
  type RedemptionDetail,
  type RewardForm,
  type TierForm,
} from './loyalty';

const rule = (o: Partial<EarnRule> = {}): EarnRule => ({
  id: 'r1', name: 'Base', kind: 'per_dollar', points_value: 1, service_type: null, min_invoice_amount: 0, is_active: true, ...o,
});
const tier = (o: Partial<LoyaltyTier> = {}): LoyaltyTier => ({
  id: 't1', name: 'Silver', min_lifetime_points: 0, earn_multiplier: 1, perks: null, ...o,
});
const member = (o: Partial<MemberSummary> = {}): MemberSummary => ({
  customer_id: 'c1', name: 'Jane Doe', phone: '555-0100', email: 'jane@example.com', points_balance: 100, lifetime_points: 400,
  tier_id: null, tier_name: 'Silver', earn_multiplier: 1, last_activity_at: '2026-10-20T10:00:00Z', ...o,
});

const TIERS = [
  tier({ id: 'p', name: 'Platinum', min_lifetime_points: 5000, earn_multiplier: 2 }),
  tier({ id: 's', name: 'Silver', min_lifetime_points: 0, earn_multiplier: 1 }),
  tier({ id: 'g', name: 'Gold', min_lifetime_points: 1000, earn_multiplier: 1.5 }),
];
const RULES = [
  rule({ id: 'a', name: 'Every dollar', points_value: 1 }),
  rule({ id: 'b', name: 'AC bonus', kind: 'flat_per_job', points_value: 50, service_type: 'AC repair', min_invoice_amount: 100 }),
  rule({ id: 'c', name: 'Off', points_value: 10, is_active: false }),
];

describe('tiers', () => {
  it('picks the highest tier at or below lifetime points regardless of input order', () => {
    expect(tierForLifetime(TIERS, 0)?.name).toBe('Silver');
    expect(tierForLifetime(TIERS, 999)?.name).toBe('Silver');
    expect(tierForLifetime(TIERS, 1000)?.name).toBe('Gold');
    expect(tierForLifetime(TIERS, 9999)?.name).toBe('Platinum');
    expect(tierForLifetime([], 50)).toBeNull();
  });

  it('finds the next tier and progress toward it', () => {
    expect(nextTier(TIERS, 1200)?.name).toBe('Platinum');
    const p = tierProgress(TIERS, 1200);
    expect(p.current?.name).toBe('Gold');
    expect(p.pointsToNext).toBe(3800);
    expect(p.percent).toBe(5);
    expect(tierProgress(TIERS, 0)).toMatchObject({ pointsToNext: 1000, percent: 0 });
  });

  it('reports 100% at the top tier and handles no tiers', () => {
    expect(tierProgress(TIERS, 6000)).toMatchObject({ next: null, pointsToNext: 0, percent: 100 });
    expect(tierProgress([], 50)).toMatchObject({ current: null, next: null });
  });
});

describe('earn math (mirrors the database)', () => {
  it('floors after rounding so decimal money never loses a point', () => {
    expect(4.35 * 100).not.toBe(435);
    expect(floorSafe(4.35 * 100)).toBe(435);
    expect(floorSafe(59.97)).toBe(59);
  });

  it('sums every matching active rule and ignores inactive ones', () => {
    expect(basePoints(RULES, 450, 'ac repair ')).toBe(500);
    expect(basePoints(RULES, 450, 'Plumbing')).toBe(450);
  });

  it('respects the minimum invoice amount', () => {
    expect(basePoints(RULES, 99, 'AC repair')).toBe(99);
    expect(basePoints(RULES, 100, 'AC repair')).toBe(150);
  });

  it('applies the tier multiplier from lifetime points before this job', () => {
    const p = previewEarn(RULES, TIERS, { amount: 450, service: 'AC repair', lifetime: 1200 });
    expect(p).toMatchObject({ base: 500, multiplier: 1.5, points: 750, tierName: 'Gold' });
    expect(p.matched).toEqual(['Every dollar', 'AC bonus']);
  });

  it('earns nothing for empty or invalid amounts and caps runaway values', () => {
    expect(previewEarn(RULES, TIERS, { amount: 0 }).points).toBe(0);
    expect(previewEarn(RULES, TIERS, { amount: Number.NaN }).points).toBe(0);
    expect(previewEarn([rule({ points_value: 100000 })], [], { amount: 1_000_000 }).points).toBe(1_000_000);
  });

  it('uses a 1× multiplier when no tiers exist', () => {
    expect(previewEarn([rule()], [], { amount: 80, lifetime: 9999 })).toMatchObject({ multiplier: 1, points: 80, tierName: null });
  });
});

describe('validation', () => {
  it('validates program settings', () => {
    expect(validateSettings({ program_name: 'Rewards', points_label: 'points', portal_redemption_enabled: true })).toEqual({});
    expect(validateSettings({ program_name: 'R', points_label: 'p', portal_redemption_enabled: true })).toHaveProperty('program_name');
    expect(validateSettings({ program_name: 'Rewards', points_label: 'p', portal_redemption_enabled: true })).toHaveProperty('points_label');
  });

  it('validates earn rules and builds a clean payload', () => {
    expect(validateEarnRule({ ...emptyEarnRuleForm(), name: 'Base' })).toEqual({});
    expect(validateEarnRule({ ...emptyEarnRuleForm(), name: 'a' })).toHaveProperty('name');
    expect(validateEarnRule({ ...emptyEarnRuleForm(), name: 'Base', points_value: '0' })).toHaveProperty('points_value');
    expect(validateEarnRule({ ...emptyEarnRuleForm(), name: 'Base', kind: 'flat_per_job', points_value: '2.5' })).toHaveProperty('points_value');
    expect(validateEarnRule({ ...emptyEarnRuleForm(), name: 'Base', min_invoice_amount: '-1' })).toHaveProperty('min_invoice_amount');
    expect(earnRuleToPayload({ ...emptyEarnRuleForm(), name: ' Base ', service_type: '  ', min_invoice_amount: '' })).toMatchObject({
      name: 'Base', service_type: null, min_invoice_amount: 0, points_value: 1,
    });
  });

  it('rejects duplicate tier names and thresholds but lets a tier keep its own', () => {
    const existing = [tier({ id: 'a', name: 'Silver', min_lifetime_points: 0 }), tier({ id: 'b', name: 'Gold', min_lifetime_points: 1000 })];
    const f = (o: Partial<TierForm>): TierForm => ({ name: 'Bronze', min_lifetime_points: '200', earn_multiplier: '1', perks: '', ...o });
    expect(validateTier(f({}), existing, null)).toEqual({});
    expect(validateTier(f({ name: ' gold ' }), existing, null)).toHaveProperty('name');
    expect(validateTier(f({ min_lifetime_points: '1000' }), existing, null)).toHaveProperty('min_lifetime_points');
    expect(validateTier(f({ name: 'Gold', min_lifetime_points: '1000' }), existing, 'b')).toEqual({});
    expect(validateTier(f({ earn_multiplier: '0.5' }), existing, null)).toHaveProperty('earn_multiplier');
    expect(validateTier(f({ min_lifetime_points: '12.5' }), existing, null)).toHaveProperty('min_lifetime_points');
  });

  it('validates rewards by type', () => {
    const f = (o: Partial<RewardForm>): RewardForm => ({ name: 'Credit', description: '', points_cost: '500', reward_type: 'credit', reward_value: '25', is_active: true, ...o });
    expect(validateReward(f({}))).toEqual({});
    expect(validateReward(f({ reward_value: '' }))).toHaveProperty('reward_value');
    expect(validateReward(f({ reward_type: 'discount_percent', reward_value: '150' }))).toHaveProperty('reward_value');
    expect(validateReward(f({ reward_type: 'free_service', reward_value: '' }))).toEqual({});
    expect(validateReward(f({ points_cost: '0' }))).toHaveProperty('points_cost');
    expect(rewardToPayload(f({ reward_type: 'free_service', reward_value: '99' })).reward_value).toBeNull();
    expect(rewardToPayload(f({})).reward_value).toBe(25);
  });

  it('validates manual adjustments against the balance', () => {
    expect(validateAdjust('50', 'Goodwill', 100)).toEqual({});
    expect(validateAdjust('-100', 'Correction', 100)).toEqual({});
    expect(validateAdjust('-150', 'Correction', 100)).toHaveProperty('points');
    expect(validateAdjust('0', 'x ok', 100)).toHaveProperty('points');
    expect(validateAdjust('1.5', 'x ok', 100)).toHaveProperty('points');
    expect(validateAdjust('200000', 'x ok', 0)).toHaveProperty('points');
    expect(validateAdjust('50', ' ', 100)).toHaveProperty('note');
  });
});

describe('lists', () => {
  const rows = [
    member({ customer_id: 'a', name: 'Zed', points_balance: 10, lifetime_points: 900, last_activity_at: '2026-10-01T00:00:00Z' }),
    member({ customer_id: 'b', name: 'Amy', points_balance: 500, lifetime_points: 100, email: null, tier_name: 'Gold', last_activity_at: null }),
    member({ customer_id: 'c', name: 'Bob', points_balance: 250, lifetime_points: 500, last_activity_at: '2026-10-25T00:00:00Z' }),
  ];

  it('filters by name, contact and tier', () => {
    expect(filterMembers(rows, ' amy ').map((m) => m.customer_id)).toEqual(['b']);
    expect(filterMembers(rows, 'gold').map((m) => m.customer_id)).toEqual(['b']);
    expect(filterMembers(rows, '').length).toBe(3);
  });

  it('sorts without mutating the input', () => {
    expect(sortMembers(rows, 'balance').map((m) => m.customer_id)).toEqual(['b', 'c', 'a']);
    expect(sortMembers(rows, 'lifetime').map((m) => m.customer_id)).toEqual(['a', 'c', 'b']);
    expect(sortMembers(rows, 'name').map((m) => m.customer_id)).toEqual(['b', 'c', 'a']);
    expect(sortMembers(rows, 'recent').map((m) => m.customer_id)).toEqual(['c', 'a', 'b']);
    expect(rows.map((m) => m.customer_id)).toEqual(['a', 'b', 'c']);
  });

  it('filters redemptions and counts pending ones', () => {
    const r = (id: string, status: RedemptionDetail['status']) => ({ id, status }) as RedemptionDetail;
    const list = [r('1', 'pending'), r('2', 'fulfilled'), r('3', 'pending'), r('4', 'cancelled')];
    expect(filterRedemptions(list, 'all').length).toBe(4);
    expect(filterRedemptions(list, 'pending').map((x) => x.id)).toEqual(['1', '3']);
    expect(countPending(list)).toBe(2);
  });

  it('checks affordability', () => {
    expect(canAfford(500, 500)).toBe(true);
    expect(canAfford(499, 500)).toBe(false);
    expect(pointsShort(499, 500)).toBe(1);
    expect(pointsShort(800, 500)).toBe(0);
  });
});

describe('formatting', () => {
  it('formats points, signs, money and multipliers', () => {
    expect(formatPoints(1234.4)).toBe('1,234');
    expect(formatSigned(25)).toBe('+25');
    expect(formatSigned(-5)).toBe('−5');
    expect(formatSigned(0)).toBe('0');
    expect(formatMoney(25)).toBe('$25');
    expect(formatMoney(19.5)).toBe('$19.50');
    expect(formatMultiplier(1.5)).toBe('1.5×');
    expect(formatMultiplier(2)).toBe('2×');
  });

  it('describes rewards and earn rules in plain language', () => {
    expect(formatRewardValue({ reward_type: 'credit', reward_value: 25 })).toBe('$25 credit');
    expect(formatRewardValue({ reward_type: 'discount_percent', reward_value: 10 })).toBe('10% off');
    expect(formatRewardValue({ reward_type: 'free_service', reward_value: null })).toBe('Free service');
    expect(describeEarnRule(rule())).toBe('1 pt per $1');
    expect(describeEarnRule(RULES[1])).toBe('50 pts per paid job on AC repair (invoices $100+)');
  });

  it('maps redemption status to a tone and formats relative time', () => {
    expect(redemptionTone('pending')).toBe('warning');
    expect(redemptionTone('fulfilled')).toBe('success');
    expect(redemptionTone('cancelled')).toBe('neutral');
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo('2026-10-26T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-10-26T09:00:00Z', now)).toBe('3 h ago');
  });
});

describe('recommended starting setup', () => {
  it('passes every validator so the one-click setup can never fail on bad data', () => {
    expect(validateSettings(DEFAULT_SETUP.settings)).toEqual({});
    for (const r of DEFAULT_SETUP.rules) expect(validateEarnRule(r)).toEqual({});
    for (const r of DEFAULT_SETUP.rewards) expect(validateReward(r)).toEqual({});
    const built: LoyaltyTier[] = [];
    DEFAULT_SETUP.tiers.forEach((f, i) => {
      expect(validateTier(f, built, null)).toEqual({});
      built.push(tier({ id: `d${i}`, name: f.name, min_lifetime_points: Number(f.min_lifetime_points), earn_multiplier: Number(f.earn_multiplier) }));
    });
    expect(built[0].min_lifetime_points).toBe(0);
  });

  it('stays inside the database caps', () => {
    expect(DEFAULT_SETUP.tiers.length).toBeLessThanOrEqual(8);
    expect(DEFAULT_SETUP.rules.length).toBeLessThanOrEqual(20);
    expect(DEFAULT_SETUP.rewards.length).toBeLessThanOrEqual(30);
  });
});
