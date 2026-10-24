import { describe, expect, it, vi } from 'vitest';

// estimates.ts pulls in the Supabase client; the pure rules under test never touch it.
vi.mock('@/lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

import { createEmptyOption, type EstimateOption } from '@/lib/estimates';
import {
  INDICATIVE_TERM,
  SalesError,
  advisorCommission,
  avgTicketCents,
  buildAdvisorRows,
  buildLadder,
  closeRatePct,
  compareRepairReplace,
  defaultDepositCents,
  defaultSelectedOptionId,
  equipmentAgeYears,
  financedAmountCents,
  monthlyForTerm,
  pickRepairAndReplace,
  resolvePaymentTerms,
  salesErrorMessage,
  teamTotals,
  validateDeposit,
  validateSale,
  type PerformancePayload,
} from '@/lib/inHomeSales';

function option(tier: EstimateOption['tier'], priceCents: number, recommended = false): EstimateOption {
  const o = createEmptyOption(tier, recommended);
  o.name = `${tier} option`;
  o.line_items = [{ description: 'Work', quantity: 1, unit_price_cents: priceCents }];
  return o;
}

describe('buildLadder', () => {
  const good = option('good', 100_000);
  const better = option('better', 250_000, true);
  const best = option('best', 600_000);

  it('sorts cheapest first, marks the recommended option and computes upgrade gaps', () => {
    const ladder = buildLadder([best, good, better], 0);
    expect(ladder.map((l) => l.option.tier)).toEqual(['good', 'better', 'best']);
    expect(ladder.map((l) => l.upgradeGapCents)).toEqual([0, 150_000, 500_000]);
    expect(ladder.find((l) => l.recommended)?.option.tier).toBe('better');
    expect(defaultSelectedOptionId(ladder)).toBe(better.id);
  });

  it('includes tax in totals', () => {
    const [entry] = buildLadder([good], 10);
    expect(entry.taxCents).toBe(10_000);
    expect(entry.totalCents).toBe(110_000);
  });

  it('falls back to the middle option when none is recommended', () => {
    const ladder = buildLadder([option('good', 1000), option('better', 2000), option('best', 3000)].map((o) => ({ ...o, recommended: false })), 0);
    expect(defaultSelectedOptionId(ladder)).toBe(ladder[1].option.id);
  });
});

describe('payments', () => {
  it('uses lender terms when available, otherwise a clearly indicative default', () => {
    expect(resolvePaymentTerms([])).toEqual([INDICATIVE_TERM]);
    const t = resolvePaymentTerms([
      { term_months: 120, apr_bps: 899, samples: 2 },
      { term_months: 60, apr_bps: 999, samples: 5 },
      { term_months: 0, apr_bps: 100, samples: 1 },
    ]);
    expect(t.map((x) => x.term_months)).toEqual([60, 120]);
    expect(t.every((x) => x.source === 'lender')).toBe(true);
  });

  it('finances total minus deposit and never goes negative', () => {
    expect(financedAmountCents(500_000, 100_000)).toBe(400_000);
    expect(financedAmountCents(50_000, 90_000)).toBe(0);
  });

  it('computes an amortised monthly payment, and 0% APR is a straight split', () => {
    expect(monthlyForTerm(120_000, 0, { term_months: 12, apr_bps: 0, source: 'lender' })).toBe(10_000);
    const m = monthlyForTerm(500_000, 100_000, { term_months: 60, apr_bps: 999, source: 'lender' });
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThan(400_000 / 60);
    expect(m!).toBeLessThan(400_000 / 30);
  });

  it('returns null when nothing is left to finance', () => {
    expect(monthlyForTerm(100_000, 100_000, INDICATIVE_TERM)).toBeNull();
  });

  it('derives and validates the deposit', () => {
    expect(defaultDepositCents(1_000_000, 10)).toBe(100_000);
    expect(defaultDepositCents(1_000_000, 0)).toBe(0);
    expect(validateDeposit(0, 1000)).toBeNull();
    expect(validateDeposit(2000, 1000)).toMatch(/more than the total/);
    expect(validateDeposit(-1, 1000)).toMatch(/valid/);
  });
});

describe('compareRepairReplace', () => {
  const base = { equipmentAgeYears: 14, expectedLifespanYears: 15, repairExtendsYears: 2, horizonYears: 10 };

  it('favours replacing a nearly dead unit when the repair is not cheap enough', () => {
    const r = compareRepairReplace({ ...base, repairCents: 150_000, replaceCents: 600_000 });
    expect(r.repairLifeYears).toBe(1); // only 1 year of expected life left
    expect(r.verdict).toBe('replace');
    expect(r.replaceSavingsCents).toBeGreaterThan(0);
  });

  it('favours repair when it is cheap relative to the life it buys', () => {
    const r = compareRepairReplace({ ...base, equipmentAgeYears: 3, repairExtendsYears: 8, repairCents: 40_000, replaceCents: 900_000 });
    expect(r.verdict).toBe('repair');
    expect(r.repairPerYearCents).toBeLessThan(r.replacePerYearCents);
  });

  it('is symmetric with cost per year of life', () => {
    const r = compareRepairReplace({ ...base, equipmentAgeYears: null, repairCents: 200_000, replaceCents: 600_000 });
    expect(r.repairPerYearCents).toBe(100_000);
    expect(r.replacePerYearCents).toBe(40_000);
    expect(r.verdict).toBe('replace');
  });

  it('reports a close call within 10%', () => {
    const r = compareRepairReplace({ ...base, equipmentAgeYears: null, repairExtendsYears: 5, horizonYears: 5, repairCents: 300_000, replaceCents: 900_000 });
    // 300k/5 = 60k per year vs 900k/15 = 60k per year
    expect(r.verdict).toBe('close');
  });

  it('computes equipment age and handles bad dates', () => {
    expect(equipmentAgeYears(null)).toBeNull();
    expect(equipmentAgeYears('not-a-date')).toBeNull();
    expect(equipmentAgeYears('2016-01-01', new Date('2026-01-01'))).toBe(10);
    expect(equipmentAgeYears('2030-01-01', new Date('2026-01-01'))).toBe(0);
  });

  it('picks the cheapest as repair and the dearest as replace', () => {
    const ladder = buildLadder([option('good', 100), option('better', 200), option('best', 900)], 0);
    const pair = pickRepairAndReplace(ladder);
    expect(pair?.repair.totalCents).toBe(100);
    expect(pair?.replace.totalCents).toBe(900);
    expect(pickRepairAndReplace(ladder.slice(0, 1))).toBeNull();
  });
});

describe('validateSale', () => {
  const ladder = buildLadder([option('good', 100_000), option('better', 200_000, true)], 0);
  it('requires an option, a signature and a sane deposit', () => {
    expect(validateSale({ optionId: null, ladder, signed: false, depositCents: 0 })).toHaveLength(2);
    expect(validateSale({ optionId: ladder[0].option.id, ladder, signed: true, depositCents: 0 })).toEqual([]);
    expect(validateSale({ optionId: ladder[0].option.id, ladder, signed: true, depositCents: 999_999 })[0]).toMatch(/deposit/i);
  });
});

describe('performance', () => {
  it('computes close rate and average ticket safely', () => {
    expect(closeRatePct(3, 1)).toBe(75);
    expect(closeRatePct(0, 0)).toBeNull();
    expect(avgTicketCents(900_000, 3)).toBe(300_000);
    expect(avgTicketCents(0, 0)).toBeNull();
  });

  const advisor = {
    advisor_user_id: 'a1',
    plan: { mode: 'marginal' as const, period: 'monthly' as const, tiers: [{ min_cents: 0, rate_percent: 5 }, { min_cents: 1_000_000, rate_percent: 10 }] },
    employee_rate_percent: null,
  };

  it('applies marginal tiers cumulatively inside a period', () => {
    const c = advisorCommission(advisor, [
      { advisor_user_id: 'a1', closed_at: '2026-10-02T10:00:00Z', subtotal_cents: 800_000 },
      { advisor_user_id: 'a1', closed_at: '2026-10-09T10:00:00Z', subtotal_cents: 400_000 },
      { advisor_user_id: 'other', closed_at: '2026-10-09T10:00:00Z', subtotal_cents: 9_999_999 },
    ]);
    // 800k @5% = 40k; next 400k: 200k @5% (10k) + 200k @10% (20k) = 30k
    expect(c).toEqual({ cents: 70_000, source: 'plan' });
  });

  it('resets tier accumulation when the period rolls over', () => {
    const c = advisorCommission(advisor, [
      { advisor_user_id: 'a1', closed_at: '2026-09-28T10:00:00Z', subtotal_cents: 1_000_000 },
      { advisor_user_id: 'a1', closed_at: '2026-10-02T10:00:00Z', subtotal_cents: 1_000_000 },
    ]);
    expect(c.cents).toBe(100_000); // 50k + 50k, both at the 5% tier
  });

  it('falls back to a flat employee rate, then to no rule', () => {
    const sale = [{ advisor_user_id: 'a1', closed_at: '2026-10-02T10:00:00Z', subtotal_cents: 200_000 }];
    expect(advisorCommission({ advisor_user_id: 'a1', plan: null, employee_rate_percent: 3 }, sale)).toEqual({ cents: 6000, source: 'employee_rate' });
    expect(advisorCommission({ advisor_user_id: 'a1', plan: null, employee_rate_percent: 0 }, sale)).toEqual({ cents: null, source: 'no_rule' });
  });

  it('builds rows and team totals', () => {
    const payload: PerformancePayload = {
      role: 'manager',
      sales: [{ advisor_user_id: 'a1', closed_at: '2026-10-02T10:00:00Z', subtotal_cents: 200_000 }],
      advisors: [
        { advisor_user_id: 'a1', name: 'Ana', appointments: 4, presented: 3, sold: 2, lost: 1, sold_subtotal_cents: 200_000, sold_total_cents: 216_000, financed: 1, deposit_due_cents: 20_000, deposit_collected_cents: 20_000, employee_rate_percent: 5, plan: null },
        { advisor_user_id: 'a2', name: 'Bo', appointments: 1, presented: 1, sold: 0, lost: 1, sold_subtotal_cents: 0, sold_total_cents: 0, financed: 0, deposit_due_cents: 0, deposit_collected_cents: 0, employee_rate_percent: null, plan: null },
      ],
    };
    const rows = buildAdvisorRows(payload);
    expect(rows[0].closeRatePct).toBe(66.7);
    expect(rows[0].financedSharePct).toBe(50);
    expect(rows[0].commissionCents).toBe(10_000);
    expect(rows[1].commissionCents).toBeNull();
    const t = teamTotals(rows);
    expect(t.sold).toBe(2);
    expect(t.lost).toBe(2);
    expect(t.closeRatePct).toBe(50);
    expect(t.avgTicketCents).toBe(108_000);
  });
});

describe('error messages', () => {
  it('maps database error codes to friendly text', () => {
    expect(salesErrorMessage({ message: 'signature_required' })).toMatch(/sign/);
    expect(salesErrorMessage(new SalesError('forbidden'))).toMatch(/comfort advisor/);
  });
  it('never leaks raw database errors', () => {
    expect(salesErrorMessage({ message: 'duplicate key value violates unique constraint "x"' })).toBe('Something went wrong. Please try again.');
    expect(salesErrorMessage(null, 'Custom fallback')).toBe('Custom fallback');
  });
  it('keeps human sentences thrown by the client', () => {
    expect(salesErrorMessage(new SalesError('A phone number or email is needed.'))).toBe('A phone number or email is needed.');
  });
});
