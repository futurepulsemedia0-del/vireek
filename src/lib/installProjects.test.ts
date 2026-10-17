import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROJECT_FORM,
  addDaysIso,
  billingBalance,
  billingRowStatus,
  billingSummary,
  buildRollup,
  centsToDollarsInput,
  dollarsToCents,
  drawAmounts,
  friendlyError,
  marginForecast,
  materialsSummary,
  nextPendingMilestone,
  phaseProgress,
  projectProgress,
  remainingBillablePercent,
  scheduleHealth,
  templateFor,
  validateProjectForm,
  type InstallProject,
  type InvoiceLite,
  type ProjectBilling,
  type ProjectMaterial,
  type ProjectMilestone,
  type ProjectPhase,
} from '@/lib/installProjects';

const TODAY = '2027-03-10';

const project = (over: Partial<InstallProject> = {}): InstallProject => ({
  id: 'p1',
  user_id: 'u1',
  project_number: 'PRJ-0001',
  name: 'Full system replacement',
  customer_id: null,
  quote_id: null,
  customer_name: 'Ada Lovelace',
  site_address: null,
  project_type: 'hvac',
  status: 'active',
  contract_value_cents: 2_000_000,
  estimated_labor_cost_cents: 400_000,
  retainage_percent: 10,
  start_date: '2027-03-01',
  target_end_date: '2027-03-31',
  completed_at: null,
  retainage_invoice_id: null,
  notes: null,
  created_at: '2027-02-20T00:00:00Z',
  updated_at: '2027-02-20T00:00:00Z',
  ...over,
});

const phase = (id: string, weight: number, status: ProjectPhase['status'] = 'not_started', sort = 0): ProjectPhase => ({
  id,
  project_id: 'p1',
  name: id,
  description: null,
  sort_order: sort,
  weight,
  status,
  planned_start: null,
  planned_end: null,
  actual_start: null,
  actual_end: null,
});

const ms = (id: string, phase_id: string, status: ProjectMilestone['status'], due_date: string | null = null, sort = 0): ProjectMilestone => ({
  id,
  project_id: 'p1',
  phase_id,
  title: id,
  kind: 'task',
  status,
  due_date,
  sort_order: sort,
  notes: null,
  completed_at: null,
});

const draw = (id: string, percent: number, invoice_id: string | null = null, retainage = 0, gross: number | null = null): ProjectBilling => ({
  id,
  project_id: 'p1',
  phase_id: null,
  milestone_id: null,
  label: id,
  percent_of_contract: percent,
  due_date: null,
  sort_order: 0,
  invoice_id,
  invoiced_gross_cents: gross,
  retainage_withheld_cents: retainage,
  invoiced_at: null,
});

const inv = (id: string, status: string, due_date: string | null = null): InvoiceLite => ({ id, invoice_number: id, status, due_date });

describe('progress', () => {
  it('computes phase progress from milestones and ignores skipped ones', () => {
    const m = [ms('a', 'ph1', 'done'), ms('b', 'ph1', 'pending'), ms('c', 'ph1', 'skipped')];
    expect(phaseProgress(phase('ph1', 1), m)).toBe(50);
    expect(phaseProgress(phase('ph2', 1), m)).toBe(0);
    expect(phaseProgress(phase('ph1', 1, 'completed'), m)).toBe(100);
  });

  it('weights phases and forces 100 when completed', () => {
    const phases = [phase('ph1', 1), phase('ph2', 3)];
    const m = [ms('a', 'ph1', 'done'), ms('b', 'ph2', 'done'), ms('c', 'ph2', 'pending')];
    // (1*100 + 3*50) / 4 = 62.5 → 63
    expect(projectProgress(project(), phases, m)).toBe(63);
    expect(projectProgress(project({ status: 'completed' }), phases, m)).toBe(100);
    expect(projectProgress(project(), [], [])).toBe(0);
  });
});

