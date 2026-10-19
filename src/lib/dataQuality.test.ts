import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  assembleHealth,
  buildCostCheck,
  buildCustomerChecks,
  buildDimensions,
  buildEquipmentCheck,
  gradeFor,
  mergeFixes,
  planCustomerBackfill,
  planEquipmentLink,
  scoreFromDimensions,
  type CustomerRow,
  type DqFix,
  type EquipmentRow,
  type JobRow,
  type LeadRow,
} from './dataQuality';
import type { RealityReport } from './businessReality';

const customer = (o: Partial<CustomerRow> = {}): CustomerRow => ({
  id: 'c1', name: 'Ann', phone: '555-0100', email: 'ann@x.com', address: '1 Main St', marketing_opt_in: true, ...o,
});
const job = (o: Partial<JobRow> = {}): JobRow => ({
  id: 'j1', customer_id: 'c1', customer_name: 'Ann', address: '9 Oak Ave', job_status: 'completed',
  scheduled_datetime: '2027-01-10T10:00:00Z', created_at: '2027-01-01T00:00:00Z', ...o,
});
const lead = (o: Partial<LeadRow> = {}): LeadRow => ({ customer_id: 'c1', phone: '555-0199', email: 'lead@x.com', created_at: '2027-01-02T00:00:00Z', ...o });
const equip = (o: Partial<EquipmentRow> = {}): EquipmentRow => ({
  id: 'e1', customer_id: 'c1', equipment_type: 'furnace', make: 'Trane', model: 'XR95', install_job_id: null, ...o,
});
const noTaken = { phones: new Set<string>(), emails: new Set<string>() };
const reality = (score: number): RealityReport => ({ score, generatedAt: '', findings: [], domainCompleteness: { billingPct: null, dispatchPct: null } });

describe('planCustomerBackfill', () => {
  it('takes the address from the newest job that has one', () => {
    const c = customer({ address: '  ' });
    const jobs = [job({ id: 'a', address: 'Old St', scheduled_datetime: '2026-01-01T00:00:00Z' }), job({ id: 'b', address: 'New St' }), job({ id: 'c', address: null })];
    expect(planCustomerBackfill(c, jobs, [], noTaken)).toEqual({ address: 'New St' });
  });

  it('takes phone and email from the newest lead of the same customer only', () => {
    const c = customer({ phone: null, email: '' });
    const leads = [lead({ phone: '555-1111', created_at: '2026-01-01T00:00:00Z' }), lead({ phone: '555-2222' }), lead({ customer_id: 'other', phone: '555-9999' })];
    expect(planCustomerBackfill(c, [], leads, noTaken)).toEqual({ phone: '555-2222', email: 'lead@x.com' });
  });

  it('never copies a phone or email that belongs to another customer', () => {
    const c = customer({ phone: null, email: null });
    const taken = { phones: new Set(['5550199']), emails: new Set(['lead@x.com']) };
    expect(planCustomerBackfill(c, [], [lead()], taken)).toEqual({});
  });

  it('rejects junk values', () => {
    const c = customer({ phone: null, email: null });
    expect(planCustomerBackfill(c, [], [lead({ phone: '12', email: 'not-an-email' })], noTaken)).toEqual({});
  });
});

describe('planEquipmentLink', () => {
  it('picks the newest non-cancelled job of the same customer', () => {
    const jobs = [job({ id: 'old', scheduled_datetime: '2026-01-01T00:00:00Z' }), job({ id: 'new' }), job({ id: 'x', job_status: 'cancelled', scheduled_datetime: '2028-01-01T00:00:00Z' }), job({ id: 'z', customer_id: 'c2' })];
    expect(planEquipmentLink(equip(), jobs)).toBe('new');
  });
  it('returns null when the customer has no usable job', () => {
    expect(planEquipmentLink(equip(), [job({ job_status: 'cancelled' })])).toBeNull();
  });
});

