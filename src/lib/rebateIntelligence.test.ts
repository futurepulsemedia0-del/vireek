import { describe, expect, it } from 'vitest';
import {
  analyzeRebates,
  monthlyPayment,
  realizationRate,
  type IncentiveProgram,
  type PropertyContext,
  type RebateInput,
  type ReplacementOption,
} from '../../supabase/functions/_shared/rebate-intelligence/engine';

const NOW = '2026-10-02T12:00:00.000Z';

function prog(over: Partial<IncentiveProgram> = {}): IncentiveProgram {
  return {
    id: over.slug ?? 'p1',
    slug: 'p1',
    name: 'Test Program',
    level: 'utility',
    administrator: null,
    jurisdiction_state: null,
    utility_name: null,
    postal_prefixes: [],
    measure_types: ['heat_pump_hvac'],
    incentive_kind: 'rebate',
    payout_timing: 'post_install',
    amount_type: 'flat',
    amount_value: 100_000,
    max_amount_cents: null,
    min_efficiency: {},
    income_tiers: [],
    requires_owner_occupied: false,
    requires_pre_approval: false,
    requires_participating_contractor: false,
    exclusive_group: null,
    start_date: null,
    end_date: null,
    funding_status: 'open',
    source_url: null,
    last_verified_at: '2026-09-25T00:00:00.000Z',
    notes: null,
    is_private: false,
    ...over,
  };
}

const property: PropertyContext = {
  state: 'TX',
  postal_code: '78701',
  utility_name: null,
  household_ami_pct: null,
  owner_occupied: true,
  install_target_date: '2026-11-15',
};

const hp: ReplacementOption = {
  key: 'hp-18',
  label: '18 SEER2 heat pump',
  measure: 'heat_pump_hvac',
  installed_cost_cents: 1_200_000,
  efficiency: { seer2: 18, hspf2: 9 },
  energy_star: true,
  tons: 3,
};

function input(over: Partial<RebateInput> = {}): RebateInput {
  return { now: NOW, property, equipment: null, options: [hp], programs: [], territories: [], outcomes: {}, financing: null, ...over };
}

describe('rebate engine - federal timing', () => {
  const credit = prog({
    slug: 'fed-25c',
    name: '25C',
    level: 'federal',
    incentive_kind: 'tax_credit',
    payout_timing: 'tax_filing',
    amount_type: 'percent_of_cost',
    amount_value: 30,
    max_amount_cents: 200_000,
    end_date: '2025-12-31',
    funding_status: 'closed',
  });

  it('excludes an ended federal credit for a 2026 install and says why', () => {
    const r = analyzeRebates(input({ programs: [credit] }));
    expect(r.options[0].incentives).toHaveLength(0);
    expect(r.options[0].excluded[0].reason).toContain('ended 2025-12-31');
  });

  it('still models the credit for a 2025 install (capped at $2,000)', () => {
    const r = analyzeRebates(
      input({
        now: '2025-10-02T12:00:00.000Z',
        property: { ...property, install_target_date: '2025-11-01' },
        programs: [{ ...credit, funding_status: 'open' }],
      }),
    );
    expect(r.options[0].incentives[0].amount_cents).toBe(200_000);
    expect(r.options[0].tax_filing_cents).toBeGreaterThan(0);
  });
});

describe('rebate engine - income tiers (HEAR style)', () => {
  const hear = prog({
    slug: 'hear',
    level: 'federal',
    payout_timing: 'point_of_sale',
    amount_type: 'percent_of_cost',
    amount_value: 100,
    max_amount_cents: 800_000,
    income_tiers: [
      { max_ami_pct: 80, share_pct: 100 },
      { max_ami_pct: 150, share_pct: 50 },
    ],
    last_verified_at: '2026-09-30T00:00:00.000Z',
  });

  it('pays up to the cap below 80% AMI', () => {
    const r = analyzeRebates(input({ programs: [hear], property: { ...property, household_ami_pct: 70 } }));
    expect(r.options[0].incentives[0].amount_cents).toBe(800_000);
    expect(r.options[0].point_of_sale_cents).toBeGreaterThan(0);
  });

  it('pays half between 80% and 150% AMI', () => {
    const r = analyzeRebates(input({ programs: [hear], property: { ...property, household_ami_pct: 120 } }));
    expect(r.options[0].incentives[0].amount_cents).toBe(600_000);
  });

  it('is ineligible above 150% AMI', () => {
    const r = analyzeRebates(input({ programs: [hear], property: { ...property, household_ami_pct: 200 } }));
    expect(r.options[0].incentives).toHaveLength(0);
    expect(r.options[0].excluded[0].reason).toContain('above the program limit');
  });

  it('asks for income instead of guessing, and does not count the upside', () => {
    const r = analyzeRebates(input({ programs: [hear] }));
    const ev = r.options[0].incentives[0];
    expect(ev.status).toBe('needs_info');
    expect(ev.missing[0]).toContain('AMI');
    expect(r.options[0].total_expected_cents).toBe(0);
    expect(r.options[0].upside_cents).toBeGreaterThan(0);
  });
});

