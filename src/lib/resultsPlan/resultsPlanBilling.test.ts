import { describe, expect, it } from 'vitest';
import { capAlertPct, compareWithFlat, effectiveCeilingCents, inGuarantee, monthlyTotalCents, priceNextJob, validateTerms, type PricingTerms } from '../../../supabase/functions/_shared/results-plan/pricing';
import { detectAnomalies, type WeekStat } from '../../../supabase/functions/_shared/results-plan/anomaly';
import { DISPUTE_WINDOW_DAYS, disputeWindowOpen, evaluateDispute, type ChargeEvidence } from '../../../supabase/functions/_shared/results-plan/dispute';
import { csvCell, statementCsv, summarize, type StatementLine } from '../../../supabase/functions/_shared/results-plan/statement';
import { SIM_DEFAULTS, simulate } from '../../../supabase/functions/_shared/results-plan/simulation';

// FAKE numbers for testing only — not prices.
const T: PricingTerms = { model: 'hybrid', baseFeeCents: 1000, perJobCents: 500, tierPriceCents: { install: 2000 }, monthlyFloorCents: 0, monthlyCapCents: null, neverExceedFlatCents: null, guaranteeDays: 0, guaranteeCapCents: null };
const START = '2026-01-01T00:00:00Z';
const AT = '2026-03-01T00:00:00Z';
const next = (t: PricingTerms, charged: number, jt: string | null = null, at = AT) => priceNextJob(t, { chargedCents: charged, startedAt: START }, jt, at);

describe('terms validation', () => {
  it('accepts a valid hybrid', () => expect(validateTerms(T)).toEqual([]));
  it('rejects zero per-job price', () => expect(validateTerms({ ...T, perJobCents: 0 })).toContain('perJobCents'));
  it('rejects negative / fractional', () => { expect(validateTerms({ ...T, baseFeeCents: -1 })).toContain('baseFeeCents'); expect(validateTerms({ ...T, perJobCents: 5.5 })).toContain('perJobCents'); });
  it('per_job must not have a base fee', () => expect(validateTerms({ ...T, model: 'per_job' })).toContain('per_job_has_base_fee'));
  it('hybrid must not have a floor', () => expect(validateTerms({ ...T, monthlyFloorCents: 5 })).toContain('hybrid_has_floor'));
  it('floor above cap rejected', () => expect(validateTerms({ ...T, model: 'per_job', baseFeeCents: 0, monthlyFloorCents: 900, monthlyCapCents: 800 })).toContain('floor_above_cap'));
  it('uppercase tier keys rejected', () => expect(validateTerms({ ...T, tierPriceCents: { Install: 1 } })).toContain('tier:Install'));
});

describe('priceNextJob', () => {
  it('uses default and tier prices', () => { expect(next(T, 0).amountCents).toBe(500); expect(next(T, 0, 'Install').amountCents).toBe(2000); expect(next(T, 0, ' install ').amountCents).toBe(2000); expect(next(T, 0, 'unknown').amountCents).toBe(500); });
  it('monthly cap binds exactly and then waives everything', () => {
    const t = { ...T, monthlyCapCents: 1200 };
    expect(next(t, 1000).amountCents).toBe(200);
    expect(next(t, 1000).boundBy).toBe('monthly_cap');
    expect(next(t, 1200).amountCents).toBe(0);
    expect(next(t, 1200).waivedCents).toBe(500);
    expect(next(t, 5000).amountCents).toBe(0);
  });
  it('never-more-than-flat accounts for the base fee', () => {
    const t = { ...T, neverExceedFlatCents: 2000 }; // base 1000 -> 1000 of room
    expect(next(t, 800).amountCents).toBe(200);
    expect(next(t, 800).boundBy).toBe('flat_plan_cap');
    expect(next(t, 1000).amountCents).toBe(0);
  });
  it('flat cap below base fee yields zero room, never negative', () => expect(next({ ...T, neverExceedFlatCents: 500 }, 0).amountCents).toBe(0));
  it('guarantee cap applies only inside the window', () => {
    const t = { ...T, guaranteeDays: 30, guaranteeCapCents: 700 };
    expect(next(t, 500, null, '2026-01-10T00:00:00Z').amountCents).toBe(200);
    expect(next(t, 500, null, '2026-01-10T00:00:00Z').boundBy).toBe('guarantee_cap');
    expect(next(t, 500, null, '2026-02-15T00:00:00Z').amountCents).toBe(500);
  });
  it('guarantee boundaries', () => { const t = { ...T, guaranteeDays: 30 }; expect(inGuarantee(t, { chargedCents: 0, startedAt: START }, '2026-01-30T23:59:59Z')).toBe(true); expect(inGuarantee(t, { chargedCents: 0, startedAt: START }, '2026-01-31T00:00:00Z')).toBe(false); expect(inGuarantee(t, { chargedCents: 0, startedAt: START }, '2025-12-31T00:00:00Z')).toBe(false); expect(inGuarantee({ ...T, guaranteeDays: 0 }, { chargedCents: 0, startedAt: START }, START)).toBe(false); });
  it('strictest of several caps wins', () => { const t = { ...T, monthlyCapCents: 3000, neverExceedFlatCents: 1300 }; expect(next(t, 0).amountCents).toBe(300); expect(next(t, 0).boundBy).toBe('flat_plan_cap'); });
  it('amounts are never negative or above list', () => { for (const c of [0, 1, 499, 500, 99999]) { const d = next({ ...T, monthlyCapCents: 600 }, c); expect(d.amountCents).toBeGreaterThanOrEqual(0); expect(d.amountCents <= d.listPriceCents).toBe(true); } });
});

