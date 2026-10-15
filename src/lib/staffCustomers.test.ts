import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  computeHealth,
  filterAndSortRows,
  impersonationDenial,
  maskPhone,
  validateImpersonationRequest,
} from './staffCustomers';
import type { AccountSignals, ExplorerRow } from './staffCustomers';

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const base: AccountSignals = {
  id: 'a1',
  status: 'active',
  subscriptionStatus: 'active',
  dunningStage: 0,
  onboardingCompleted: true,
  minutesUsed: 300,
  minutesIncluded: 500,
  createdAt: daysAgo(200),
  lastSignInAt: daysAgo(1),
  lastCallAt: daysAgo(1),
  calls30d: 60,
  callsPrev30d: 50,
  bookings30d: 20,
  teamCount: 3,
  numbersCount: 2,
};
const signals = (over: Partial<AccountSignals> = {}): AccountSignals => ({ ...base, ...over });

describe('computeHealth', () => {
  it('scores a thriving account as healthy with factors summing to the score', () => {
    const h = computeHealth(signals(), NOW);
    expect(h.band).toBe('healthy');
    expect(h.score).toBe(100);
    expect(h.factors.reduce((s, f) => s + f.points, 0)).toBe(h.score);
    expect(h.factors.reduce((s, f) => s + f.max, 0)).toBe(100);
  });

  it('flags an account that went quiet and is past due', () => {
    const h = computeHealth(signals({ lastCallAt: daysAgo(40), calls30d: 0, callsPrev30d: 30, bookings30d: 0, subscriptionStatus: 'past_due', dunningStage: 2, minutesUsed: 10 }), NOW);
    expect(['at_risk', 'critical']).toContain(h.band);
    expect(h.score).toBeLessThan(50);
  });

  it('treats a brand-new account with no calls as new, not critical', () => {
    const h = computeHealth(signals({ createdAt: daysAgo(2), lastCallAt: null, calls30d: 0, callsPrev30d: 0, bookings30d: 0, minutesUsed: 0, onboardingCompleted: false, numbersCount: 0, teamCount: 0 }), NOW);
    expect(h.band).toBe('new');
  });

  it('marks canceled accounts as churned with score 0, and caps suspended accounts', () => {
    expect(computeHealth(signals({ status: 'canceled' }), NOW)).toMatchObject({ band: 'churned', score: 0 });
    const s = computeHealth(signals({ status: 'suspended' }), NOW);
    expect(s.band).toBe('critical');
    expect(s.score).toBe(20);
  });

  it('rewards growth, penalizes decline and explains it', () => {
    const down = computeHealth(signals({ calls30d: 20, callsPrev30d: 60 }), NOW);
    const trend = down.factors.find((f) => f.key === 'trend');
    expect(trend?.points).toBe(3);
    expect(trend?.detail).toContain('20 calls vs 60');
  });

  it('flags overage and under-use of the plan', () => {
    expect(computeHealth(signals({ minutesUsed: 900 }), NOW).factors.find((f) => f.key === 'usage')?.detail).toContain('over plan');
    expect(computeHealth(signals({ minutesUsed: 20 }), NOW).factors.find((f) => f.key === 'usage')?.detail).toContain('barely using');
  });
});

describe('impersonation rules', () => {
  it('requires a real reason and a sane ticket reference', () => {
    expect(validateImpersonationRequest({ reason: 'too short' })).toHaveLength(1);
    expect(validateImpersonationRequest({ reason: 'Customer cannot see their calls, ticket open' })).toHaveLength(0);
    expect(validateImpersonationRequest({ reason: 'Customer cannot see their calls', ticketRef: 'ZD-1042' })).toHaveLength(0);
    expect(validateImpersonationRequest({ reason: 'Customer cannot see their calls', ticketRef: 'bad ticket!' })).toHaveLength(1);
    expect(validateImpersonationRequest({ reason: 'x'.repeat(501) })).toHaveLength(1);
  });

  it('never allows self or staff targets', () => {
    expect(impersonationDenial({ id: 's1', isStaff: false }, 's1')).not.toBeNull();
    expect(impersonationDenial({ id: 'a1', isStaff: true }, 's1')).not.toBeNull();
    expect(impersonationDenial({ id: 'a1', isStaff: false }, 's1')).toBeNull();
  });
});

describe('filterAndSortRows', () => {
  const row = (id: string, name: string, score: number, band: ExplorerRow['health']['band'], calls = 0, created = daysAgo(10)): ExplorerRow => ({
    id,
    companyName: name,
    fullName: null,
    email: `${id}@x.com`,
    health: { score, band, factors: [] },
    calls30d: calls,
    createdAt: created,
    lastCallAt: null,
  });
  const rows = [row('a', 'Alpha HVAC', 90, 'healthy', 50), row('b', 'Bravo Air', 30, 'at_risk', 5), row('c', 'Cold Co', 10, 'critical', 0), row('d', 'Delta', 60, 'watch', 20)];

  it('sorts worst-first by default and filters by band', () => {
    expect(filterAndSortRows(rows, { search: '', band: 'all', sort: 'attention' }).map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(filterAndSortRows(rows, { search: '', band: 'at_risk', sort: 'attention' }).map((r) => r.id)).toEqual(['b']);
  });

  it('searches company, email and id case-insensitively', () => {
    expect(filterAndSortRows(rows, { search: 'BRAVO', band: 'all', sort: 'attention' }).map((r) => r.id)).toEqual(['b']);
    expect(filterAndSortRows(rows, { search: 'c@x', band: 'all', sort: 'attention' }).map((r) => r.id)).toEqual(['c']);
    expect(filterAndSortRows(rows, { search: 'zzz', band: 'all', sort: 'attention' })).toHaveLength(0);
  });

  it('sorts by calls', () => {
    expect(filterAndSortRows(rows, { search: '', band: 'all', sort: 'calls_desc' })[0].id).toBe('a');
  });
});

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('+15125550123')).toBe('•••• 0123');
    expect(maskPhone(null)).toBe('Unknown');
  });
});
