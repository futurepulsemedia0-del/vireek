import { describe, expect, it } from 'vitest';
import {
  addCoveredMinutes,
  computePenaltyCents,
  emptyTerms,
  evaluateJob,
  formatCountdown,
  normalizeTerms,
  type ContractTerms,
  type EngineContract,
  type EngineJob,
  type EngineProfile,
} from './contractIntelligence';

const TZ = 'America/Chicago';

const contract: EngineContract = {
  id: 'c1',
  contract_name: 'Acme MSA',
  status: 'active',
  customer_id: 'cust1',
  start_date: '2026-01-01',
  end_date: '2027-12-31',
  auto_renew: true,
  renewal_notice_days: 30,
  billing_frequency: 'monthly',
  contract_value_cents: 1_000_000,
  sla_response_minutes_standard: 480,
  sla_response_minutes_critical: 60,
  sla_resolution_hours: 48,
  penalty_percentage: 0,
  penalty_cap_percentage: 20,
};

function terms(over: (t: ContractTerms) => void = () => {}): ContractTerms {
  const t = emptyTerms(TZ);
  t.responsibility = { labor: 'contractor', parts: 'contractor', per_visit_cap_cents: null };
  over(t);
  return t;
}

const job = (over: Partial<EngineJob> = {}): EngineJob => ({
  id: 'j1',
  customer_id: 'cust1',
  service_type: 'HVAC repair',
  is_emergency: false,
  tags: [],
  created_at: '2026-09-30T15:00:00.000Z',
  scheduled_datetime: null,
  job_status: 'scheduled',
  invoice_amount: 500,
  ...over,
});

const run = (t: ContractTerms, j: EngineJob, verified = true, extra: Partial<Parameters<typeof evaluateJob>[0]> = {}) =>
  evaluateJob({
    job: j,
    contracts: [contract],
    profiles: new Map<string, EngineProfile>([['c1', { terms: t, review_status: verified ? 'verified' : 'draft' }]]),
    equipment: [],
    responseMetAt: null,
    now: new Date('2026-09-30T15:30:00.000Z'),
    ...extra,
  });

describe('business-hours clock', () => {
  const sla = { ...emptyTerms(TZ).sla, clock: 'business' as const };
  it('adds within the same day', () => {
    // Wed 2026-09-30 10:00 CDT = 15:00Z, +120m → 12:00 CDT = 17:00Z
    expect(new Date(addCoveredMinutes(Date.parse('2026-09-30T15:00:00Z'), 120, sla)).toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });
  it('rolls over to next morning after close', () => {
    // 16:30 CDT + 120m → 30m today, 90m tomorrow from 08:00 → 09:30 CDT = 14:30Z
    expect(new Date(addCoveredMinutes(Date.parse('2026-09-30T21:30:00Z'), 120, sla)).toISOString()).toBe('2026-10-01T14:30:00.000Z');
  });
  it('skips the weekend', () => {
    // Fri 2026-10-02 16:30 CDT + 120m → Mon 09:30 CDT = 14:30Z
    expect(new Date(addCoveredMinutes(Date.parse('2026-10-02T21:30:00Z'), 120, sla)).toISOString()).toBe('2026-10-05T14:30:00.000Z');
  });
  it('is exact wall-clock for calendar SLAs', () => {
    expect(addCoveredMinutes(0, 60, emptyTerms(TZ).sla)).toBe(3_600_000);
  });
});

describe('evaluateJob', () => {
  it('returns null without a live contract', () => {
    expect(evaluateJob({ job: job({ customer_id: 'other' }), contracts: [contract], profiles: new Map(), equipment: [], responseMetAt: null })).toBeNull();
  });
  it('covers labor + parts → do not bill', () => {
    const r = run(terms(), job())!;
    expect(r.verdict).toBe('covered');
    expect(r.billing_action).toBe('do_not_bill');
    expect(r.action_line).toBe('Do not bill customer — covered under SLA.');
  });
  it('never says do-not-bill from unverified terms', () => {
    const r = run(terms(), job(), false)!;
    expect(r.billing_action).toBe('review');
    expect(r.flags).toContain('unverified_terms');
  });
  it('labor covered, parts billable → bill parts only', () => {
    const r = run(terms((t) => (t.responsibility.parts = 'customer')), job())!;
    expect(r.billing_action).toBe('bill_parts_only');
  });
  it('applies exclusions', () => {
    const r = run(terms((t) => (t.coverage.exclusions = [{ kind: 'keyword', value: 'vandalism' }])), job({ diagnosis_notes: 'Damage from Vandalism' }))!;
    expect(r.verdict).toBe('not_covered');
    expect(r.billing_action).toBe('bill_customer');
  });
  it('checks covered equipment types', () => {
    const t = terms((x) => {
      x.coverage.all_assets = false;
      x.coverage.equipment_types = ['rooftop unit'];
    });
    expect(run(t, job())!.verdict).toBe('needs_review');
    const eq = [{ id: 'e1', equipment_type: 'Water Heater', make: null, warranty_expires_at: null }];
    expect(run(t, job(), true, { equipment: eq })!.verdict).toBe('not_covered');
  });
  it('warranty_only parts follow equipment warranty', () => {
    const t = terms((x) => (x.responsibility.parts = 'warranty_only'));
    const eq = [{ id: 'e1', equipment_type: 'Furnace', make: null, warranty_expires_at: '2030-01-01' }];
    expect(run(t, job(), true, { equipment: eq })!.billing_action).toBe('do_not_bill');
  });
  it('computes the response deadline and countdown', () => {
    const r = run(terms((t) => (t.sla.response_standard_minutes = 240)), job())!;
    expect(r.response.status).toBe('pending');
    expect(r.response.deadline_at).toBe('2026-09-30T19:00:00.000Z');
    expect(formatCountdown(r.response.remaining_ms!)).toBe('3h 30m');
  });
  it('emergency uses the critical target and flags breach', () => {
    const r = run(terms(), job({ is_emergency: true }), true, { now: new Date('2026-09-30T17:00:00.000Z') })!;
    expect(r.priority).toBe('emergency');
    expect(r.response.status).toBe('breached');
    expect(r.flags).toContain('sla_breached');
  });
  it('marks a met response', () => {
    const r = run(terms(), job({ job_status: 'en_route' }), true, { responseMetAt: '2026-09-30T15:20:00.000Z' })!;
    expect(r.response.status).toBe('met');
  });
});

describe('computePenaltyCents', () => {
  it('percent of invoice, per interval, capped by contract %', () => {
    const t = terms((x) => {
      x.sla.penalty_type = 'percent_of_invoice';
      x.sla.penalty_amount = 10;
      x.sla.penalty_interval_minutes = 60;
    });
    expect(computePenaltyCents(contract, t, 500, 90)).toBe(10_000); // 2 × $50 = $100
    expect(computePenaltyCents(contract, t, 500_000, 90)).toBe(200_000); // capped at 20% of $10,000
  });
});

describe('normalizeTerms', () => {
  it('clamps garbage and keeps valid data', () => {
    const t = normalizeTerms({ sla: { response_emergency_minutes: -5, penalty_type: 'nope', timezone: 'Mars/Base', business_start: '25:00' }, responsibility: { labor: 'contractor' } }, TZ);
    expect(t.sla.response_emergency_minutes).toBeNull();
    expect(t.sla.penalty_type).toBe('none');
    expect(t.sla.timezone).toBe(TZ);
    expect(t.sla.business_start).toBe('08:00');
    expect(t.responsibility.labor).toBe('contractor');
  });
});