describe('monthly totals, ceilings, alerts', () => {
  it('hybrid = base + jobs', () => expect(monthlyTotalCents(T, 2500)).toBe(3500));
  it('per_job floor tops up', () => { const t: PricingTerms = { ...T, model: 'per_job', baseFeeCents: 0, monthlyFloorCents: 900 }; expect(monthlyTotalCents(t, 300)).toBe(900); expect(monthlyTotalCents(t, 1200)).toBe(1200); });
  it('ceiling is the min of cap and flat room', () => { expect(effectiveCeilingCents(T)).toBe(null); expect(effectiveCeilingCents({ ...T, monthlyCapCents: 400, neverExceedFlatCents: 1300 })).toBe(300); });
  it('alert thresholds', () => { expect(capAlertPct(0, 1000)).toBe(0); expect(capAlertPct(499, 1000)).toBe(0); expect(capAlertPct(500, 1000)).toBe(50); expect(capAlertPct(800, 1000)).toBe(80); expect(capAlertPct(1000, 1000)).toBe(100); expect(capAlertPct(9, null)).toBe(0); });
  it('compareWithFlat uses real monthly history', () => {
    const r = compareWithFlat({ ...T, baseFeeCents: 0, model: 'per_job' }, 2000, [{ jobTypes: [null, null] }, { jobTypes: Array(10).fill(null) }], START);
    expect(r[0].cheaper).toBe('results'); expect(r[0].savingsCents).toBe(1000);
    expect(r[1].cheaper).toBe('flat'); expect(r[1].savingsCents).toBe(-3000);
  });
  it('compareWithFlat respects never-exceed-flat', () => {
    const r = compareWithFlat({ ...T, baseFeeCents: 0, model: 'per_job', neverExceedFlatCents: 2000 }, 2000, [{ jobTypes: Array(10).fill(null) }], START);
    expect(r[0].resultsCents).toBe(2000); expect(r[0].cheaper).toBe('equal');
  });
});

const wk = (o: Partial<WeekStat> = {}): WeekStat => ({ weekStart: '2026-01-01', due: 20, marked: 18, relabeledAfterCharge: 0, qualified: 10, ...o });
describe('anomalies', () => {
  const stable = Array.from({ length: 5 }, () => wk());
  it('no flags on stable data', () => expect(detectAnomalies([...stable, wk()])).toEqual([]));
  it('flags a marking drop', () => expect(detectAnomalies([...stable, wk({ marked: 5 })]).map((f) => f.code)).toContain('completion_marking_drop'));
  it('high severity on collapse', () => expect(detectAnomalies([...stable, wk({ marked: 1 })])[0].severity).toBe('high'));
  it('ignores tiny samples', () => expect(detectAnomalies([...stable, wk({ due: 3, marked: 0 })])).toEqual([]));
  it('needs a baseline', () => expect(detectAnomalies([wk(), wk({ marked: 0 })])).toEqual([]));
  it('flags relabeling after charge', () => { const f = detectAnomalies([...stable, wk({ relabeledAfterCharge: 4 })]); expect(f[0].code).toBe('relabel_after_charge'); expect(f[0].severity).toBe('high'); });
  it('flags our own over-counting spike', () => expect(detectAnomalies([...stable, wk({ qualified: 40 })]).map((f) => f.code)).toContain('qualification_spike'));
});

