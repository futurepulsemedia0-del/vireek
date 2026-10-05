import { describe, expect, it } from 'vitest';
import {
  assessIncentives,
  computePrice,
  type IncentiveInput,
  type IncentiveProgram,
  type IncentiveProject,
} from '../../supabase/functions/_shared/incentives/engine';

const NOW = '2026-10-01T12:00:00.000Z';

const baseProgram: IncentiveProgram = {
  id: 'p1',
  name: 'Utility heat pump rebate',
  program_type: 'utility_rebate',
  administrator: 'Example Power',
  country: 'US',
  states: ['CA'],
  postal_prefixes: [],
  utility_names: ['Example Power'],
  equipment_types: ['heat pump'],
  customer_kind: 'residential',
  requires_owner_occupied: false,
  requires_income_qualified: false,
  min_building_age_years: null,
  max_building_age_years: null,
  efficiency_metric: 'SEER2',
  min_efficiency_value: 15,
  min_project_cents: null,
  benefit_kind: 'fixed',
  benefit_value: 150_000,
  cap_cents: null,
  percent_basis: 'project',
  delivery: 'instant',
  stack_group: null,
  funding_status: 'available',
  effective_start: '2026-01-01',
  effective_end: '2026-12-31',
  verified_at: '2026-09-15T00:00:00.000Z',
  source_url: null,
  notes: null,
};

const baseProject: IncentiveProject = {
  effective_date: '2026-10-15',
  country: 'US',
  state: 'CA',
  postal_code: '94105',
  utility_name: 'Example Power',
  customer_kind: 'residential',
  owner_occupied: true,
  income_qualified: null,
  building_year_built: 1998,
  equipment_type: 'Heat pump',
  equipment_units: 1,
  efficiency_metric: 'SEER2',
  efficiency_value: 17,
  equipment_cost_cents: null,
  annual_kwh_saved: null,
  annual_therms_saved: null,
  annual_savings_direct_cents: null,
  electric_rate_cents_per_kwh: null,
  gas_rate_cents_per_therm: null,
};

function input(over: { programs?: Partial<IncentiveProgram>[]; project?: Partial<IncentiveProject>; discount?: [ 'percent' | 'flat', number ] } = {}): IncentiveInput {
  return {
    now: NOW,
    quote: {
      line_items: [{ description: 'Heat pump install', quantity: 1, unit_price_cents: 1_200_000 }],
      tax_percent: 0,
      discount_type: over.discount?.[0] ?? null,
      discount_value: over.discount?.[1] ?? null,
    },
    project: { ...baseProject, ...over.project },
    programs: (over.programs ?? [{}]).map((p, i) => ({ ...baseProgram, id: `p${i + 1}`, name: `Program ${i + 1}`, ...p })),
  };
}

describe('computePrice', () => {
  it('applies a flat discount in dollars and tax after discount', () => {
    const r = computePrice({ line_items: [{ description: 'x', quantity: 2, unit_price_cents: 50_000 }], tax_percent: 10, discount_type: 'flat', discount_value: 200 });
    expect(r.price).toBe(80_000);
    expect(r.tax).toBe(8_000);
    expect(r.total).toBe(88_000);
  });
});

describe('assessIncentives', () => {
  it('confirms a fully verified program and computes net cost', () => {
    const r = assessIncentives(input());
    expect(r.evaluations[0].status).toBe('eligible');
    expect(r.economics.confirmed_cents).toBe(150_000);
    expect(r.economics.net_cost_confirmed_cents).toBe(1_050_000);
    expect(r.economics.due_at_signing_cents).toBe(1_050_000);
  });

  it('marks unknown inputs as conditional instead of passing them', () => {
    const r = assessIncentives(input({ programs: [{ requires_income_qualified: true }] }));
    expect(r.evaluations[0].status).toBe('conditional');
    expect(r.economics.confirmed_cents).toBe(0);
    expect(r.economics.conditional_cents).toBe(150_000);
    expect(r.economics.net_cost_best_cents).toBe(1_050_000);
    expect(r.economics.net_cost_confirmed_cents).toBe(1_200_000);
  });

  it('rejects wrong state, expired programs and low efficiency', () => {
    expect(assessIncentives(input({ project: { state: 'NY' } })).evaluations[0].status).toBe('ineligible');
    expect(assessIncentives(input({ project: { effective_date: '2027-02-01' } })).evaluations[0].status).toBe('ineligible');
    expect(assessIncentives(input({ project: { efficiency_value: 13 } })).evaluations[0].status).toBe('ineligible');
  });

  it('never confirms a stale or exhausted program', () => {
    const stale = assessIncentives(input({ programs: [{ verified_at: '2025-01-01T00:00:00.000Z' }] }));
    expect(stale.evaluations[0].status).toBe('conditional');
    const out = assessIncentives(input({ programs: [{ funding_status: 'exhausted' }] }));
    expect(out.evaluations[0].status).toBe('ineligible');
    expect(out.economics.potential_cents).toBe(0);
  });

  it('does not double count a stack group and keeps an eligible fallback', () => {
    const r = assessIncentives(
      input({
        programs: [
          { stack_group: 'hp', benefit_value: 100_000 },
          { stack_group: 'hp', benefit_value: 250_000, requires_income_qualified: true },
        ],
      }),
    );
    expect(r.economics.potential_cents).toBe(250_000);
    expect(r.economics.confirmed_cents).toBe(100_000);
    expect(r.economics.conditional_cents).toBe(150_000);
  });

  it('applies percent benefits with a cap and caps total incentives at the project total', () => {
    const pct = assessIncentives(input({ programs: [{ benefit_kind: 'percent', benefit_value: 30, cap_cents: 200_000 }] }));
    expect(pct.economics.confirmed_cents).toBe(200_000);
    const huge = assessIncentives(input({ programs: [{ benefit_value: 5_000_000 }] }));
    expect(huge.economics.confirmed_cents).toBe(1_200_000);
    expect(huge.economics.net_cost_confirmed_cents).toBe(0);
    expect(huge.economics.capped).toBe(true);
  });

  it('splits instant vs delayed incentives', () => {
    const r = assessIncentives(input({ programs: [{ delivery: 'instant', benefit_value: 100_000 }, { delivery: 'tax_credit', benefit_value: 200_000 }] }));
    expect(r.economics.due_at_signing_cents).toBe(1_100_000);
    expect(r.economics.delayed_cents).toBe(200_000);
  });

  it('computes payback only from supplied savings and shows months saved', () => {
    const none = assessIncentives(input());
    expect(none.energy.known).toBe(false);
    const r = assessIncentives(input({ project: { annual_kwh_saved: 6_000, electric_rate_cents_per_kwh: 20 } }));
    expect(r.energy.annual_savings_cents).toBe(120_000);
    expect(r.energy.payback_months_without_incentives).toBe(120);
    expect(r.energy.payback_months_best).toBe(105);
    expect(r.energy.months_saved_by_incentives).toBe(15);
    expect(r.energy.ten_year_net_benefit_cents).toBe(150_000);
  });

  it('flags an expiring program and an empty catalog', () => {
    const soon = assessIncentives(input({ programs: [{ effective_end: '2026-10-25' }] }));
    expect(soon.action_items.some((a) => a.title.includes('deadline'))).toBe(true);
    const empty = assessIncentives(input({ programs: [] }));
    expect(empty.action_items[0].title).toContain('No incentive programs');
  });

  it('throws when the quote has no value', () => {
    const i = input();
    i.quote.line_items = [];
    expect(() => assessIncentives(i)).toThrow();
  });
});
