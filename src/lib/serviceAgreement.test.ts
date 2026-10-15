import { describe, expect, it, vi } from 'vitest';
import {
  addMonths,
  annualizedValueCents,
  claimCashCents,
  computeHealth,
  computeProfitability,
  defaultNextDue,
  entitlementUsage,
  friendlyWriteError,
  gradeFor,
  periodWindow,
  pmStatus,
  portfolioKpis,
  projectEscalation,
  renewalState,
  suggestReprice,
  toDateKey,
  warrantyGapEquipment,
  type EntitlementRow,
  type PortfolioRow,
  type VisitRow,
} from './serviceAgreement';
import { emptyTerms } from './contractIntelligence';

// The pure logic under test never touches the network; keep the Supabase client out of the test.
vi.mock('./supabase', () => ({ supabase: {} }));

const NOW = new Date(2026, 5, 15); // 15 Jun 2026 (local)

const visit = (over: Partial<VisitRow>): VisitRow => ({
  id: Math.random().toString(36).slice(2),
  contract_id: 'c1',
  entitlement_kind: 'pm_visit',
  pm_plan_id: null,
  job_id: null,
  visit_date: '2026-06-01',
  status: 'completed',
  quantity: 1,
  billable: false,
  notes: null,
  completed_at: null,
  ...over,
});

const ent = (over: Partial<EntitlementRow> = {}): EntitlementRow => ({
  id: 'e1',
  contract_id: 'c1',
  kind: 'pm_visit',
  included_quantity: 4,
  period: 'year',
  overage_rate_cents: 15000,
  ...over,
});

