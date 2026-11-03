import { describe, expect, it } from 'vitest';
import {
  DAY_MS, HOUR_MS, DEFAULT_CLAIM_RATE, campaignHoldsToRelease, campaignKeepFraction, checkEligibility, demandMultiplier,
  hashToken, isHighValueRequest, learnResponseCurve, planValueHolds, poissonTail, rankCandidates, remainingLambda, simulateBackfill,
  simulateHolds, sizeCampaignHolds, valueHoldsToRelease, newClaimToken, DEFAULT_CURVE_SHARES,
  type ActiveHold, type Candidate, type FreeSlot,
} from './engine';

const NOW = Date.parse('2026-11-02T08:00:00Z');
const slot = (tech: string, hoursFromNow: number, trade = 'replacement', score = 1): FreeSlot => ({
  technicianId: tech, start: NOW + hoursFromNow * HOUR_MS, end: NOW + (hoursFromNow + 1) * HOUR_MS,
  dayKey: new Date(NOW + hoursFromNow * HOUR_MS).toISOString().slice(0, 10), score, trade,
});
const cand = (o: Partial<Candidate> = {}): Candidate => ({
  type: 'waitlist', ref: 'r', customerId: null, name: 'N', phoneNorm: '+15550001', estValueCents: 10000, distanceKm: null, ageDays: 0,
  marketingOptIn: true, prefsAllowSms: true, prefsAllowMarketing: true, prefsAllowReminders: true, sentLast24h: 0, sentLast7d: 0, ...o,
});
const caps = { max24h: 1, max7d: 2 };

