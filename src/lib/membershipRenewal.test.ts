import { describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, from: vi.fn() } }));

import {
  autoChargeCoverage,
  daysLeftLabel,
  fetchPublicRenewal,
  formatRate,
  formatUsd,
  groupPipeline,
  isValidRenewalToken,
  parseRenewalKpis,
  renewalLink,
  renewalRisk,
  respondToRenewal,
  type RenewalCycle,
} from './membershipRenewal';

const cycle = (over: Partial<RenewalCycle> = {}): RenewalCycle => ({
  id: 'c1', membership_id: 'm1', period_end: '2027-05-01T00:00:00Z', stage: 'upcoming_30', amount_cents: 29900, previous_amount_cents: 29900,
  payment_route: 'card_on_file', quote_token: 'q', quote_status: 'sent', charge_attempts: 0, last_charge_error: null, outcome: null,
  memberships: { customer_name: 'Dana', customer_email: null, customer_phone: null, auto_renew: true, status: 'active', card_brand: 'visa', card_last4: '4242' },
  membership_plans: { name: 'Annual', billing_interval: 'yearly' },
  ...over,
});

describe('parseRenewalKpis', () => {
  it('never throws on junk and clamps the rate', () => {
    expect(parseRenewalKpis(null).renewal_rate).toBeNull();
    expect(parseRenewalKpis('x').renewed).toBe(0);
    expect(parseRenewalKpis({ renewal_rate: 140, renewed: 3 })).toMatchObject({ renewal_rate: 100, renewed: 3 });
    expect(parseRenewalKpis({ renewal_rate: 'a' }).renewal_rate).toBeNull();
  });
});

describe('formatting', () => {
  it('formats rate and money', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(87)).toBe('87%');
    expect(formatRate(87.5)).toBe('87.5%');
    expect(formatUsd(29900)).toBe('$299');
    expect(formatUsd(29950)).toBe('$299.50');
  });
  it('computes auto-charge coverage', () => {
    expect(autoChargeCoverage({ active_members: 0, auto_charge_ready: 0 })).toBeNull();
    expect(autoChargeCoverage({ active_members: 8, auto_charge_ready: 6 })).toBe(75);
  });
  it('words the countdown', () => {
    const now = new Date('2027-03-01T00:00:00Z');
    expect(daysLeftLabel('2027-03-11T00:00:00Z', now)).toBe('in 10 days');
    expect(daysLeftLabel('2027-03-02T00:00:00Z', now)).toBe('tomorrow');
    expect(daysLeftLabel('2027-03-01T00:00:00Z', now)).toBe('today');
    expect(daysLeftLabel('2027-02-27T00:00:00Z', now)).toBe('2 days ago');
  });
  it('builds the customer link', () => {
    expect(renewalLink('https://vireek.com/', 'abc')).toBe('https://vireek.com/renew/abc');
  });
});

describe('groupPipeline', () => {
  it('buckets by stage, sorts by date, and ignores closed cycles', () => {
    const g = groupPipeline([
      cycle({ id: 'b', period_end: '2027-05-09T00:00:00Z' }),
      cycle({ id: 'a', period_end: '2027-05-01T00:00:00Z' }),
      cycle({ id: 'x', stage: 'renewed', outcome: 'renewed' }),
      cycle({ id: 'p', stage: 'past_due' }),
    ]);
    expect(g.upcoming_30.map((c) => c.id)).toEqual(['a', 'b']);
    expect(g.past_due.map((c) => c.id)).toEqual(['p']);
    expect(g.due).toHaveLength(0);
  });
});

describe('renewalRisk', () => {
  it('ranks the reasons a renewal might fail', () => {
    expect(renewalRisk(cycle({ quote_status: 'declined' })).level).toBe('risk');
    expect(renewalRisk(cycle({ stage: 'past_due', last_charge_error: 'Card declined' })).reason).toContain('Card declined');
    expect(renewalRisk(cycle({ last_charge_error: 'authentication_required', payment_route: 'pay_link' })).level).toBe('watch');
    expect(renewalRisk(cycle({ payment_route: 'pay_link' })).reason).toContain('No card');
    expect(renewalRisk(cycle())).toEqual({ level: 'ok', reason: 'Auto-charge visa •••• 4242' });
  });
});

describe('public renewal api', () => {
  it('rejects malformed tokens without calling the server', async () => {
    rpc.mockClear();
    expect(isValidRenewalToken('../etc')).toBe(false);
    expect(await fetchPublicRenewal('nope')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('cleans benefits and returns the renewal', async () => {
    const token = '123e4567-e89b-12d3-a456-426614174000';
    rpc.mockResolvedValueOnce({ data: { plan_name: 'Annual', benefits: ['Tune-up', '', 5] }, error: null });
    const r = await fetchPublicRenewal(token);
    expect(r?.benefits).toEqual(['Tune-up']);
    expect(rpc).toHaveBeenLastCalledWith('get_membership_renewal_for_token', { p_token: token });
  });
  it('returns null for an unknown token and surfaces a safe error otherwise', async () => {
    const token = '123e4567-e89b-12d3-a456-426614174000';
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await fetchPublicRenewal(token)).toBeNull();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'secret db detail' } });
    await expect(fetchPublicRenewal(token)).rejects.toThrow('Could not load this renewal.');
  });
  it('sends accept / decline', async () => {
    rpc.mockResolvedValueOnce({ data: 'declined', error: null });
    expect(await respondToRenewal('t', 'decline')).toBe('declined');
    expect(rpc).toHaveBeenLastCalledWith('respond_to_membership_renewal', { p_token: 't', p_action: 'decline' });
  });
});