describe('buildCustomerChecks', () => {
  it('flags missing phone/address/email and counts every record', () => {
    const customers = [customer({ id: 'a', phone: null }), customer({ id: 'b', phone: ' ' }), customer({ id: 'c', address: null, email: null })];
    const checks = buildCustomerChecks({ customers, jobs: [], leads: [], consentEvidenceIds: new Set() });
    const byKind = Object.fromEntries(checks.map((c) => [c.kind, c.count]));
    expect(byKind).toMatchObject({ missing_phone: 2, missing_address: 1, missing_email: 1 });
  });

  it('offers a one-click backfill only where data exists, otherwise a link to the customer', () => {
    const customers = [customer({ id: 'a', address: null }), customer({ id: 'b', address: null })];
    const jobs = [job({ customer_id: 'a', address: 'Found St' })];
    const [check] = buildCustomerChecks({ customers, jobs, leads: [], consentEvidenceIds: new Set() });
    expect(check.fixable).toBe(1);
    expect(check.issues.find((i) => i.id.endsWith(':a'))?.fix?.type).toBe('backfill_customer');
    expect(check.issues.find((i) => i.id.endsWith(':b'))?.fix?.type).toBe('open');
  });

  it('keeps bulkFixes complete even when the visible sample is capped', () => {
    const customers = Array.from({ length: 40 }, (_, i) => customer({ id: `c${i}`, address: null }));
    const jobs = customers.map((c) => job({ id: `j${c.id}`, customer_id: c.id }));
    const [check] = buildCustomerChecks({ customers, jobs, leads: [], consentEvidenceIds: new Set() });
    expect(check.count).toBe(40);
    expect(check.issues).toHaveLength(25);
    expect(check.bulkFixes).toHaveLength(40);
  });

  it('judges consent only for reachable customers and accepts opt-in or customer-recorded evidence', () => {
    const customers = [
      customer({ id: 'a', marketing_opt_in: false }),
      customer({ id: 'b', marketing_opt_in: true }),
      customer({ id: 'c', marketing_opt_in: false }),
      customer({ id: 'd', marketing_opt_in: false, phone: null, email: null }),
    ];
    const checks = buildCustomerChecks({ customers, jobs: [], leads: [], consentEvidenceIds: new Set(['c']) });
    const consent = checks.find((c) => c.kind === 'no_consent');
    expect(consent?.count).toBe(1);
    expect(consent?.issues[0].fix).toEqual({ type: 'consent_link', customerId: 'a' });
    expect(consent?.fixable).toBe(0); // consent is never auto-granted
  });

  it('returns nothing for a clean account', () => {
    expect(buildCustomerChecks({ customers: [customer()], jobs: [], leads: [], consentEvidenceIds: new Set() })).toEqual([]);
  });
});

describe('equipment and cost checks', () => {
  it('flags only active equipment with no job link and no install job', () => {
    const list = [equip({ id: 'e1' }), equip({ id: 'e2' }), equip({ id: 'e3', install_job_id: 'j9' })];
    const check = buildEquipmentCheck(list, new Set(['e2']), [job()], new Map([['c1', 'Ann']]));
    expect(check?.count).toBe(1);
    expect(check?.bulkFixes).toEqual([{ type: 'link_equipment', equipmentId: 'e1', jobId: 'j1' }]);
  });
  it('returns null when every unit is matched', () => {
    expect(buildEquipmentCheck([equip()], new Set(['e1']), [], new Map())).toBeNull();
  });
  it('flags completed jobs with zero cost entries and offers no auto-fix', () => {
    const check = buildCostCheck([{ job_id: 'j1', customer_name: 'Ann', cost_entry_count: 0 }, { job_id: 'j2', customer_name: 'Bo', cost_entry_count: 3 }]);
    expect(check?.count).toBe(1);
    expect(check?.fixable).toBe(0);
    expect(check?.issues[0].fix).toMatchObject({ type: 'open', href: '/dashboard/jobs/j1' });
  });
  it('returns null when every completed job has costs', () => {
    expect(buildCostCheck([{ job_id: 'j2', customer_name: 'Bo', cost_entry_count: 1 }])).toBeNull();
  });
});

