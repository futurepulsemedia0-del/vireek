import { describe, it, expect } from 'vitest';
import { failureProbability } from '@/lib/lifetimeServicePlan';
import {
  ADVISOR_HORIZON_YEARS,
  adviseRepairOrReplace,
  buildFinancingOptions,
  calibrateMultiplier,
  energySavingFraction,
  isRepairVisit,
  loanBalance,
  usd,
  validateAdvisorInput,
  type AdvisorInput,
  type RebateSummary,
} from './repairReplaceAdvisor';

const NOW = Date.parse('2026-10-21T00:00:00Z');
const yearsAgo = (y: number) => new Date(NOW - y * 365.25 * 86_400_000).toISOString().slice(0, 10);

const REBATES: RebateSummary = {
  atInstallCents: 60_000,
  afterInstallCents: 80_000,
  taxFilingCents: 60_000,
  expectedCents: 200_000,
  conservativeCents: 80_000,
  bestCaseCents: 260_000,
  programs: [],
  deadlines: [],
  warnings: [],
  actions: [],
};

function input(over: Partial<AdvisorInput> = {}): AdvisorInput {
  return {
    now: NOW,
    unit: {
      id: 'eq-1',
      label: 'Carrier 3-ton AC',
      equipmentType: 'Central air conditioner',
      make: 'Carrier',
      model: '24ACC',
      installDate: yearsAgo(14),
      expectedLifespanYears: 15,
      warrantyExpiresAt: null,
      lastServiceDate: yearsAgo(0.5),
      serviceIntervalMonths: 12,
      efficiency: { seer2: 10 },
    },
    history: [
      { date: yearsAgo(0.4), costCents: 68_000, source: 'job' },
      { date: yearsAgo(1.2), costCents: 54_000, source: 'job' },
    ],
    forecast: { probability: 0.3, horizonDays: 90, confidence: 'moderate', calibrated: false, band: 'high', topModeLabel: 'Compressor', safetyCriticalModes: [], issuedAt: null },
    repair: { quoteCents: 185_000 },
    replacement: { label: '16 SEER2 AC', installedCostCents: 820_000, efficiency: { seer2: 16 } },
    rebates: REBATES,
    customer: { creditBand: 'good' },
    ...over,
  };
}

const young = (over: Partial<AdvisorInput> = {}) =>
  input({
    unit: { ...input().unit, installDate: yearsAgo(4), efficiency: { seer2: 14 } },
    history: [],
    forecast: null,
    repair: { quoteCents: 45_000 },
    ...over,
  });

describe('validateAdvisorInput', () => {
  it('accepts a complete input', () => {
    expect(validateAdvisorInput(input())).toEqual([]);
  });
  it('requires a positive replacement price', () => {
    expect(validateAdvisorInput(input({ replacement: { label: 'x', installedCostCents: 0 } }))).toHaveLength(1);
    expect(() => adviseRepairOrReplace(input({ replacement: { label: 'x', installedCostCents: -5 } }))).toThrow(/installed price/);
  });
  it('rejects a negative quote and a bad install date, but allows a missing quote', () => {
    expect(validateAdvisorInput(input({ repair: { quoteCents: -1 } }))).toHaveLength(1);
    expect(validateAdvisorInput(input({ repair: { quoteCents: null } }))).toEqual([]);
    expect(validateAdvisorInput(input({ unit: { ...input().unit, installDate: 'not-a-date' } }))).toHaveLength(1);
  });
});

