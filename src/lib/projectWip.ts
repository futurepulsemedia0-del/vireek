// Project WIP (work-in-progress) report — pure calculations + CSV.
//
// No Supabase import on purpose: everything here is deterministic and unit
// tested (projectWip.test.ts). Database access lives in projectWipApi.ts.
//
// All money is integer cents. Rounding happens exactly once per figure
// (Math.round on the final cents value) so results are hand-checkable.
//
// Method (percentage-of-completion, ASC 606 input/output methods):
//   cost      % complete = cost to date ÷ estimated total cost (capped at 100%)
//   milestone % complete = weighted milestone progress (same figure as Overview)
//   earned revenue        = contract value × % complete
//   billings in excess    = billed − earned   (overbilled, a liability)
//   earnings in excess    = earned − billed   (underbilled, an asset)
//   projected total cost  = cost to date + max(0, estimate − earned-value of estimate)
//   projected profit      = contract value − projected total cost
//   loss provision        = when projected profit < 0, the extra loss that must be
//                           booked now (ASC 605-35 / 606 onerous-contract rule)

import type { CostCategory } from '@/lib/jobCosting';
import {
  billingSummary,
  materialLineCents,
  materialsSummary,
  projectProgress,
  type InstallProject,
  type InvoiceLite,
  type ProjectBilling,
  type ProjectMaterial,
  type ProjectMilestone,
  type ProjectPhase,
} from '@/lib/installProjects';

export type WipMethod = 'cost' | 'milestone';
export type BillingPosition = 'over' | 'under' | 'balanced';

export const WIP_METHOD_LABEL: Record<WipMethod, string> = {
  cost: 'Cost-to-cost',
  milestone: 'Milestone progress',
};

export const WIP_CATEGORIES: CostCategory[] = ['labor', 'material', 'equipment', 'subcontractor', 'permit', 'other'];

/** The slice of a job_cost_entries row the report needs. */
export interface WipCostEntry {
  job_id: string;
  category: CostCategory | string;
  total_cost_cents: number;
}

export interface WipInput {
  project: InstallProject;
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  billing: ProjectBilling[];
  materials: ProjectMaterial[];
  invoices: Record<string, InvoiceLite>;
  /** job_cost_entries for every job linked to the project. */
  costEntries: WipCostEntry[];
  /** Approved expense allocations on linked jobs (cents). */
  expenseCents?: number;
  /** false when the expense view could not be read (shown as a warning). */
  expensesAvailable?: boolean;
  linkedJobCount: number;
  today: string;
}

export interface WipOptions {
  method?: WipMethod;
  /** Count delivered / installed project materials as incurred cost. Default true. */
  includeProjectMaterials?: boolean;
  /** Overrides the estimated total cost (budget). Ignored unless > 0. */
  budgetOverrideCents?: number | null;
}

export interface WipReport {
  projectId: string;
  projectNumber: string | null;
  projectName: string;
  customerName: string;
  status: InstallProject['status'];
  asOf: string;
  methodRequested: WipMethod;
  method: WipMethod;

  contractCents: number;
  /** Estimated total cost at completion (the budget the % complete is measured against). */
  budgetCents: number;
  bidMarginPercent: number | null;

  percentComplete: number;
  earnedRevenueCents: number;
  backlogCents: number;

  costByCategory: Record<CostCategory, number>;
  jobCostCents: number;
  expensesCents: number;
  projectMaterialsCents: number;
  costToDateCents: number;

  billedToDateCents: number;
  overbilledCents: number;
  underbilledCents: number;
  billingPosition: BillingPosition;

  grossProfitToDateCents: number;
  costToCompleteCents: number;
  projectedCostCents: number;
  projectedProfitCents: number;
  projectedMarginPercent: number | null;
  /** Projected margin minus bid margin, in percentage points. */
  marginDeltaPoints: number | null;
  lossProvisionCents: number;

  collectedCents: number;
  outstandingCents: number;
  retainageHeldCents: number;