describe('mergeFixes', () => {
  it('merges several backfills for one customer into a single write', () => {
    const fixes: DqFix[] = [
      { type: 'backfill_customer', customerId: 'a', patch: { phone: '1' } },
      { type: 'backfill_customer', customerId: 'a', patch: { email: 'e@x.com' } },
      { type: 'link_equipment', equipmentId: 'e', jobId: 'j' },
    ];
    const out = mergeFixes(fixes);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: 'backfill_customer', customerId: 'a', patch: { phone: '1', email: 'e@x.com' } });
  });
  it('does not mutate its input', () => {
    const a: DqFix = { type: 'backfill_customer', customerId: 'a', patch: { phone: '1' } };
    mergeFixes([a, { type: 'backfill_customer', customerId: 'a', patch: { email: 'e' } }]);
    expect(a.patch).toEqual({ phone: '1' });
  });
});

describe('scoring', () => {
  const totals = { contact: { total: 0, bad: 0 }, equipment: { total: 0, bad: 0 }, costing: { total: 0, bad: 0 }, consent: { total: 0, bad: 0 } };

  it('is 100 when there is nothing to judge', () => {
    expect(scoreFromDimensions(buildDimensions(totals, null))).toBe(100);
  });
  it('leaves empty dimensions out and re-normalises weights', () => {
    const dims = buildDimensions({ ...totals, costing: { total: 10, bad: 5 } }, null);
    expect(scoreFromDimensions(dims)).toBe(50);
  });
  it('weights dimensions (contact 25, costing 20 → (100*25 + 0*20) / 45)', () => {
    const dims = buildDimensions({ ...totals, contact: { total: 10, bad: 0 }, costing: { total: 10, bad: 10 } }, null);
    expect(scoreFromDimensions(dims)).toBe(56);
  });
  it('reuses the Business Reality score as a dimension', () => {
    const dims = buildDimensions(totals, reality(80));
    expect(dims.find((d) => d.dimension === 'reality')?.pct).toBe(80);
    expect(scoreFromDimensions(dims)).toBe(80);
  });
  it('clamps bad > total', () => {
    const dims = buildDimensions({ ...totals, contact: { total: 3, bad: 99 } }, null);
    expect(dims[0].pct).toBe(0);
  });
  it('grades at the boundaries', () => {
    expect([gradeFor(90), gradeFor(89), gradeFor(75), gradeFor(55), gradeFor(54)]).toEqual(['excellent', 'good', 'good', 'fair', 'poor']);
  });
});

describe('assembleHealth', () => {
  it('scores contact per field (3 per customer) and sorts high severity first', () => {
    const customers = [customer({ id: 'a', phone: null, email: null }), customer({ id: 'b' })];
    const checks = [
      ...buildCustomerChecks({ customers, jobs: [], leads: [], consentEvidenceIds: new Set() }),
    ];
    const cost = buildCostCheck([{ job_id: 'j', customer_name: 'Ann', cost_entry_count: 0 }]);
    if (cost) checks.push(cost);
    const health = assembleHealth({
      customerCount: 2, reachableCount: 2, equipmentCount: 0, completedJobCount: 1, checks, reality: null, truncated: false, now: new Date('2027-02-01T00:00:00Z'),
    });
    const contact = health.dimensions.find((d) => d.dimension === 'contact');
    expect(contact).toMatchObject({ total: 6, bad: 2, pct: 67 });
    expect(health.checks[0].severity).toBe('high');
    expect(health.generatedAt).toBe('2027-02-01T00:00:00.000Z');
    expect(health.score).toBeGreaterThanOrEqual(0);
    expect(health.score).toBeLessThanOrEqual(100);
  });
});
