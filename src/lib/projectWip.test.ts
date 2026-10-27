import { describe, expect, it } from 'vitest';
import type { InstallProject, InvoiceLite, ProjectBilling, ProjectMaterial, ProjectMilestone, ProjectPhase } from '@/lib/installProjects';
import { WIP_CSV_COLUMNS, buildWipReport, wipCsvFilename, wipToCsv, type WipCostEntry, type WipInput } from '@/lib/projectWip';

// Every expected number below was worked out by hand — see the comment above each describe().

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
  contract_value_cents: 2_000_000, // $20,000
  estimated_labor_cost_cents: 400_000, // $4,000
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

const material = (id: string, quantity: number, unit_cost_cents: number, status: ProjectMaterial['status']): ProjectMaterial => ({
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

const phase = (id: string, weight: number): ProjectPhase => ({
  id,
  project_id: 'p1',
  name: id,
  description: null,
  sort_order: 0,
  weight,
  status: 'in_progress',
  planned_start: null,
  planned_end: null,
  actual_start: null,
  actual_end: null,
});

const ms = (id: string, status: ProjectMilestone['status']): ProjectMilestone => ({
  id,
  project_id: 'p1',
  phase_id: 'ph1',
  title: id,
  kind: 'task',
  status,
  due_date: null,
  sort_order: 0,
  notes: null,
  completed_at: null,
});

const draw = (id: string, percent: number, invoice_id: string, retainage: number): ProjectBilling => ({
  id,
  project_id: 'p1',
  phase_id: null,
  milestone_id: null,
  label: id,
  percent_of_contract: percent,
  due_date: null,
  sort_order: 0,
  invoice_id,
  invoiced_gross_cents: null,
  retainage_withheld_cents: retainage,
  invoiced_at: null,
});

const invoices: Record<string, InvoiceLite> = {
  i1: { id: 'i1', invoice_number: 'INV-1', status: 'paid', due_date: null },
  i2: { id: 'i2', invoice_number: 'INV-2', status: 'sent', due_date: '2027-04-30' },
};

const entries: WipCostEntry[] = [
  { job_id: 'j1', category: 'labor', total_cost_cents: 250_000 },
  { job_id: 'j1', category: 'subcontractor', total_cost_cents: 150_000 },
];

// Base case.
//   Budget  = labor 400,000 + materials (400,000 + 400,000) = 1,200,000
//   Cost    = job entries 400,000 + expenses 40,000 + installed materials 400,000 = 840,000
//             (the 'ordered' 400,000 line is NOT incurred yet)
//   Billing = 30% → 600,000 and 50% → 1,000,000 gross = 1,600,000
//             collected (paid, net of 60,000 retainage) = 540,000
//             outstanding (sent, net of 100,000 retainage) = 900,000
//             retainage held = 160,000
const input = (over: Partial<WipInput> = {}): WipInput => ({
  project: project(),
  phases: [phase('ph1', 1)],
  milestones: [ms('a', 'done'), ms('b', 'done'), ms('c', 'pending'), ms('d', 'pending')], // 50%
  billing: [draw('d1', 30, 'i1', 60_000), draw('d2', 50, 'i2', 100_000)],
  materials: [material('m1', 4, 100_000, 'installed'), material('m2', 2, 200_000, 'ordered')],
  invoices,
  costEntries: entries,
  expenseCents: 40_000,
  expensesAvailable: true,
  linkedJobCount: 1,
  today: TODAY,
  ...over,
});

// Cost-to-cost: 840,000 / 1,200,000 = 70%
//   earned          = 2,000,000 × 70% = 1,400,000
//   overbilled      = 1,600,000 − 1,400,000 = 200,000
//   projected cost  = 840,000 + (1,200,000 − 840,000) = 1,200,000
//   projected profit= 800,000  → 40% margin (= bid margin, so delta 0)
//   profit to date  = 1,400,000 − 840,000 = 560,000
//   cost to complete= 360,000 ; backlog = 600,000
describe('buildWipReport — cost-to-cost', () => {
  const r = buildWipReport(input());

  it('adds job costs, approved expenses and received materials into cost to date', () => {
    expect(r.jobCostCents).toBe(400_000);
    expect(r.expensesCents).toBe(40_000);
    expect(r.projectMaterialsCents).toBe(400_000);
    expect(r.costToDateCents).toBe(840_000);
    expect(r.costByCategory.labor).toBe(250_000);
    expect(r.costByCategory.subcontractor).toBe(150_000);
    expect(r.budgetCents).toBe(1_200_000);
  });

  it('derives % complete and earned revenue', () => {
    expect(r.method).toBe('cost');
    expect(r.percentComplete).toBe(70);
    expect(r.earnedRevenueCents).toBe(1_400_000);
    expect(r.backlogCents).toBe(600_000);
  });

  it('reports over/under billing', () => {
    expect(r.billedToDateCents).toBe(1_600_000);
    expect(r.overbilledCents).toBe(200_000);
    expect(r.underbilledCents).toBe(0);
    expect(r.billingPosition).toBe('over');
    expect(r.collectedCents).toBe(540_000);
    expect(r.outstandingCents).toBe(900_000);
    expect(r.retainageHeldCents).toBe(160_000);
  });

  it('projects cost, profit and margin', () => {
    expect(r.grossProfitToDateCents).toBe(560_000);
    expect(r.costToCompleteCents).toBe(360_000);
    expect(r.projectedCostCents).toBe(1_200_000);
    expect(r.projectedProfitCents).toBe(800_000);
    expect(r.projectedMarginPercent).toBe(40);
    expect(r.bidMarginPercent).toBe(40);
    expect(r.marginDeltaPoints).toBe(0);
    expect(r.lossProvisionCents).toBe(0);
    expect(r.warnings).toEqual([]);
  });
});

// Milestone method at 50%:
//   earned          = 2,000,000 × 50% = 1,000,000
//   earned value    = 1,200,000 × 50% = 600,000
//   projected cost  = 840,000 + (1,200,000 − 600,000) = 1,440,000
//   projected profit= 560,000 → 28% (bid 40% → delta −12 points)
//   profit to date  = 1,000,000 − 840,000 = 160,000
//   overbilled      = 1,600,000 − 1,000,000 = 600,000
describe('buildWipReport — milestone method', () => {
  const r = buildWipReport(input(), { method: 'milestone' });

  it('uses weighted milestone progress and exposes the overrun', () => {
    expect(r.method).toBe('milestone');
    expect(r.percentComplete).toBe(50);
    expect(r.earnedRevenueCents).toBe(1_000_000);
    expect(r.projectedCostCents).toBe(1_440_000);
    expect(r.costToCompleteCents).toBe(600_000);
    expect(r.projectedProfitCents).toBe(560_000);
    expect(r.projectedMarginPercent).toBe(28);
    expect(r.marginDeltaPoints).toBe(-12);
    expect(r.grossProfitToDateCents).toBe(160_000);
    expect(r.overbilledCents).toBe(600_000);
  });
});

// Loss contract (cost-to-cost): contract 1,000,000, budget 1,200,000, cost 600,000.
//   % complete = 50% → earned 500,000 → profit to date = −100,000
//   projected cost = 600,000 + 600,000 = 1,200,000 → projected profit = −200,000 (−20%)
//   provision = profit to date − projected profit = −100,000 − (−200,000) = 100,000
//   nothing billed → underbilled 500,000
describe('buildWipReport — loss contract', () => {
  const r = buildWipReport(
    input({
      project: project({ contract_value_cents: 1_000_000, estimated_labor_cost_cents: 1_200_000 }),
      materials: [],
      billing: [],
      costEntries: [{ job_id: 'j1', category: 'labor', total_cost_cents: 600_000 }],
      expenseCents: 0,
    }),
  );

  it('books the remaining loss as a provision', () => {
    expect(r.percentComplete).toBe(50);
    expect(r.earnedRevenueCents).toBe(500_000);
    expect(r.grossProfitToDateCents).toBe(-100_000);
    expect(r.projectedProfitCents).toBe(-200_000);
    expect(r.projectedMarginPercent).toBe(-20);
    expect(r.lossProvisionCents).toBe(100_000);
    expect(r.underbilledCents).toBe(500_000);
    expect(r.billingPosition).toBe('under');
  });
});

// Completed project: 100% complete, earned = contract, projected cost = actual cost.
//   profit = 2,000,000 − 840,000 = 1,160,000 → 58% ; underbilled = 2,000,000 − 1,600,000 = 400,000
describe('buildWipReport — completed project', () => {
  const r = buildWipReport(input({ project: project({ status: 'completed' }) }));

  it('recognises the full contract and zero cost to complete', () => {
    expect(r.percentComplete).toBe(100);
    expect(r.earnedRevenueCents).toBe(2_000_000);
    expect(r.projectedCostCents).toBe(840_000);
    expect(r.costToCompleteCents).toBe(0);
    expect(r.projectedProfitCents).toBe(1_160_000);
    expect(r.projectedMarginPercent).toBe(58);
    expect(r.underbilledCents).toBe(400_000);
    expect(r.lossProvisionCents).toBe(0);
  });
});

describe('buildWipReport — options and edge cases', () => {
  it('caps cost-to-cost at 100% when cost exceeds the budget', () => {
    // budget override 800,000 < cost 840,000 → 100%, earned = contract, projected cost = actual
    const r = buildWipReport(input(), { budgetOverrideCents: 800_000 });
    expect(r.percentComplete).toBe(100);
    expect(r.earnedRevenueCents).toBe(2_000_000);
    expect(r.projectedCostCents).toBe(840_000);
    expect(r.projectedProfitCents).toBe(1_160_000);
  });

  it('applies a budget override: 840,000 / 1,400,000 = 60%', () => {
    const r = buildWipReport(input(), { budgetOverrideCents: 1_400_000 });
    expect(r.percentComplete).toBe(60);
    expect(r.earnedRevenueCents).toBe(1_200_000);
    expect(r.projectedCostCents).toBe(1_400_000);
    expect(r.projectedMarginPercent).toBe(30);
  });

  it('ignores a zero or negative budget override', () => {
    expect(buildWipReport(input(), { budgetOverrideCents: 0 }).budgetCents).toBe(1_200_000);
    expect(buildWipReport(input(), { budgetOverrideCents: -5 }).budgetCents).toBe(1_200_000);
  });

  it('can leave delivered project materials out: 440,000 / 1,200,000 = 36.6667%', () => {
    const r = buildWipReport(input(), { includeProjectMaterials: false });
    expect(r.projectMaterialsCents).toBe(0);
    expect(r.costToDateCents).toBe(440_000);
    expect(r.percentComplete).toBe(36.6667);
    // 2,000,000 × 440,000 / 1,200,000 = 733,333.33 → 733,333
    expect(r.earnedRevenueCents).toBe(733_333);
  });

  it('falls back to milestones when there is no estimated cost', () => {
    const r = buildWipReport(input({ project: project({ estimated_labor_cost_cents: 0 }), materials: [], expenseCents: 0, costEntries: [{ job_id: 'j1', category: 'labor', total_cost_cents: 100_000 }] }));
    expect(r.methodRequested).toBe('cost');
    expect(r.method).toBe('milestone');
    expect(r.earnedRevenueCents).toBe(1_000_000);
    expect(r.projectedCostCents).toBe(100_000);
    expect(r.projectedProfitCents).toBe(1_900_000);
    expect(r.bidMarginPercent).toBeNull();
    expect(r.warnings.some((w) => w.includes('cost-to-cost cannot be measured'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('assumes no further cost'))).toBe(true);
  });

  it('normalises legacy categories and ignores non-numeric cents', () => {
    const r = buildWipReport(
      input({
        costEntries: [
          { job_id: 'j1', category: 'materials', total_cost_cents: 10_000 },
          { job_id: 'j1', category: 'permits', total_cost_cents: 5_000 },
          { job_id: 'j1', category: 'mystery', total_cost_cents: 1_000 },
          { job_id: 'j1', category: 'labor', total_cost_cents: Number.NaN },
        ],
      }),
    );
    expect(r.costByCategory.material).toBe(10_000);
    expect(r.costByCategory.permit).toBe(5_000);
    expect(r.costByCategory.other).toBe(1_000);
    expect(r.costByCategory.labor).toBe(0);
    expect(r.jobCostCents).toBe(16_000);
  });

  it('warns about possible double counting of materials', () => {
    const r = buildWipReport(input({ costEntries: [{ job_id: 'j1', category: 'material', total_cost_cents: 100_000 }] }));
    expect(r.warnings.some((w) => w.includes('twice'))).toBe(true);
  });

  it('warns when jobs are unlinked or expenses are unavailable', () => {
    const r = buildWipReport(input({ linkedJobCount: 0, expensesAvailable: false, costEntries: [], expenseCents: 0 }));
    expect(r.warnings.some((w) => w.includes('No jobs are linked'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('expense allocations could not be read'))).toBe(true);
  });

  it('handles a project with no contract value without dividing by zero', () => {
    const r = buildWipReport(input({ project: project({ contract_value_cents: 0 }) }));
    expect(r.earnedRevenueCents).toBe(0);
    expect(r.projectedMarginPercent).toBeNull();
    expect(r.bidMarginPercent).toBeNull();
    expect(r.marginDeltaPoints).toBeNull();
    expect(r.warnings.some((w) => w.includes('No contract value'))).toBe(true);
  });

  it('reports a balanced billing position when billed equals earned', () => {
    // 70% earned = 1,400,000 ; bill 70% as a single draw
    const r = buildWipReport(input({ billing: [draw('d1', 70, 'i1', 0)] }));
    expect(r.billedToDateCents).toBe(1_400_000);
    expect(r.billingPosition).toBe('balanced');
    expect(r.overbilledCents).toBe(0);
    expect(r.underbilledCents).toBe(0);
  });

  it('ignores voided invoices when measuring billings', () => {
    const r = buildWipReport(input({ invoices: { ...invoices, i2: { ...invoices.i2, status: 'void' } } }));
    // only the 30% draw (600,000) is live
    expect(r.billedToDateCents).toBe(600_000);
    expect(r.underbilledCents).toBe(800_000);
  });
});

describe('wipToCsv', () => {
  const report = buildWipReport(input());
  const [header, row] = wipToCsv([report]).split('\r\n');
  const cols = header.split(',');
  const cell = (name: string) => row.split(',')[cols.indexOf(name)];

  it('writes one header + one row with every column', () => {
    expect(cols).toHaveLength(WIP_CSV_COLUMNS.length);
    expect(row.split(',')).toHaveLength(WIP_CSV_COLUMNS.length);
    expect(wipToCsv([report, report]).split('\r\n')).toHaveLength(3);
  });

  it('writes dollars with two decimals and percentages with two decimals', () => {
    expect(cell('Contract value')).toBe('20000.00');
    expect(cell('Estimated total cost')).toBe('12000.00');
    expect(cell('Total cost to date')).toBe('8400.00');
    expect(cell('% complete')).toBe('70.00');
    expect(cell('Earned revenue')).toBe('14000.00');
    expect(cell('Billed to date')).toBe('16000.00');
    expect(cell('Overbilled')).toBe('2000.00');
    expect(cell('Underbilled')).toBe('0.00');
    expect(cell('Projected profit')).toBe('8000.00');
    expect(cell('Projected margin %')).toBe('40.00');
    expect(cell('Retainage held')).toBe('1600.00');
    expect(cell('Project #')).toBe('PRJ-0001');
    expect(cell('Method')).toBe('Cost-to-cost');
  });

  it('keeps negative numbers numeric and leaves blank margins empty', () => {
    const loss = buildWipReport(input({ project: project({ contract_value_cents: 0 }) }));
    const [h, r] = wipToCsv([loss]).split('\r\n');
    const c = h.split(',');
    expect(r.split(',')[c.indexOf('Projected margin %')]).toBe('');
    expect(r.split(',')[c.indexOf('Projected profit')]).toBe('-12000.00');
  });

  it('quotes commas and quotes, and neutralises spreadsheet formulas', () => {
    const csv = wipToCsv([{ ...report, projectName: '=HYPERLINK("x")', customerName: 'Smith, Jane' }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"Smith, Jane"');
  });

  it('builds a safe filename', () => {
    expect(wipCsvFilename({ projectNumber: 'PRJ-0001', projectName: 'x', asOf: TODAY })).toBe('wip-PRJ-0001-2027-03-10.csv');
    expect(wipCsvFilename({ projectNumber: null, projectName: 'Main St. / HVAC', asOf: TODAY })).toBe('wip-Main-St-HVAC-2027-03-10.csv');
  });
});