  warnings: string[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function safeCents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Strips float noise (28.000000000000004 → 28) without hiding real precision. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function normalizeCategory(raw: string): CostCategory {
  if (raw === 'materials') return 'material';
  if (raw === 'permits') return 'permit';
  return (WIP_CATEGORIES as string[]).includes(raw) ? (raw as CostCategory) : 'other';
}

function emptyCategoryTotals(): Record<CostCategory, number> {
  return { labor: 0, material: 0, equipment: 0, subcontractor: 0, permit: 0, other: 0 };
}

// ------------------------------------------------------------------
// Report
// ------------------------------------------------------------------

export function buildWipReport(input: WipInput, options: WipOptions = {}): WipReport {
  const { project } = input;
  const warnings: string[] = [];
  const includeMaterials = options.includeProjectMaterials ?? true;
  const contract = Math.max(0, safeCents(project.contract_value_cents));

  // ---- Cost to date --------------------------------------------------
  const costByCategory = emptyCategoryTotals();
  for (const e of input.costEntries) costByCategory[normalizeCategory(String(e.category))] += safeCents(e.total_cost_cents);
  const jobCost = WIP_CATEGORIES.reduce((s, c) => s + costByCategory[c], 0);
  const expenses = Math.max(0, safeCents(input.expenseCents ?? 0));
  const materialsReceived = includeMaterials
    ? input.materials.filter((m) => m.status === 'delivered' || m.status === 'installed').reduce((s, m) => s + materialLineCents(m), 0)
    : 0;
  const costToDate = jobCost + expenses + materialsReceived;

  // ---- Budget (estimated total cost at completion) -------------------
  const override = options.budgetOverrideCents;
  const budget =
    typeof override === 'number' && Number.isFinite(override) && override > 0
      ? Math.round(override)
      : safeCents(project.estimated_labor_cost_cents) + materialsSummary(input.materials).totalCents;

  // ---- Method --------------------------------------------------------
  const methodRequested: WipMethod = options.method ?? 'cost';
  let method: WipMethod = methodRequested;
  if (method === 'cost' && budget <= 0) {
    method = 'milestone';
    warnings.push('No estimated cost is set, so cost-to-cost cannot be measured. Milestone progress is used instead — add an estimated labor cost or materials, or enter a budget above.');
  }

  // ---- % complete, earned revenue, earned value of the estimate ------
  const completed = project.status === 'completed';
  let earned: number;
  let earnedValue: number;
  let percentComplete: number;
  if (completed) {
    earned = contract;
    earnedValue = budget;
    percentComplete = 100;
  } else if (method === 'cost') {
    const counted = Math.min(Math.max(costToDate, 0), budget);
    earned = Math.round((contract * counted) / budget);
    earnedValue = counted;
    percentComplete = round4((counted / budget) * 100);
  } else {
    const p = projectProgress(project, input.phases, input.milestones);
    earned = Math.round((contract * p) / 100);
    earnedValue = Math.round((budget * p) / 100);
    percentComplete = p;
  }

  // ---- Projection ----------------------------------------------------
  const projectedCost = completed ? costToDate : costToDate + Math.max(0, budget - earnedValue);
  const projectedProfit = contract - projectedCost;
  const grossProfitToDate = earned - costToDate;
  const lossProvision = projectedProfit < 0 ? Math.max(0, grossProfitToDate - projectedProfit) : 0;
  const projectedMargin = contract > 0 ? round4((projectedProfit / contract) * 100) : null;
  const bidMargin = contract > 0 && budget > 0 ? round4(((contract - budget) / contract) * 100) : null;

  // ---- Billing position ----------------------------------------------
  const bill = billingSummary(project, input.billing, input.invoices, input.today);
  const billed = bill.invoicedGrossCents;
  const gap = billed - earned;
  const billingPosition: BillingPosition = gap > 0 ? 'over' : gap < 0 ? 'under' : 'balanced';

  // ---- Warnings ------------------------------------------------------
  if (contract <= 0) warnings.push('No contract value is set, so revenue, margin and billing position cannot be measured.');
  if (input.linkedJobCount === 0) warnings.push('No jobs are linked to this project. Link jobs on the Jobs tab so their cost entries count toward cost to date.');
  if (input.expensesAvailable === false) warnings.push('Approved expense allocations could not be read, so they are not included in cost to date.');
  if (includeMaterials && materialsReceived > 0 && costByCategory.material > 0) {
    warnings.push('Material cost appears on linked jobs and as delivered project materials. If these are the same purchases, turn off “Include delivered project materials” to avoid counting them twice.');
  }
  if (budget <= 0 && method === 'milestone' && !completed) {
    warnings.push('With no estimated cost, the projection assumes no further cost will be incurred.');
  }

  return {
    projectId: project.id,
    projectNumber: project.project_number,
    projectName: project.name,
    customerName: project.customer_name,
    status: project.status,
    asOf: input.today,
    methodRequested,
    method,
    contractCents: contract,
    budgetCents: budget,
    bidMarginPercent: bidMargin,
    percentComplete,
    earnedRevenueCents: earned,
    backlogCents: Math.max(0, contract - earned),
    costByCategory,
    jobCostCents: jobCost,
    expensesCents: expenses,
    projectMaterialsCents: materialsReceived,
    costToDateCents: costToDate,
    billedToDateCents: billed,
    overbilledCents: Math.max(0, gap),
    underbilledCents: Math.max(0, -gap),
    billingPosition,
    grossProfitToDateCents: grossProfitToDate,
    costToCompleteCents: Math.max(0, projectedCost - costToDate),
    projectedCostCents: projectedCost,
    projectedProfitCents: projectedProfit,
    projectedMarginPercent: projectedMargin,
    marginDeltaPoints: projectedMargin !== null && bidMargin !== null ? round4(projectedMargin - bidMargin) : null,
    lossProvisionCents: lossProvision,
    collectedCents: bill.paidCents,
    outstandingCents: bill.outstandingCents,
    retainageHeldCents: bill.retainageHeldCents,
    warnings,
  };
}

// ------------------------------------------------------------------
// CSV (one row per project — the standard WIP schedule layout)
// ------------------------------------------------------------------

interface CsvColumn {
  header: string;
  kind: 'text' | 'money' | 'percent';
  value: (r: WipReport) => string | number | null;
}

export const WIP_CSV_COLUMNS: CsvColumn[] = [
  { header: 'Project #', kind: 'text', value: (r) => r.projectNumber ?? '' },
  { header: 'Project', kind: 'text', value: (r) => r.projectName },
  { header: 'Customer', kind: 'text', value: (r) => r.customerName },
  { header: 'Status', kind: 'text', value: (r) => r.status },
  { header: 'As of', kind: 'text', value: (r) => r.asOf },
  { header: 'Method', kind: 'text', value: (r) => WIP_METHOD_LABEL[r.method] },
  { header: 'Contract value', kind: 'money', value: (r) => r.contractCents },
  { header: 'Estimated total cost', kind: 'money', value: (r) => r.budgetCents },
  { header: 'Labor cost to date', kind: 'money', value: (r) => r.costByCategory.labor },
  { header: 'Material cost to date', kind: 'money', value: (r) => r.costByCategory.material },
  { header: 'Equipment cost to date', kind: 'money', value: (r) => r.costByCategory.equipment },
  { header: 'Subcontractor cost to date', kind: 'money', value: (r) => r.costByCategory.subcontractor },
  { header: 'Permit cost to date', kind: 'money', value: (r) => r.costByCategory.permit },
  { header: 'Other cost to date', kind: 'money', value: (r) => r.costByCategory.other },
  { header: 'Approved expenses', kind: 'money', value: (r) => r.expensesCents },
  { header: 'Delivered project materials', kind: 'money', value: (r) => r.projectMaterialsCents },
  { header: 'Total cost to date', kind: 'money', value: (r) => r.costToDateCents },
  { header: '% complete', kind: 'percent', value: (r) => r.percentComplete },
  { header: 'Earned revenue', kind: 'money', value: (r) => r.earnedRevenueCents },
  { header: 'Billed to date', kind: 'money', value: (r) => r.billedToDateCents },
  { header: 'Overbilled', kind: 'money', value: (r) => r.overbilledCents },
  { header: 'Underbilled', kind: 'money', value: (r) => r.underbilledCents },
  { header: 'Gross profit to date', kind: 'money', value: (r) => r.grossProfitToDateCents },
  { header: 'Estimated cost to complete', kind: 'money', value: (r) => r.costToCompleteCents },
  { header: 'Projected total cost', kind: 'money', value: (r) => r.projectedCostCents },
  { header: 'Projected profit', kind: 'money', value: (r) => r.projectedProfitCents },
  { header: 'Projected margin %', kind: 'percent', value: (r) => r.projectedMarginPercent },
  { header: 'Bid margin %', kind: 'percent', value: (r) => r.bidMarginPercent },
  { header: 'Loss provision', kind: 'money', value: (r) => r.lossProvisionCents },
  { header: 'Backlog', kind: 'money', value: (r) => r.backlogCents },
  { header: 'Collected', kind: 'money', value: (r) => r.collectedCents },
  { header: 'Outstanding', kind: 'money', value: (r) => r.outstandingCents },
  { header: 'Retainage held', kind: 'money', value: (r) => r.retainageHeldCents },
];

function csvCell(col: CsvColumn, report: WipReport): string {
  const v = col.value(report);
  if (v === null || v === undefined) return '';
  if (col.kind === 'money') return (Number(v) / 100).toFixed(2);
  if (col.kind === 'percent') return Number(v).toFixed(2);
  const text = String(v);
  // Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at the start of text).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV, CRLF line endings, no BOM (the download adds it for Excel). */
export function wipToCsv(reports: WipReport[]): string {
  const header = WIP_CSV_COLUMNS.map((c) => c.header).join(',');
  const rows = reports.map((r) => WIP_CSV_COLUMNS.map((c) => csvCell(c, r)).join(','));
  return [header, ...rows].join('\r\n');
}

export function wipCsvFilename(report: Pick<WipReport, 'projectNumber' | 'projectName' | 'asOf'>): string {
  const base = (report.projectNumber || report.projectName || 'project').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `wip-${base}-${report.asOf}.csv`;
}