describe('date helpers', () => {
  it('addMonths clamps to the last day of shorter months', () => {
    expect(toDateKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-28');
    expect(toDateKey(addMonths(new Date(2024, 0, 31), 1))).toBe('2024-02-29');
  });

  it('defaultNextDue is one interval after the last completion, else today', () => {
    expect(defaultNextDue(6, '2026-01-10', NOW)).toBe('2026-07-10');
    expect(defaultNextDue(6, null, NOW)).toBe('2026-06-15');
  });
});

describe('pricing', () => {
  it('annualises per-period fees and returns null for one-time', () => {
    expect(annualizedValueCents({ contract_value_cents: 100_000, billing_frequency: 'monthly' })).toBe(1_200_000);
    expect(annualizedValueCents({ contract_value_cents: 300_000, billing_frequency: 'quarterly' })).toBe(1_200_000);
    expect(annualizedValueCents({ contract_value_cents: 1_200_000, billing_frequency: 'annual' })).toBe(1_200_000);
    expect(annualizedValueCents({ contract_value_cents: 500_000, billing_frequency: 'one_time' })).toBeNull();
    expect(annualizedValueCents({ contract_value_cents: null, billing_frequency: 'monthly' })).toBeNull();
  });

  it('projects a fixed-percent escalation and respects the cap', () => {
    const terms = emptyTerms();
    terms.pricing = { escalation_type: 'fixed_percent', escalation_percent: 5, escalation_cap_percent: 3, next_escalation_date: '2026-07-01' };
    const p = projectEscalation({ contract_value_cents: 100_000 }, terms, NOW);
    expect(p.percent).toBe(3);
    expect(p.projectedCents).toBe(103_000);
    expect(p.deltaCents).toBe(3_000);
    expect(p.daysAway).toBe(16);
  });

  it('does not invent a projection for CPI escalation', () => {
    const terms = emptyTerms();
    terms.pricing = { escalation_type: 'cpi', escalation_percent: null, escalation_cap_percent: null, next_escalation_date: null };
    expect(projectEscalation({ contract_value_cents: 100_000 }, terms, NOW).projectedCents).toBeNull();
  });
});

describe('entitlement windows & usage', () => {
  const contract = { start_date: '2026-03-01', end_date: '2027-02-28' };

  it('year windows restart on the contract anniversary, not on 1 January', () => {
    const w = periodWindow('year', contract, NOW);
    expect(toDateKey(w.start)).toBe('2026-03-01');
    expect(toDateKey(w.end)).toBe('2027-03-01');
  });

  it('quarter windows step from the start date', () => {
    const w = periodWindow('quarter', contract, NOW);
    expect(toDateKey(w.start)).toBe('2026-06-01');
    expect(toDateKey(w.end)).toBe('2026-09-01');
  });

  it('a contract that has not started yet uses its first window', () => {
    const w = periodWindow('year', { start_date: '2026-09-01', end_date: null }, NOW);
    expect(toDateKey(w.start)).toBe('2026-09-01');
  });

  it('counts only completed visits inside the window and computes overage cost', () => {
    const visits = [
      visit({ visit_date: '2026-03-10' }),
      visit({ visit_date: '2026-04-10' }),
      visit({ visit_date: '2026-05-10' }),
      visit({ visit_date: '2026-06-01' }),
      visit({ visit_date: '2026-06-05' }), // 5th completed -> 1 over
      visit({ visit_date: '2026-06-10', status: 'scheduled' }),
      visit({ visit_date: '2026-06-11', status: 'missed' }),
      visit({ visit_date: '2025-12-01' }), // previous window
      visit({ visit_date: '2026-06-02', entitlement_kind: 'service_call' }),
    ];
    const u = entitlementUsage(ent(), visits, contract, NOW);
    expect(u.used).toBe(5);
    expect(u.scheduled).toBe(1);
    expect(u.overage).toBe(1);
    expect(u.overageCostCents).toBe(15_000);
    expect(u.remaining).toBe(0);
    expect(u.utilizationPct).toBeCloseTo(125);
  });

  it('sums fractional labor hours', () => {
    const u = entitlementUsage(ent({ kind: 'labor_hours', included_quantity: 10 }), [
      visit({ entitlement_kind: 'labor_hours', quantity: 2.5 }),
      visit({ entitlement_kind: 'labor_hours', quantity: 1.5 }),
    ], contract, NOW);
    expect(u.used).toBe(4);
    expect(u.remaining).toBe(6);
  });
});

describe('preventive maintenance status', () => {
  it('classifies overdue, due soon, on track, paused and unscheduled', () => {
    expect(pmStatus({ active: true, next_due_date: '2026-06-10' }, NOW).status).toBe('overdue');
    expect(pmStatus({ active: true, next_due_date: '2026-06-15' }, NOW).status).toBe('due_soon');
    expect(pmStatus({ active: true, next_due_date: '2026-07-15' }, NOW).status).toBe('due_soon');
    expect(pmStatus({ active: true, next_due_date: '2026-07-16' }, NOW).status).toBe('scheduled');
    expect(pmStatus({ active: false, next_due_date: '2026-01-01' }, NOW).status).toBe('paused');
    expect(pmStatus({ active: true, next_due_date: null }, NOW).status).toBe('unscheduled');
  });
});

describe('profitability', () => {
  const contract = { contract_value_cents: 100_000, billing_frequency: 'monthly' as const, start_date: '2026-01-01', end_date: '2026-12-31' };

  it('recognises recurring revenue pro-rata and subtracts cost, penalties and claim payouts', () => {
    const p = computeProfitability({
      contract,
      now: new Date(2026, 5, 30),
      jobs: [
        { job_id: 'a', revenue_cents: 0, total_cost_cents: 30_000, labor_cost_cents: 20_000, material_cost_cents: 10_000 },
        { job_id: 'b', revenue_cents: 20_000, total_cost_cents: 15_000, labor_cost_cents: 10_000, material_cost_cents: 5_000 },
        { job_id: 'c', revenue_cents: 0, total_cost_cents: 5_000, labor_cost_cents: 5_000, material_cost_cents: 0 },
      ],
      breaches: [{ penalty_amount_cents: 10_000 }],
      claims: [
        { claim_type: 'sla_credit', status: 'settled', approved_cents: 8_000, settled_cents: 7_000 },
        { claim_type: 'warranty_recovery', status: 'settled', approved_cents: 4_000, settled_cents: 4_000 },
        { claim_type: 'coverage_dispute', status: 'open', approved_cents: null, settled_cents: null },
      ],
    });
    expect(p.elapsedMonths).toBeGreaterThan(5.9);
    expect(p.elapsedMonths).toBeLessThan(6.1);
    expect(p.recurringRevenueCents).toBeGreaterThan(590_000);
    expect(p.recurringRevenueCents).toBeLessThan(610_000);
    expect(p.jobRevenueCents).toBe(20_000);
    expect(p.costToServeCents).toBe(50_000);
    expect(p.laborCostCents).toBe(35_000);
    expect(p.partsCostCents).toBe(15_000);
    expect(p.claimPayoutsCents).toBe(7_000);
    expect(p.recoveriesCents).toBe(4_000);
    expect(p.grossProfitCents).toBe(p.totalRevenueCents - 50_000 - 10_000 - 7_000 + 4_000);
    expect(p.marginPct).not.toBeNull();
    expect(p.costPerJobCents).toBe(16_667);
    expect(p.lowConfidence).toBe(false);
  });

  it('flags thin history as low confidence', () => {
    const p = computeProfitability({ contract, now: new Date(2026, 0, 10), jobs: [], breaches: [], claims: [] });
    expect(p.lowConfidence).toBe(true);
  });

  it('never counts an unpaid claim as cash out, and treats recoveries as inflow', () => {
    expect(claimCashCents({ claim_type: 'coverage_dispute', status: 'open', approved_cents: 5_000, settled_cents: null })).toEqual({ out: 0, in: 0 });
    expect(claimCashCents({ claim_type: 'coverage_dispute', status: 'approved', approved_cents: 5_000, settled_cents: null })).toEqual({ out: 5_000, in: 0 });
    expect(claimCashCents({ claim_type: 'warranty_recovery', status: 'settled', approved_cents: 5_000, settled_cents: 4_500 })).toEqual({ out: 0, in: 4_500 });
  });

  it('suggests a fee that reaches the target margin only when under it', () => {
    const base = computeProfitability({
      contract,
      now: new Date(2026, 5, 30),
      jobs: Array.from({ length: 6 }, (_, i) => ({ job_id: String(i), revenue_cents: 0, total_cost_cents: 150_000, labor_cost_cents: 100_000, material_cost_cents: 50_000 })),
      breaches: [],
      claims: [],
    });
    expect(base.marginPct).toBeLessThan(0);
    const s = suggestReprice(contract, base, 25);
    expect(s).not.toBeNull();
    expect(s!.suggestedFeeCents).toBeGreaterThan(100_000);
    // At the suggested fee the run-rate margin hits the target.
    const perMonthBurn = base.costToServeCents / base.elapsedMonths;
    expect(1 - perMonthBurn / s!.suggestedFeeCents).toBeGreaterThanOrEqual(0.24);

    const healthy = computeProfitability({ contract, now: new Date(2026, 5, 30), jobs: [], breaches: [], claims: [] });
    expect(suggestReprice(contract, healthy)).toBeNull();
  });
});

describe('renewal state', () => {
  const live = { status: 'active' as const, end_date: '2026-07-10', auto_renew: false, renewal_notice_days: 30 };

  it('is urgent inside the notice window with no renewal started', () => {
    const r = renewalState(live, null, NOW);
    expect(r.inNoticeWindow).toBe(true);
    expect(r.risk).toBe('urgent');
  });

  it('is secured once the renewal is accepted', () => {
    expect(renewalState(live, { status: 'accepted' }, NOW).risk).toBe('secured');
  });

  it('is lapsed after the end date', () => {
    expect(renewalState({ ...live, end_date: '2026-05-01' }, null, NOW).risk).toBe('lapsed');
  });

  it('auto-renew outside the window is no risk', () => {
    expect(renewalState({ ...live, auto_renew: true, end_date: '2026-12-31' }, null, NOW).risk).toBe('none');
  });

  it('open-ended agreements have no renewal risk', () => {
    expect(renewalState({ ...live, end_date: null }, null, NOW).risk).toBe('none');
  });
});

describe('health score', () => {
  const contract = { status: 'active' as const, end_date: '2027-06-01', auto_renew: true, renewal_notice_days: 30 };
  const clean = { contract, breaches: [], pmPlans: [], claims: [], renewal: null, termsReview: 'verified' as const, assetCount: 3, now: NOW };

  it('a clean, verified agreement scores healthy', () => {
    const h = computeHealth(clean);
    expect(h.score).toBeGreaterThanOrEqual(85);
    expect(h.grade).toBe('healthy');
  });

  it('unresolved major breaches and overdue PM pull the score down', () => {
    const bad = computeHealth({
      ...clean,
      breaches: [
        { severity: 'major', resolved: false, created_at: new Date(2026, 5, 1).toISOString() },
        { severity: 'critical', resolved: false, created_at: new Date(2026, 5, 2).toISOString() },
      ],
      pmPlans: [{ active: true, next_due_date: '2026-05-01' }],
      claims: [{ status: 'open' }, { status: 'under_review' }],
    });
    expect(bad.score).toBeLessThan(computeHealth(clean).score);
    expect(['at_risk', 'critical']).toContain(bad.grade);
  });

  it('ignores breaches older than 90 days', () => {
    const h = computeHealth({ ...clean, breaches: [{ severity: 'critical', resolved: false, created_at: new Date(2026, 0, 1).toISOString() }] });
    expect(h.factors.find((f) => f.key === 'sla')!.score).toBe(100);
  });

  it('only scores factors it has data for', () => {
    const keys = computeHealth(clean).factors.map((f) => f.key);
    expect(keys).not.toContain('pm');
    expect(keys).not.toContain('profitability');
    expect(keys).toContain('sla');
  });

  it('grades on documented thresholds', () => {
    expect(gradeFor(90)).toBe('healthy');
    expect(gradeFor(70)).toBe('watch');
    expect(gradeFor(50)).toBe('at_risk');
    expect(gradeFor(10)).toBe('critical');
  });
});

describe('coverage helpers', () => {
  it('finds covered equipment whose warranty ends before the agreement does', () => {
    const equipment = [
      { id: 'e1', equipment_type: 'RTU', make: null, model: null, serial_number: null, status: 'active', warranty_expires_at: '2026-08-01', last_service_date: null, service_interval_months: 12 },
      { id: 'e2', equipment_type: 'Boiler', make: null, model: null, serial_number: null, status: 'active', warranty_expires_at: '2030-01-01', last_service_date: null, service_interval_months: 12 },
      { id: 'e3', equipment_type: 'Chiller', make: null, model: null, serial_number: null, status: 'active', warranty_expires_at: null, last_service_date: null, service_interval_months: 12 },
      { id: 'e4', equipment_type: 'Not covered', make: null, model: null, serial_number: null, status: 'active', warranty_expires_at: '2026-01-01', last_service_date: null, service_interval_months: 12 },
    ];
    const assets = ['e1', 'e2', 'e3'].map((id) => ({ id: `a-${id}`, contract_id: 'c1', site_id: null, equipment_id: id, coverage_level: 'full' as const, notes: null }));
    expect(warrantyGapEquipment(assets, equipment, '2027-01-01').map((e) => e.id).sort()).toEqual(['e1', 'e3']);
  });
});

describe('portfolio KPIs & errors', () => {
  it('rolls up only live agreements', () => {
    const mk = (status: 'active' | 'expired', annual: number, risk: 'urgent' | 'none'): PortfolioRow => ({
      contract: { status } as never,
      customerName: 'x',
      assetCount: 0,
      openClaims: 1,
      overduePm: 2,
      activePm: 2,
      unresolvedBreaches: 3,
      penaltyCents90: 0,
      renewal: null,
      renewalState: { daysLeft: 5, inNoticeWindow: true, risk, headline: '' },
      termsReview: 'none',
      health: { score: 80, grade: 'watch', factors: [] },
      annualValueCents: annual,
    });
    const k = portfolioKpis([mk('active', 1_000, 'urgent'), mk('active', 2_000, 'none'), mk('expired', 9_999, 'urgent')]);
    expect(k.live).toBe(2);
    expect(k.annualRecurringCents).toBe(3_000);
    expect(k.atRiskRenewals).toBe(1);
    expect(k.overduePm).toBe(4);
    expect(k.avgHealth).toBe(80);
  });

  it('turns database errors into actionable sentences', () => {
    expect(friendlyWriteError({ code: '23505' })).toMatch(/already exists/);
    expect(friendlyWriteError({ code: '42501' })).toMatch(/permission/);
    expect(friendlyWriteError({ code: '23514', message: 'That property does not belong to the agreement\'s customer.' })).toMatch(/does not belong/);
    expect(friendlyWriteError({ code: '42P01', message: 'relation "agreement_assets" does not exist' })).toMatch(/migration/);
  });
});