describe('poisson / lambda', () => {
  it('tail probabilities', () => {
    expect(poissonTail(1, 0)).toBe(1);
    expect(poissonTail(0, 1)).toBe(0);
    expect(poissonTail(1, 1)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(poissonTail(2, 3)).toBeCloseTo(1 - Math.exp(-2) * (1 + 2 + 2), 6);
  });
  it('remaining lambda decays to 0 at the slot', () => {
    expect(remainingLambda(2, 0)).toBe(0);
    expect(remainingLambda(2, -5)).toBe(0);
    expect(remainingLambda(2, 36 * HOUR_MS)).toBeCloseTo(1, 6);
    expect(remainingLambda(2, 10 * DAY_MS)).toBe(2);
  });
});

describe('isHighValueRequest', () => {
  const rules = [{ trade: 'hvac_replacement', hold_share_pct: 20 }];
  it('emergency/vip/agreement always qualify', () => {
    expect(isHighValueRequest({ serviceType: null, isEmergency: true, isVip: false, hasAgreement: false }, [])).toBe(true);
    expect(isHighValueRequest({ serviceType: null, isEmergency: false, isVip: true, hasAgreement: false }, [])).toBe(true);
    expect(isHighValueRequest({ serviceType: null, isEmergency: false, isVip: false, hasAgreement: true }, [])).toBe(true);
  });
  it('matches trade rules with underscores or spaces, not unrelated work', () => {
    expect(isHighValueRequest({ serviceType: 'HVAC Replacement quote', isEmergency: false, isVip: false, hasAgreement: false }, rules)).toBe(true);
    expect(isHighValueRequest({ serviceType: 'Drain cleaning', isEmergency: false, isVip: false, hasAgreement: false }, rules)).toBe(false);
    expect(isHighValueRequest({ serviceType: 'x', isEmergency: false, isVip: false, hasAgreement: false }, [{ trade: '  ', hold_share_pct: 5 }])).toBe(false);
  });
});

describe('planValueHolds', () => {
  const free = [slot('A', 24), slot('B', 24), slot('C', 24), slot('D', 24), slot('A', 26), slot('B', 26)];
  const base = { freeSlots: free, rules: [], globalSharePct: 25, demandPerDay: { replacement: 3 }, now: NOW, minReleaseProbability: 0.25, existing: [] as ActiveHold[] };

  it('holds ~share of free units, one slot per technician window, never overlapping', () => {
    const plan = planValueHolds(base);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(2); // 4 units/day * 25% rounded
    const keys = plan.map((p) => `${p.technicianId}@${p.start}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('is idempotent: planning again with the result as existing places nothing new', () => {
    const plan = planValueHolds(base);
    const existing: ActiveHold[] = plan.map((p, i) => ({ id: `h${i}`, kind: 'value', technicianId: p.technicianId, trade: p.trade, start: p.start, end: p.end, dayKey: p.dayKey, reservationId: null }));
    expect(planValueHolds({ ...base, existing })).toEqual([]);
  });
  it('never holds the last public slot of a day', () => {
    const plan = planValueHolds({ ...base, freeSlots: [slot('A', 24)], globalSharePct: 50, rules: [{ trade: 'replacement', hold_share_pct: 50 }] });
    expect(plan).toEqual([]);
  });
  it('does not place holds that would be released immediately (no demand)', () => {
    expect(planValueHolds({ ...base, demandPerDay: { replacement: 0 } })).toEqual([]);
  });
  it('per-trade rule overrides the global share', () => {
    const plan = planValueHolds({ ...base, rules: [{ trade: 'replacement', hold_share_pct: 50 }], globalSharePct: 0 });
    expect(plan.length).toBeGreaterThanOrEqual(2);
  });
  it('ignores slots in the past', () => {
    expect(planValueHolds({ ...base, freeSlots: [slot('A', -3), slot('B', -2)] })).toEqual([]);
  });
});

describe('valueHoldsToRelease', () => {
  const mk = (id: string, hours: number): ActiveHold => ({ id, kind: 'value', technicianId: id, trade: 'replacement', start: NOW + hours * HOUR_MS, end: NOW + (hours + 1) * HOUR_MS, dayKey: 'd', reservationId: null });
  it('releases past slots', () => {
    expect(valueHoldsToRelease([mk('a', -1)], { replacement: 5 }, NOW, 0.25)).toEqual([{ id: 'a', reason: 'slot_passed' }]);
  });
  it('keeps holds while demand is likely, releases the extra ones first as demand falls', () => {
    const holds = [mk('a', 10), mk('b', 11), mk('c', 12)];
    const hi = valueHoldsToRelease(holds, { replacement: 6 }, NOW, 0.25);
    const lo = valueHoldsToRelease(holds, { replacement: 0.3 }, NOW, 0.25);
    expect(hi.length).toBeLessThan(lo.length);
    expect(lo.length).toBeGreaterThanOrEqual(2);
    expect(lo.map((d) => d.id)).toContain('c');
  });
  it('releases everything when no demand is expected', () => {
    expect(valueHoldsToRelease([mk('a', 10), mk('b', 11)], { replacement: 0 }, NOW, 0.25)).toHaveLength(2);
  });
  it('ignores campaign holds', () => {
    expect(valueHoldsToRelease([{ ...mk('a', -1), kind: 'campaign' }], {}, NOW, 0.25)).toEqual([]);
  });
});

describe('demandMultiplier', () => {
  it('weather raises, regional factor scales, both bounded', () => {
    expect(demandMultiplier({ weatherSurge: false, regionalSurgeFactor: null })).toBe(1);
    expect(demandMultiplier({ weatherSurge: true, regionalSurgeFactor: null })).toBe(1.5);
    expect(demandMultiplier({ weatherSurge: true, regionalSurgeFactor: 100 })).toBe(3);
    expect(demandMultiplier({ weatherSurge: false, regionalSurgeFactor: -4 })).toBe(0.5);
    expect(demandMultiplier({ weatherSurge: false, regionalSurgeFactor: Number.NaN })).toBe(1);
  });
});

describe('campaign reservations', () => {
  it('default curve sums to 1 and is used with <2 usable campaigns', () => {
    expect(DEFAULT_CURVE_SHARES.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const c = learnResponseCurve([{ audience: 1000, perDay: [5, 3] }], 0.012);
    expect(c.source).toBe('default');
    expect(c.responseRate).toBe(0.012);
  });
  it('learns a curve and rate from history', () => {
    const c = learnResponseCurve([{ audience: 1000, perDay: [20, 10, 10] }, { audience: 1000, perDay: [10, 5, 5] }], 0.01);
    expect(c.source).toBe('history');
    expect(c.responseRate).toBeCloseTo(60 / 2000, 6);
    expect(c.shares[0]).toBeCloseTo(0.5, 6);
    expect(c.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
  it('sizes holds from the curve and caps by share of free units', () => {
    const curve = { shares: [0.5, 0.3, 0.2], responseRate: 0.02, source: 'history' as const };
    const r = sizeCampaignHolds({ audience: 2000, curve, bookingConversion: 0.5, maxSharePct: 30, freeUnitsByDay: [{ dayKey: 'a', units: 10, alreadyHeld: 0 }, { dayKey: 'b', units: 10, alreadyHeld: 2 }, { dayKey: 'c', units: 2, alreadyHeld: 0 }] });
    expect(r.expectedResponses).toBe(40);
    expect(r.perDay[0].holds).toBe(3); // ceil(10) capped to floor(30% of 10)=3
    expect(r.perDay[1].holds).toBe(1); // cap 3-2=1
    expect(r.perDay[2].holds).toBe(0); // floor(0.6)=0
  });
  it('never returns negative holds', () => {
    const r = sizeCampaignHolds({ audience: 0, curve: { shares: [1], responseRate: 0, source: 'default' }, bookingConversion: 0.4, maxSharePct: 30, freeUnitsByDay: [{ dayKey: 'a', units: 5, alreadyHeld: 4 }] });
    expect(r.perDay[0].holds).toBe(0);
  });
  const prog = { expectedResponses: 60, shares: [0.5, 0.3, 0.2], windowStart: NOW, windowEnd: NOW + 3 * DAY_MS, observed: 0, graceMs: 6 * HOUR_MS };
  it('keeps everything on day 0, releases on shortfall, keeps when on track, releases all after the window', () => {
    expect(campaignKeepFraction(prog, NOW + 5 * HOUR_MS).keep).toBe(1);
    expect(campaignKeepFraction({ ...prog, observed: 0 }, NOW + 1.5 * DAY_MS)).toEqual({ keep: 0, reason: 'campaign_shortfall' });
    expect(campaignKeepFraction({ ...prog, observed: 28 }, NOW + 1.5 * DAY_MS).keep).toBe(1);
    expect(campaignKeepFraction({ ...prog, observed: 99 }, NOW + 3 * DAY_MS + 7 * HOUR_MS)).toEqual({ keep: 0, reason: 'campaign_window_over' });
  });
  it('does not judge a shortfall on a tiny expected volume', () => {
    expect(campaignKeepFraction({ ...prog, expectedResponses: 2 }, NOW + 2 * DAY_MS).keep).toBe(1);
  });
  it('releases the LATEST campaign holds first and leaves value holds alone', () => {
    const h = (id: string, hrs: number, kind: 'value' | 'campaign' = 'campaign'): ActiveHold => ({ id, kind, technicianId: id, trade: null, start: NOW + hrs * HOUR_MS, end: NOW + (hrs + 1) * HOUR_MS, dayKey: 'd', reservationId: 'r' });
    const out = campaignHoldsToRelease([h('a', 5), h('b', 30), h('c', 50), h('v', 60, 'value'), h('old', -2)], 0.3, 'campaign_shortfall', NOW);
    expect(out.find((d) => d.id === 'old')?.reason).toBe('slot_passed');
    expect(out.filter((d) => d.reason === 'campaign_shortfall').map((d) => d.id).sort()).toEqual(['b', 'c']);
    expect(out.find((d) => d.id === 'v')).toBeUndefined();
  });
});

describe('ranking', () => {
  it('waitlist outranks estimate outranks agreement outranks missed call outranks same-area at equal value', () => {
    const ranked = rankCandidates([
      cand({ type: 'same_area', ref: 'e', phoneNorm: '+1005' }), cand({ type: 'missed_call', ref: 'd', phoneNorm: '+1004' }),
      cand({ type: 'agreement_due', ref: 'c', phoneNorm: '+1003' }), cand({ type: 'open_estimate', ref: 'b', phoneNorm: '+1002' }),
      cand({ type: 'waitlist', ref: 'a', phoneNorm: '+1001' }),
    ]);
    expect(ranked.map((r) => r.ref)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
  it('dedupes by phone keeping the best, drops candidates without a phone', () => {
    const r = rankCandidates([cand({ type: 'same_area', ref: 'x' }), cand({ type: 'waitlist', ref: 'y' }), cand({ ref: 'z', phoneNorm: null })]);
    expect(r).toHaveLength(1);
    expect(r[0].ref).toBe('y');
  });
  it('higher value, closer, fresher rank higher within a type', () => {
    const r = rankCandidates([
      cand({ type: 'open_estimate', ref: 'lo', phoneNorm: '+1', estValueCents: 10_000, ageDays: 40, distanceKm: 20 }),
      cand({ type: 'open_estimate', ref: 'hi', phoneNorm: '+2', estValueCents: 900_000, ageDays: 2, distanceKm: 3 }),
    ]);
    expect(r[0].ref).toBe('hi');
  });
});

describe('consent gating', () => {
  it('no phone / sms opt-out block everything', () => {
    expect(checkEligibility(cand({ phoneNorm: null }), caps)).toEqual({ ok: false, reason: 'no_phone' });
    expect(checkEligibility(cand({ prefsAllowSms: false }), caps)).toEqual({ ok: false, reason: 'sms_opted_out' });
  });
  it('waitlist and agreement are service purpose, no marketing opt-in required', () => {
    expect(checkEligibility(cand({ type: 'waitlist', marketingOptIn: false }), caps)).toEqual({ ok: true, purpose: 'service' });
    expect(checkEligibility(cand({ type: 'agreement_due', marketingOptIn: false }), caps)).toEqual({ ok: true, purpose: 'service' });
    expect(checkEligibility(cand({ type: 'agreement_due', prefsAllowReminders: false }), caps)).toEqual({ ok: false, reason: 'category_opted_out' });
  });
  it.each(['open_estimate', 'same_area', 'missed_call'] as const)('%s needs explicit marketing opt-in and category consent', (type) => {
    expect(checkEligibility(cand({ type, marketingOptIn: false }), caps)).toEqual({ ok: false, reason: 'marketing_not_consented' });
    expect(checkEligibility(cand({ type, prefsAllowMarketing: false }), caps)).toEqual({ ok: false, reason: 'category_opted_out' });
    expect(checkEligibility(cand({ type }), caps)).toEqual({ ok: true, purpose: 'marketing' });
  });
  it('frequency caps apply to every type, 24h first', () => {
    expect(checkEligibility(cand({ sentLast24h: 1 }), caps)).toEqual({ ok: false, reason: 'cap_24h' });
    expect(checkEligibility(cand({ sentLast7d: 2 }), caps)).toEqual({ ok: false, reason: 'cap_7d' });
    expect(checkEligibility(cand({ sentLast7d: 1 }), caps)).toEqual({ ok: true, purpose: 'service' });
  });
});

describe('tokens', () => {
  it('hash is stable hex, tokens are unique and URL-safe', async () => {
    expect(await hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const a = newClaimToken(), b = newClaimToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe('simulation (labelled simulated, seeded, deterministic)', () => {
  const pool = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => cand({ type: i % 2 ? 'open_estimate' : 'waitlist', ref: `c${i}`, phoneNorm: `+1555${i}` }));
  const opts = { caps, ttlMinutes: 20, batchSize: 3, claimRate: DEFAULT_CLAIM_RATE, seed: 7 };
  it('is reproducible and labelled', () => {
    const gaps = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, valueCents: 20000, leadMinutes: 180, pool: pool(8) }));
    const a = simulateBackfill(gaps, opts), b = simulateBackfill(gaps, opts);
    expect(a).toEqual(b);
    expect(a.simulated).toBe(true);
    expect(a.assumptions).toContain('SIMULATED');
    expect(a.filled).toBeGreaterThan(0);
    expect(a.filled).toBeLessThanOrEqual(30);
  });
  it('respects frequency caps across gaps and counts blocked reasons', () => {
    const same = [cand({ phoneNorm: '+1999' })];
    const gaps = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, valueCents: 1, leadMinutes: 180, pool: same }));
    const r = simulateBackfill(gaps, { ...opts, claimRate: { ...DEFAULT_CLAIM_RATE, waitlist: 0 } });
    expect(r.blocked.cap_24h).toBe(4); // offered once, blocked 4 times
    expect(r.filled).toBe(0);
  });
  it('no lead time means no offers', () => {
    const r = simulateBackfill([{ id: 'g', valueCents: 1, leadMinutes: 10, pool: pool(5) }], { ...opts, claimRate: { ...DEFAULT_CLAIM_RATE, waitlist: 1, open_estimate: 1 } });
    expect(r.filled).toBe(0);
  });
  it('hold replay: used never exceeds held or real arrivals', () => {
    const r = simulateHolds([{ dayKey: 'm', trade: 'replacement', freeUnits: 10, highValueArrivals: 1, avgValueCents: 800000 }, { dayKey: 't', trade: 'replacement', freeUnits: 10, highValueArrivals: 5, avgValueCents: 800000 }], () => 20);
    expect(r).toMatchObject({ simulated: true, held: 4, used: 3, releasedUnused: 1, protectedCents: 2_400_000 });
  });
});

import { selectBlockingHolds } from './engine';
describe('selectBlockingHolds', () => {
  const holds = [
    { id: 'v', kind: 'value' as const, technicianId: 'A', start: 1, end: 2, shadow: false },
    { id: 'c', kind: 'campaign' as const, technicianId: 'B', start: 1, end: 2, shadow: false },
    { id: 's', kind: 'value' as const, technicianId: 'C', start: 1, end: 2, shadow: true },
  ];
  it('regular request: both live holds block, shadow never blocks', () => {
    expect(selectBlockingHolds(holds, { highValue: false, campaignAttributed: false }).map((h) => h.id)).toEqual(['v', 'c']);
  });
  it('high-value request may use value holds only', () => {
    expect(selectBlockingHolds(holds, { highValue: true, campaignAttributed: false }).map((h) => h.id)).toEqual(['c']);
  });
  it('campaign lead may use campaign holds only', () => {
    expect(selectBlockingHolds(holds, { highValue: false, campaignAttributed: true }).map((h) => h.id)).toEqual(['v']);
  });
  it('high-value campaign lead blocks nothing', () => {
    expect(selectBlockingHolds(holds, { highValue: true, campaignAttributed: true })).toEqual([]);
  });
});