describe('scheduleHealth', () => {
  const phases = [phase('ph1', 1)];

  it('maps non-active statuses directly', () => {
    expect(scheduleHealth(project({ status: 'completed' }), phases, [], TODAY).state).toBe('done');
    expect(scheduleHealth(project({ status: 'on_hold' }), phases, [], TODAY).state).toBe('paused');
    expect(scheduleHealth(project({ status: 'planning' }), phases, [], TODAY).state).toBe('not_started');
    expect(scheduleHealth(project({ status: 'cancelled' }), phases, [], TODAY).state).toBe('cancelled');
  });

  it('flags overdue milestones as late', () => {
    const h = scheduleHealth(project(), phases, [ms('a', 'ph1', 'pending', '2027-03-05')], TODAY);
    expect(h.state).toBe('late');
    expect(h.overdueMilestones).toBe(1);
  });

  it('flags a passed target date as late', () => {
    const h = scheduleHealth(project({ target_end_date: '2027-03-08' }), phases, [], TODAY);
    expect(h.state).toBe('late');
    expect(h.daysToTarget).toBe(-2);
  });

  it('flags a close target with low progress as at risk', () => {
    const m = [ms('a', 'ph1', 'pending', '2027-03-20')];
    const h = scheduleHealth(project({ target_end_date: '2027-03-15' }), phases, m, TODAY);
    expect(h.state).toBe('at_risk');
  });

  it('flags progress lagging behind elapsed time and otherwise reports on track', () => {
    const lagging = scheduleHealth(project({ start_date: '2027-02-10', target_end_date: '2027-04-10' }), phases, [ms('a', 'ph1', 'pending', '2027-04-01')], TODAY);
    expect(lagging.state).toBe('at_risk');
    const ok = scheduleHealth(project(), phases, [ms('a', 'ph1', 'done'), ms('b', 'ph1', 'pending', '2027-03-20')], TODAY);
    expect(ok.state).toBe('on_track');
  });
});

describe('progress billing', () => {
  it('splits a draw into gross, retainage and net', () => {
    expect(drawAmounts(2_000_000, 10, 30)).toEqual({ grossCents: 600_000, retainageCents: 60_000, netCents: 540_000 });
    expect(drawAmounts(2_000_000, 0, 33.333).grossCents).toBe(666_660);
  });

  it('derives row status from the live invoice', () => {
    const invoices = { i1: inv('i1', 'paid'), i2: inv('i2', 'sent', '2027-03-01'), i3: inv('i3', 'sent', '2027-04-01'), i4: inv('i4', 'void') };
    expect(billingRowStatus(draw('a', 10), invoices, TODAY)).toBe('scheduled');
    expect(billingRowStatus(draw('a', 10, 'i1'), invoices, TODAY)).toBe('paid');
    expect(billingRowStatus(draw('a', 10, 'i2'), invoices, TODAY)).toBe('overdue');
    expect(billingRowStatus(draw('a', 10, 'i3'), invoices, TODAY)).toBe('invoiced');
    expect(billingRowStatus(draw('a', 10, 'i4'), invoices, TODAY)).toBe('scheduled');
    expect(billingRowStatus(draw('a', 10, 'missing'), invoices, TODAY)).toBe('scheduled');
  });

  it('summarises invoiced, paid, outstanding, overdue and retainage', () => {
    const invoices = { i1: inv('i1', 'paid'), i2: inv('i2', 'sent', '2027-03-01'), i4: inv('i4', 'void') };
    const rows = [
      draw('deposit', 30, 'i1', 60_000, 600_000),
      draw('rough-in', 40, 'i2', 80_000, 800_000),
      draw('void-draw', 10, 'i4', 20_000, 200_000),
      draw('final', 20),
    ];
    const s = billingSummary(project(), rows, invoices, TODAY);
    expect(s.invoicedGrossCents).toBe(1_400_000);
    expect(s.paidCents).toBe(540_000);
    expect(s.outstandingCents).toBe(720_000);
    expect(s.overdueCents).toBe(720_000);
    expect(s.retainageHeldCents).toBe(140_000);
    expect(s.scheduledPercent).toBe(100);
    expect(s.unscheduledPercent).toBe(0);
    expect(s.billedPercent).toBeCloseTo(70, 5);
    expect(s.retainageReleased).toBe(false);
  });

  it('treats retainage as released once the release invoice is live', () => {
    const invoices = { r1: inv('r1', 'sent', '2027-05-01'), i1: inv('i1', 'paid') };
    const s = billingSummary(project({ retainage_invoice_id: 'r1' }), [draw('a', 50, 'i1', 100_000, 1_000_000)], invoices, TODAY);
    expect(s.retainageReleased).toBe(true);
    expect(s.retainageHeldCents).toBe(0);
  });

  it('tracks the unscheduled remainder', () => {
    expect(remainingBillablePercent([draw('a', 30), draw('b', 40)])).toBe(30);
    expect(remainingBillablePercent([draw('a', 100)])).toBe(0);
    expect(remainingBillablePercent([])).toBe(100);
  });

  it('compares billing with physical progress', () => {
    expect(billingBalance(70, 30)).toEqual({ state: 'ahead', gap: 40 });
    expect(billingBalance(10, 50)).toEqual({ state: 'behind', gap: -40 });
    expect(billingBalance(40, 45).state).toBe('balanced');
  });
});