const ev = (o: Partial<ChargeEvidence> = {}): ChargeEvidence => ({ ruleVersion: 'rp-rules-v1', hasCall: true, callAt: '2026-03-01T10:00:00Z', hasBookingRecord: true, crmJobId: 'J1', hasCompletionEvent: true, hasConfirmationEvent: true, qualifiedReasons: [], billingLevel: 'completed', ...o });
describe('disputes', () => {
  it('window is 14 days inclusive', () => { expect(DISPUTE_WINDOW_DAYS).toBe(14); expect(disputeWindowOpen('2026-03-01T00:00:00Z', '2026-03-15T00:00:00Z')).toBe(true); expect(disputeWindowOpen('2026-03-01T00:00:00Z', '2026-03-15T00:00:01Z')).toBe(false); expect(disputeWindowOpen('2026-03-01T00:00:00Z', '2026-02-28T00:00:00Z')).toBe(false); expect(disputeWindowOpen('bad', '2026-03-02T00:00:00Z')).toBe(false); });
  it('supported charge goes to review', () => expect(evaluateDispute(ev()).decision).toBe('needs_review'));
  it('missing call auto-credits', () => expect(evaluateDispute(ev({ hasCall: false })).decision).toBe('auto_credit'));
  it('missing booking auto-credits', () => expect(evaluateDispute(ev({ hasBookingRecord: false })).decision).toBe('auto_credit'));
  it('failed rule auto-credits', () => expect(evaluateDispute(ev({ qualifiedReasons: ['duplicate'] })).decision).toBe('auto_credit'));
  it('completed level without completion auto-credits', () => expect(evaluateDispute(ev({ hasCompletionEvent: false })).decision).toBe('auto_credit'));
  it('confirmed level without confirmation auto-credits', () => expect(evaluateDispute(ev({ billingLevel: 'confirmed', hasConfirmationEvent: false })).decision).toBe('auto_credit'));
  it('booked level needs no completion', () => expect(evaluateDispute(ev({ billingLevel: 'booked', hasCompletionEvent: false, hasConfirmationEvent: false })).decision).toBe('needs_review'));
});

const line = (o: Partial<StatementLine> = {}): StatementLine => ({ chargeId: 'c1', jobId: 'j1', verifiedAt: '2026-03-02T00:00:00Z', customerLabel: 'Ann', jobType: null, ruleVersion: 'rp-rules-v1', amountCents: 500, listPriceCents: 500, status: 'posted', estimatedRevenueCents: 20000, ...o });
describe('statement', () => {
  it('summarizes billed, credited, waived', () => {
    const s = summarize([line(), line({ chargeId: 'c2', amountCents: 200 }), line({ chargeId: 'c3', status: 'credited' })], 1000, 15000, 2500);
    expect(s.verifiedJobs).toBe(2); expect(s.billedCents).toBe(700); expect(s.creditedCents).toBe(500); expect(s.waivedByCapsCents).toBe(300); expect(s.netCents).toBe(1700); expect(s.effectiveCostPerJobCents).toBe(850);
  });
  it('estimated revenue uses avg ticket only when invoice is unknown and says so', () => {
    const s = summarize([line({ estimatedRevenueCents: null }), line({ chargeId: 'c2' })], 0, 10000, null);
    expect(s.estimatedRevenueCents).toBe(30000); expect(s.revenueFormula).toContain('average ticket');
  });
  it('no divide-by-zero with no jobs', () => { const s = summarize([], 0, null, null); expect(s.effectiveCostPerJobCents).toBe(null); expect(s.valueMultiple).toBe(null); });
  it('csv neutralizes formula injection and quotes', () => { expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`); expect(csvCell('+1')).toBe("'+1"); expect(csvCell('a,b')).toBe('"a,b"'); expect(csvCell(null)).toBe(''); expect(csvCell(5)).toBe('5'); });
  it('csv has header and CRLF rows', () => { const c = statementCsv([line()], 'USD'); expect(c.split('\r\n')[0]).toContain('charged_USD'); expect(c.split('\r\n').length).toBe(3); expect(c).toContain('5.00'); });
});

describe('12-month simulation (fake terms)', () => {
  const cfg = { ...SIM_DEFAULTS, accounts: 120 };
  it('is deterministic for a seed', () => expect(simulate(T, 'install', cfg).totalRevenueCents).toBe(simulate(T, 'install', cfg).totalRevenueCents));
  it('different seeds differ', () => expect(simulate(T, 'install', { ...cfg, seed: 7 }).totalRevenueCents === simulate(T, 'install', cfg).totalRevenueCents).toBe(false));
  it('percentiles are ordered', () => { const r = simulate(T, 'install', cfg); expect(r.p10 <= r.p50).toBe(true); expect(r.p50 <= r.p90).toBe(true); expect(r.accountMargins.length).toBe(120); });
  it('a hard cap lowers revenue', () => expect(simulate({ ...T, monthlyCapCents: 800 }, 'install', cfg).totalRevenueCents < simulate(T, 'install', cfg).totalRevenueCents).toBe(true));
  it('gaming accounts reduce margin', () => expect(simulate(T, 'install', { ...cfg, gamingShare: 0.5 }).totalMarginPct < simulate(T, 'install', { ...cfg, gamingShare: 0 }).totalMarginPct).toBe(true));
});