describe('calibrateMultiplier', () => {
  it('reproduces the target probability inside the curve range', () => {
    const fit = calibrateMultiplier(12, 15, 4, 0.1, 0.25);
    expect(fit.saturated).toBeNull();
    expect(failureProbability(12, 15, 4, fit.multiplier, 0.25)).toBeCloseTo(0.1, 2);
  });
  it('reports saturation when the forecast is riskier or calmer than any normal curve', () => {
    expect(calibrateMultiplier(10, 15, 4, 0.9, 0.25)).toEqual({ multiplier: 4, saturated: 'high' });
    expect(calibrateMultiplier(1, 15, 4, 0.0011, 1).saturated).toBe('low');
  });
  it('is monotonic: a riskier forecast never lowers the multiplier', () => {
    const a = calibrateMultiplier(11, 15, 4, 0.05, 0.25).multiplier;
    const b = calibrateMultiplier(11, 15, 4, 0.12, 0.25).multiplier;
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('energySavingFraction', () => {
  it('uses old vs. new ratings', () => {
    expect(energySavingFraction({ seer2: 10 }, { seer2: 16 }, null)?.fraction).toBeCloseTo(0.375, 3);
  });
  it('estimates the old unit from its install era and says so', () => {
    const f = energySavingFraction(null, { seer2: 18 }, Date.parse('2001-06-01'));
    expect(f?.assumedOld).toBe(true);
    expect(f?.fraction).toBeCloseTo(0.5, 3);
  });
  it('returns null when nothing is known and never reports negative savings', () => {
    expect(energySavingFraction(null, null, null)).toBeNull();
    expect(energySavingFraction({ afue: 95 }, { afue: 80 }, null)?.fraction).toBe(0);
  });
  it('caps the saving at 60%', () => {
    expect(energySavingFraction({ seer2: 5 }, { seer2: 30 }, null)?.fraction).toBe(0.6);
  });
});

describe('loanBalance', () => {
  it('amortises to zero at the end of the term', () => {
    const pay = 100_000 / 36;
    expect(loanBalance(100_000, 0, pay, 36)).toBeCloseTo(0, 5);
    expect(loanBalance(100_000, 0, pay, 0)).toBe(100_000);
  });
  it('pays down an interest-bearing loan to ~0', () => {
    const r = 0.12 / 12;
    const pay = (500_000 * r) / (1 - Math.pow(1 + r, -60));
    expect(loanBalance(500_000, 0.12, pay, 60)).toBeLessThan(1);
    expect(loanBalance(500_000, 0.12, pay, 30)).toBeGreaterThan(200_000);
  });
});

describe('buildFinancingOptions', () => {
  const base = {
    installedCents: 800_000,
    atInstallRebateCents: 50_000,
    afterInstallRebateCents: 100_000,
    annualSavingCents: 30_000,
    creditBand: 'good' as const,
    cashAvailableCents: null,
    monthlyBudgetCents: null,
    model: { life: 15, shape: 4, energyShare: 0.45, maxLoanMonths: 120, leasable: true },
    lender: null,
  };
  it('always offers cash, financed on the price after instant discounts', () => {
    const opts = buildFinancingOptions(base);
    expect(opts[0].kind).toBe('cash');
    expect(opts[0].totalPaidCents).toBe(750_000);
    expect(opts.find((o) => o.id === 'loan-60')?.financedCents).toBe(750_000);
  });
  it('marks cash infeasible when the customer cannot cover it', () => {
    expect(buildFinancingOptions({ ...base, cashAvailableCents: 100_000 })[0].feasible).toBe(false);
  });
  it('declines loans below the lender minimum', () => {
    const opts = buildFinancingOptions({ ...base, installedCents: 15_000, atInstallRebateCents: 0 });
    expect(opts.filter((o) => o.kind !== 'cash').every((o) => !o.feasible)).toBe(true);
    expect(opts.find((o) => o.recommended)?.kind).toBe('cash');
  });
  it('does not offer loans at a poor credit band but still offers lease-to-own', () => {
    const opts = buildFinancingOptions({ ...base, creditBand: 'poor' });
    expect(opts.filter((o) => o.kind === 'loan').every((o) => !o.feasible)).toBe(true);
    expect(opts.filter((o) => o.kind === 'lease_to_own').every((o) => o.feasible)).toBe(true);
  });
  it('caps loan terms by equipment type', () => {
    const opts = buildFinancingOptions({ ...base, model: { ...base.model, maxLoanMonths: 60 } });
    expect(opts.some((o) => o.id === 'loan-84')).toBe(false);
    expect(opts.some((o) => o.id === 'loan-60')).toBe(true);
  });
  it('recommends the shortest loan that fits the monthly budget', () => {
    const opts = buildFinancingOptions({ ...base, monthlyBudgetCents: 16_000 });
    const rec = opts.find((o) => o.recommended);
    expect(rec?.kind).toBe('loan');
    expect(rec?.fitsBudget).toBe(true);
    const shorter = opts.filter((o) => o.kind === 'loan' && o.aprSource === 'planning_estimate' && (o.termMonths ?? 0) < (rec?.termMonths ?? 0));
    expect(shorter.every((o) => o.fitsBudget === false)).toBe(true);
  });
  it('prefers a real lender quote and labels its source', () => {
    const opts = buildFinancingOptions({ ...base, lender: { aprBps: 999, termMonths: 72, label: 'Wisetack' } });
    const rec = opts.find((o) => o.recommended);
    expect(rec?.id).toBe('lender');
    expect(rec?.aprSource).toBe('lender_quote');
    expect(rec?.aprBps).toBe(999);
  });
  it('reports interest, the balance left at year five and the energy-adjusted payment', () => {
    const loan = buildFinancingOptions(base).find((o) => o.id === 'loan-120') as NonNullable<ReturnType<typeof buildFinancingOptions>[number]>;
    expect(loan.balanceAtHorizonCents).toBeGreaterThan(0);
    expect(loan.interestCents).toBeGreaterThan(0);
    expect(loan.interestWithinHorizonCents).toBeLessThanOrEqual(loan.interestCents);
    expect(loan.monthlyNetOfEnergySavingsCents).toBe((loan.monthlyCents as number) - 2500);
    expect(loan.monthlyAfterRebatePaydownCents as number).toBeLessThan(loan.monthlyCents as number);
  });
  it('handles a 0% lender offer', () => {
    const loan = buildFinancingOptions({ ...base, lender: { aprBps: 0, termMonths: 50 } }).find((o) => o.id === 'lender');
    expect(loan?.monthlyCents).toBe(15_000);
    expect(loan?.interestCents).toBe(0);
  });
});

describe('adviseRepairOrReplace: verdicts', () => {
  it('recommends replacing an old unit with a big repair and recurring failures', () => {
    const r = adviseRepairOrReplace(input());
    expect(r.verdict).toBe('replace');
    expect(r.unit.recentRepairs).toBe(2);
    expect(r.pvAdvantageOfReplacingCents).toBeGreaterThan(r.tossUpThresholdCents);
  });
  it('recommends repairing a young unit with a small repair', () => {
    const r = adviseRepairOrReplace(young());
    expect(r.verdict).toBe('repair');
    expect(r.strength).toBe('clear');
    expect(r.robust).toBe(true);
  });
  it('is deterministic', () => {
    expect(JSON.stringify(adviseRepairOrReplace(input()))).toBe(JSON.stringify(adviseRepairOrReplace(input())));
  });
  it('moves toward replacing as the repair quote rises (monotonic, with a single flip)', () => {
    const verdicts = [20_000, 60_000, 120_000, 200_000, 320_000, 500_000, 800_000].map((q) => adviseRepairOrReplace(young({ repair: { quoteCents: q } })).verdict);
    const firstReplace = verdicts.indexOf('replace');
    expect(firstReplace).toBeGreaterThan(0);
    expect(verdicts.slice(firstReplace).every((v) => v === 'replace')).toBe(true);
    expect(verdicts.slice(0, firstReplace).every((v) => v === 'repair')).toBe(true);
  });
  it('breaks a toss-up toward replacing when two or more rules of thumb agree', () => {
    const r = adviseRepairOrReplace(
      input({
        unit: { ...input().unit, installDate: yearsAgo(13) },
        repair: { quoteCents: 410_000 },
        replacement: { label: 'x', installedCostCents: 820_000 },
        rebates: null,
        forecast: null,
        history: [],
      }),
    );
    expect(r.rules.filter((x) => x.triggered).length).toBeGreaterThanOrEqual(2);
    if (r.strength === 'toss_up') expect(r.verdict).toBe('replace');
  });
  it('flags a toss-up honestly when the two paths are within the threshold', () => {
    // Search for a quote that lands inside the toss-up band, then check the wording.
    let found = null as ReturnType<typeof adviseRepairOrReplace> | null;
    for (let q = 100_000; q <= 900_000 && !found; q += 5_000) {
      const r = adviseRepairOrReplace(young({ repair: { quoteCents: q } }));
      if (r.strength === 'toss_up') found = r;
    }
    expect(found).not.toBeNull();
    expect(found?.reasons.some((x) => x.id === 'close')).toBe(true);
    expect(Math.abs(found?.pvAdvantageOfReplacingCents ?? 1e9)).toBeLessThan(found?.tossUpThresholdCents ?? 0);
  });
});

describe('adviseRepairOrReplace: model behaviour', () => {
  it('a riskier forecast never lowers the risk or the cost of keeping the unit', () => {
    const calm = adviseRepairOrReplace(input({ forecast: { ...(input().forecast as NonNullable<AdvisorInput['forecast']>), probability: 0.02 } }));
    const risky = adviseRepairOrReplace(input({ forecast: { ...(input().forecast as NonNullable<AdvisorInput['forecast']>), probability: 0.4 } }));
    expect(risky.risk.risk12m).toBeGreaterThan(calm.risk.risk12m);
    expect(risky.repair.presentValueCents).toBeGreaterThan(calm.repair.presentValueCents);
  });
  it('never shows a 12-month risk below the near-term forecast', () => {
    const r = adviseRepairOrReplace(input({ forecast: { ...(input().forecast as NonNullable<AdvisorInput['forecast']>), probability: 0.42, confidence: 'high' } }));
    expect(r.risk.risk12m).toBeGreaterThanOrEqual(0.42);
    expect(r.risk.risk5y).toBeGreaterThanOrEqual(r.risk.risk12m);
  });
  it('more rebates make replacing cheaper and leave the repair path alone (except emergency retention)', () => {
    const none = adviseRepairOrReplace(input({ rebates: null }));
    const lots = adviseRepairOrReplace(input({ rebates: REBATES }));
    expect(lots.replace.presentValueCents).toBeLessThan(none.replace.presentValueCents);
    expect(lots.replace.upfrontCents).toBe(820_000 - 60_000);
    expect(none.replace.upfrontCents).toBe(820_000);
  });
  it('a warranty lowers the cost of keeping the unit', () => {
    const w = adviseRepairOrReplace(input({ unit: { ...input().unit, warrantyExpiresAt: yearsAgo(-3) } }));
    const n = adviseRepairOrReplace(input());
    expect(w.unit.warrantyActive).toBe(true);
    expect(w.repair.presentValueCents).toBeLessThan(n.repair.presentValueCents);
  });
  it('an explicit energy-savings figure overrides the efficiency estimate (at 80% realisation)', () => {
    const r = adviseRepairOrReplace(input({ replacement: { label: 'x', installedCostCents: 820_000, annualEnergySavingsCents: 50_000 } }));
    expect(r.annualEnergySavingsCents).toBe(40_000);
  });
  it('a lower discount rate does not change nominal totals', () => {
    const a = adviseRepairOrReplace(input({ customer: { creditBand: 'good', discountRate: 0.03 } }));
    const b = adviseRepairOrReplace(input({ customer: { creditBand: 'good', discountRate: 0.12 } }));
    expect(a.repair.outOfPocketCents).toBe(b.repair.outOfPocketCents);
    expect(a.repair.presentValueCents).not.toBe(b.repair.presentValueCents);
  });
  it('safety-critical failure modes raise the cost of breakdowns and trigger the rule', () => {
    const f = { ...(input().forecast as NonNullable<AdvisorInput['forecast']>), safetyCriticalModes: ['Cracked heat exchanger'] };
    const r = adviseRepairOrReplace(input({ forecast: f }));
    const base = adviseRepairOrReplace(input());
    expect(r.rules.find((x) => x.id === 'safety')?.triggered).toBe(true);
    expect(r.reasons.some((x) => x.id === 'safety')).toBe(true);
    const dis = (x: typeof r) => x.repair.lines.find((l) => l.key === 'disruption')?.nominalCents ?? 0;
    expect(dis(r)).toBeGreaterThan(dis(base) * 2);
  });
  it('treats an unrecognised equipment type with a generic model and says so', () => {
    const r = adviseRepairOrReplace(input({ unit: { ...input().unit, equipmentType: 'Pool pump', make: null, model: null } }));
    expect(r.assumptions.some((a) => /generic/i.test(a))).toBe(true);
  });
});

describe('adviseRepairOrReplace: accounting invariants', () => {
  const r = adviseRepairOrReplace(input());
  it('line items add up to the out-of-pocket total', () => {
    for (const p of [r.repair, r.replace]) {
      expect(p.lines.reduce((s, l) => s + l.nominalCents, 0)).toBe(p.outOfPocketCents);
      expect(p.netCostCents).toBe(p.outOfPocketCents - p.residualCreditCents);
    }
  });
  it('the cumulative curve has one point per year and ends at the out-of-pocket total', () => {
    for (const p of [r.repair, r.replace]) {
      expect(p.cumulativeByYear).toHaveLength(ADVISOR_HORIZON_YEARS);
      expect(Math.abs((p.cumulativeByYear[ADVISOR_HORIZON_YEARS - 1] as number) - p.outOfPocketCents)).toBeLessThanOrEqual(3);
    }
  });
  it('scenario weights sum to one and each scenario names a winner', () => {
    expect(r.scenarios.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 10);
    expect(r.scenarios.every((s) => s.winner === (s.repairPvCents > s.replacePvCents ? 'replace' : 'repair'))).toBe(true);
  });
  it('reports the advantage consistently with the paths', () => {
    expect(r.netAdvantageOfReplacingCents).toBe(r.repair.netCostCents - r.replace.netCostCents);
    expect(r.pvAdvantageOfReplacingCents).toBe(r.repair.presentValueCents - r.replace.presentValueCents);
  });
  it('probabilities stay in range and the 5-year risk is at least the 12-month risk', () => {
    expect(r.risk.risk12m).toBeGreaterThan(0);
    expect(r.risk.risk5y).toBeLessThanOrEqual(0.95);
    expect(r.risk.risk5y).toBeGreaterThanOrEqual(r.risk.risk12m);
  });
  it('reasons are unique, capped and never empty', () => {
    expect(r.reasons.length).toBeGreaterThan(2);
    expect(r.reasons.length).toBeLessThanOrEqual(8);
    expect(new Set(r.reasons.map((x) => x.id)).size).toBe(r.reasons.length);
    expect(r.reasons.every((x) => x.text.length > 10)).toBe(true);
  });
  it('keeping a young unit costs far less than keeping a worn-out one', () => {
    expect(adviseRepairOrReplace(young()).repair.netCostCents).toBeLessThan(r.repair.netCostCents);
  });
});

describe('adviseRepairOrReplace: honesty about missing data', () => {
  it('lists what was assumed and lowers confidence when the install date is unknown', () => {
    const known = adviseRepairOrReplace(input());
    const r = adviseRepairOrReplace(input({ unit: { ...input().unit, installDate: null } }));
    expect(r.unit.ageKnown).toBe(false);
    expect(r.assumptions.some((a) => /install date is unknown/i.test(a))).toBe(true);
    expect(r.dataGaps.some((g) => /install date/i.test(g))).toBe(true);
    expect(r.confidenceScore).toBeLessThan(known.confidenceScore);
  });
  it('uses a typical repair cost and says so when no quote is entered', () => {
    const r = adviseRepairOrReplace(input({ repair: { quoteCents: null }, history: [] }));
    expect(r.assumptions.some((a) => /No repair quote/i.test(a))).toBe(true);
    expect(r.dataGaps.some((g) => /Repair quote/i.test(g))).toBe(true);
  });
  it('asks for a forecast and for rebates when they are missing', () => {
    const r = adviseRepairOrReplace(input({ forecast: null, rebates: null }));
    expect(r.dataGaps.some((g) => /Predictive forecast/i.test(g))).toBe(true);
    expect(r.dataGaps.some((g) => /Rebates/i.test(g))).toBe(true);
    expect(r.confidenceScore).toBeLessThan(adviseRepairOrReplace(input()).confidenceScore);
  });
  it('never labels planning APRs as an offer', () => {
    const r = adviseRepairOrReplace(input());
    expect(r.financing.filter((f) => f.kind !== 'cash').every((f) => f.aprSource === 'planning_estimate')).toBe(true);
    expect(r.assumptions.some((a) => /planning estimates/i.test(a))).toBe(true);
  });
  it('ignores repairs older than two years when counting recent failures', () => {
    const r = adviseRepairOrReplace(input({ history: [{ date: yearsAgo(3), costCents: 90_000, source: 'job' }] }));
    expect(r.unit.recentRepairs).toBe(0);
  });
});

describe('helpers', () => {
  it('formats dollars', () => {
    expect(usd(123_456)).toBe('$1,235');
    expect(usd(-5_000)).toBe('-$50');
  });
  it('recognises repair visits and ignores maintenance', () => {
    expect(isRepairVisit('repair')).toBe(true);
    expect(isRepairVisit(null, 'AC breakdown - no cooling')).toBe(true);
    expect(isRepairVisit('maintenance', 'Annual tune-up')).toBe(false);
    expect(isRepairVisit('install')).toBe(false);
    expect(isRepairVisit(null, null)).toBe(false);
  });
});