describe('rebate engine - geography and efficiency', () => {
  it('excludes programs from another state', () => {
    const r = analyzeRebates(input({ programs: [prog({ jurisdiction_state: 'CA', level: 'state' })] }));
    expect(r.options[0].excluded[0].reason).toContain('limited to CA');
  });

  it('matches a utility program through the ZIP territory table', () => {
    const p = prog({ utility_name: 'Austin Energy' });
    const r = analyzeRebates(input({ programs: [p], territories: [{ postal_code: '78701', utility_name: 'Austin Energy', utility_type: 'electric' }] }));
    expect(r.options[0].incentives[0].status).toBe('eligible');
    expect(r.utilities_resolved).toEqual(['Austin Energy']);
  });

  it('needs the utility when unknown', () => {
    const r = analyzeRebates(input({ programs: [prog({ utility_name: 'Austin Energy' })] }));
    expect(r.options[0].incentives[0].status).toBe('needs_info');
  });

  it('rejects units below the efficiency floor and asks for missing ratings', () => {
    const low = analyzeRebates(input({ programs: [prog({ min_efficiency: { seer2: 20 } })] }));
    expect(low.options[0].excluded[0].reason).toContain('SEER2 18 is below the required 20');
    const unknown = analyzeRebates(input({ programs: [prog({ min_efficiency: { eer2: 12 } })] }));
    expect(unknown.options[0].incentives[0].missing[0]).toContain('EER2');
  });
});

describe('rebate engine - stacking, confidence, outcomes', () => {
  it('keeps only the best program in an exclusive group', () => {
    const a = prog({ slug: 'a', name: 'A', amount_value: 50_000, exclusive_group: 'g' });
    const b = prog({ slug: 'b', name: 'B', amount_value: 90_000, exclusive_group: 'g' });
    const r = analyzeRebates(input({ programs: [a, b] }));
    expect(r.options[0].incentives.map((e) => e.slug)).toEqual(['b']);
    expect(r.options[0].excluded[0].reason).toContain('Cannot be combined');
  });

  it('shrinks expected value when real outcomes show denials', () => {
    const p = prog({ slug: 'denied-a-lot' });
    const good = analyzeRebates(input({ programs: [p] }));
    const bad = analyzeRebates(input({ programs: [p], outcomes: { 'denied-a-lot': { decided: 20, successes: 4, scope: 'network' } } }));
    expect(bad.options[0].total_expected_cents).toBeLessThan(good.options[0].total_expected_cents);
    expect(bad.options[0].incentives[0].realization.scope).toBe('network');
  });

  it('realization rate is a shrunk estimate, never 0 or 1 on tiny samples', () => {
    expect(realizationRate(undefined).rate).toBe(0.8);
    expect(realizationRate({ decided: 1, successes: 0, scope: 'account' }).rate).toBeGreaterThan(0.5);
  });

  it('flags stale catalog entries', () => {
    const r = analyzeRebates(input({ programs: [prog({ last_verified_at: '2025-01-01T00:00:00.000Z' })] }));
    expect(r.data_quality.stale_programs).toBe(1);
    expect(r.options[0].incentives[0].status).toBe('likely');
  });

  it('warns when no local programs exist for the state', () => {
    const r = analyzeRebates(input({ programs: [prog({ level: 'federal' })] }));
    expect(r.data_quality.local_coverage).toBe(false);
    expect(r.data_quality.warnings.join(' ')).toContain('federal programs only');
  });
});

describe('rebate engine - proposal math', () => {
  it('computes zero-APR and amortized payments', () => {
    expect(monthlyPayment(1_200_000, 0, 120)).toBe(10_000);
    expect(monthlyPayment(1_200_000, 899, 120)).toBeGreaterThan(10_000);
    expect(monthlyPayment(0, 899, 120)).toBe(0);
  });

  it('never lets incentives push net cost below zero', () => {
    const r = analyzeRebates(input({ programs: [prog({ amount_value: 9_999_999 })] }));
    expect(r.options[0].net_cost_expected_cents).toBeGreaterThanOrEqual(0);
  });

  it('ranks by 10-year cost when every option has savings', () => {
    const cheap: ReplacementOption = { ...hp, key: 'cheap', installed_cost_cents: 900_000, annual_energy_savings_cents: 5_000 };
    const eff: ReplacementOption = { ...hp, key: 'eff', installed_cost_cents: 1_200_000, annual_energy_savings_cents: 60_000 };
    const r = analyzeRebates(input({ options: [cheap, eff] }));
    expect(r.rank_basis).toBe('ten_year_net_cost');
    expect(r.best_option_key).toBe('eff');
  });

  it('adds financing comparisons and manufacturer rebates', () => {
    const r = analyzeRebates(
      input({ options: [{ ...hp, manufacturer_rebate_cents: 50_000 }], financing: { apr_bps: 999, term_months: 84 }, programs: [prog({ payout_timing: 'point_of_sale' })] }),
    );
    const f = r.options[0].financing!;
    expect(f.monthly_after_point_of_sale_cents).toBeLessThan(f.monthly_no_incentives_cents);
    expect(r.options[0].post_install_cents).toBe(50_000);
  });

  it('raises a deadline alert and a pre-approval action', () => {
    const p = prog({ end_date: '2026-12-31', requires_pre_approval: true });
    const r = analyzeRebates(input({ programs: [p] }));
    expect(r.deadline_alerts[0].days_left).toBe(90);
    expect(r.actions[0]).toContain('pre-approval');
  });

  it('classifies equipment stage from install date and lifespan', () => {
    const r = analyzeRebates(
      input({ equipment: { id: 'e1', equipment_type: 'AC', make: 'Trane', model: 'X', install_date: '2008-01-01', expected_lifespan_years: 15, last_service_date: null } }),
    );
    expect(r.equipment?.stage).toBe('past_life');
  });
});