describe('materials and margin', () => {
  const mat = (id: string, quantity: number, unit_cost_cents: number, status: ProjectMaterial['status']): ProjectMaterial => ({
    id,
    project_id: 'p1',
    phase_id: null,
    part_id: null,
    description: id,
    quantity,
    unit_label: null,
    unit_cost_cents,
    vendor: null,
    status,
    expected_date: null,
    notes: null,
  });

  it('totals material cost by status', () => {
    const s = materialsSummary([mat('coil', 2, 45_000, 'ordered'), mat('line-set', 1.5, 10_000, 'planned'), mat('pad', 1, 5_000, 'planned')]);
    expect(s.totalCents).toBe(110_000);
    expect(s.byStatus.planned).toEqual({ count: 2, cents: 20_000 });
    expect(s.byStatus.ordered).toEqual({ count: 1, cents: 90_000 });
    expect(s.lineCount).toBe(3);
  });

  it('forecasts margin levels', () => {
    const healthy = marginForecast(project(), 600_000);
    expect(healthy.marginCents).toBe(1_000_000);
    expect(healthy.marginPercent).toBeCloseTo(50, 5);
    expect(healthy.level).toBe('healthy');
    expect(marginForecast(project(), 1_300_000).level).toBe('thin');
    expect(marginForecast(project(), 1_500_000).level).toBe('at_risk');
    expect(marginForecast(project({ contract_value_cents: 0 }), 0).level).toBe('unknown');
  });
});

describe('templates, rollups and milestones', () => {
  it('ships templates whose draws add up to 100% and point at real phases', () => {
    for (const type of ['hvac', 'plumbing', 'electrical', 'solar', 'roofing', 'water_heater', 'other'] as const) {
      const t = templateFor(type);
      expect(t.draws.reduce((s, d) => s + d.percent, 0)).toBe(100);
      for (const d of t.draws) {
        if (d.phaseIndex !== null) expect(d.phaseIndex < t.phases.length).toBe(true);
      }
      expect(t.phases.every((p) => p.milestones.length > 0)).toBe(true);
    }
  });

  it('picks the next pending milestone by due date, undated last', () => {
    const phases = [phase('ph1', 1, 'not_started', 0), phase('ph2', 1, 'not_started', 1)];
    const m = [ms('undated', 'ph1', 'pending'), ms('later', 'ph1', 'pending', '2027-04-01'), ms('soon', 'ph2', 'pending', '2027-03-12'), ms('done', 'ph1', 'done', '2027-03-01')];
    expect(nextPendingMilestone(phases, m)?.title).toBe('soon');
    expect(nextPendingMilestone(phases, [])).toBeNull();
  });

  it('builds a rollup from the pure helpers', () => {
    const r = buildRollup(project(), [phase('ph1', 1)], [ms('a', 'ph1', 'done'), ms('b', 'ph1', 'pending', '2027-03-20')], [draw('d', 100)], {}, TODAY);
    expect(r.progress).toBe(50);
    expect(r.schedule.state).toBe('on_track');
    expect(r.billing.scheduledPercent).toBe(100);
    expect(r.nextMilestone?.title).toBe('b');
  });
});

describe('forms and errors', () => {
  it('parses dollars to cents strictly', () => {
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents('$18,500.50')).toBe(1_850_050);
    expect(dollarsToCents('12.5')).toBe(1250);
    expect(dollarsToCents('12.555')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(centsToDollarsInput(1_850_000)).toBe('18500');
    expect(centsToDollarsInput(1_850_050)).toBe('18500.50');
  });

  it('validates the new-project form', () => {
    expect(Object.keys(validateProjectForm(EMPTY_PROJECT_FORM)).sort()).toEqual(['customerName', 'name']);
    const bad = validateProjectForm({ ...EMPTY_PROJECT_FORM, name: 'x', customerName: 'y', contractValue: '1,2x', retainagePercent: '40', startDate: '2027-03-10', targetEndDate: '2027-03-01' });
    expect(Object.keys(bad).sort()).toEqual(['contractValue', 'retainagePercent', 'targetEndDate']);
    expect(validateProjectForm({ ...EMPTY_PROJECT_FORM, name: 'x', customerName: 'y', contractValue: '18500', retainagePercent: '5' })).toEqual({});
  });

  it('turns database errors into friendly copy', () => {
    expect(friendlyError({ message: 'billing_exceeds_contract' }, 'x')).toBe('Billing steps cannot add up to more than 100% of the contract.');
    expect(friendlyError(new Error('boom already_invoiced'), 'x')).toBe('This billing step already has an open invoice.');
    expect(friendlyError({ message: 'duplicate key value violates unique constraint "install_project_jobs_job_id_key"' }, 'x')).toBe('That job is already linked to a project.');
    expect(friendlyError(null, 'fallback')).toBe('fallback');
  });

  it('adds calendar days across month and year boundaries', () => {
    expect(addDaysIso('2027-03-10', 14)).toBe('2027-03-24');
    expect(addDaysIso('2027-12-25', 14)).toBe('2028-01-08');
    expect(addDaysIso('2028-02-20', 10)).toBe('2028-03-01');
  });
});
