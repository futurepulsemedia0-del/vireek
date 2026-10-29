// Install Projects — pure types, templates and calculations.
//
// No Supabase import on purpose: everything here is deterministic and unit
// tested (installProjects.test.ts). Database access lives in
// installProjectsApi.ts.

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled';
export type ProjectType = 'hvac' | 'plumbing' | 'electrical' | 'solar' | 'roofing' | 'water_heater' | 'other';
export type PhaseStatus = 'not_started' | 'in_progress' | 'blocked' | 'completed';
export type MilestoneKind = 'task' | 'inspection' | 'delivery' | 'sign_off';
export type MilestoneStatus = 'pending' | 'done' | 'skipped';
export type MaterialStatus = 'planned' | 'ordered' | 'delivered' | 'installed';

export interface InstallProject {
  id: string;
  user_id: string;
  project_number: string | null;
  name: string;
  customer_id: string | null;
  quote_id: string | null;
  customer_name: string;
  site_address: string | null;
  project_type: ProjectType;
  status: ProjectStatus;
  contract_value_cents: number;
  estimated_labor_cost_cents: number;
  retainage_percent: number;
  start_date: string | null;
  target_end_date: string | null;
  work_weekends?: boolean;
  // Change orders (maintained by the database; see 20280105000000_change_orders.sql).
  approved_change_cents?: number;
  approved_change_cost_cents?: number;
  approved_schedule_days?: number;
  completed_at: string | null;
  retainage_invoice_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectPhase {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  sort_order: number;
  weight: number;
  status: PhaseStatus;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  // Scheduler (optional so existing fixtures and rows keep type-checking).
  locked?: boolean;
  updated_at?: string;
  baseline_start?: string | null;
  baseline_end?: string | null;
}

export interface ProjectMilestone {
  id: string;
  project_id: string;
  phase_id: string;
  title: string;
  kind: MilestoneKind;
  status: MilestoneStatus;
  due_date: string | null;
  sort_order: number;
  notes: string | null;
  completed_at: string | null;
}

export interface ProjectBilling {
  id: string;
  project_id: string;
  phase_id: string | null;
  milestone_id: string | null;
  label: string;
  percent_of_contract: number;
  due_date: string | null;
  sort_order: number;
  invoice_id: string | null;
  invoiced_gross_cents: number | null;
  retainage_withheld_cents: number;
  invoiced_at: string | null;
}

export interface ProjectMaterial {
  id: string;
  project_id: string;
  phase_id: string | null;
  part_id: string | null;
  description: string;
  quantity: number;
  unit_label: string | null;
  unit_cost_cents: number;
  vendor: string | null;
  status: MaterialStatus;
  expected_date: string | null;
  lead_time_days?: number;
  notes: string | null;
}

/** The slice of an invoice the billing logic needs. */
export interface InvoiceLite {
  id: string;
  invoice_number: string;
  status: string;
  due_date: string | null;
}

// ------------------------------------------------------------------
// Labels
// ------------------------------------------------------------------

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  hvac: 'HVAC system',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  solar: 'Solar / storage',
  roofing: 'Roofing',
  water_heater: 'Water heater',
  other: 'Other install',
};

export const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
};

export const MILESTONE_KIND_LABEL: Record<MilestoneKind, string> = {
  task: 'Task',
  inspection: 'Inspection',
  delivery: 'Delivery',
  sign_off: 'Sign-off',
};

export const MATERIAL_STATUS_LABEL: Record<MaterialStatus, string> = {
  planned: 'Planned',
  ordered: 'Ordered',
  delivered: 'Delivered',
  installed: 'Installed',
};

export const MATERIAL_STATUS_ORDER: MaterialStatus[] = ['planned', 'ordered', 'delivered', 'installed'];

export const MAX_RETAINAGE_PERCENT = 25;

/** The slice of a change order the billing math needs. */
export interface ChangeOrderLite {
  status: string;
  cost_delta_cents: number;
  invoice_id: string | null;
  invoiced_gross_cents: number | null;
}

/** Original contract plus every approved change order. Progress draws bill against the ORIGINAL value. */
export function revisedContractCents(project: Pick<InstallProject, 'contract_value_cents' | 'approved_change_cents'>): number {
  return project.contract_value_cents + (project.approved_change_cents ?? 0);
}

/** "$18,500 original + $1,200 change orders", or null when nothing was approved. */
export function contractBreakdownHint(project: Pick<InstallProject, 'contract_value_cents' | 'approved_change_cents'>): string | null {
  const change = project.approved_change_cents ?? 0;
  if (change === 0) return null;
  return `${formatMoney(project.contract_value_cents, true)} original ${change > 0 ? '+' : '−'} ${formatMoney(Math.abs(change), true)} changes`;
}

// ------------------------------------------------------------------
// Formatting & parsing
// ------------------------------------------------------------------

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const MONEY_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function formatMoney(cents: number | null | undefined, whole = false): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  return (whole ? MONEY_WHOLE : MONEY).format(cents / 100);
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Number(value.toFixed(digits))}%`;
}

/** Local calendar date as YYYY-MM-DD (never shifted by the UTC offset). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return dayNumber(toIso) - dayNumber(fromIso);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "12,500.50" / "$1,200" → cents. '' → 0. Invalid → null. */
export function dollarsToCents(input: string): number | null {
  const clean = input.replace(/[$,\s]/g, '');
  if (clean === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export function centsToDollarsInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

// ------------------------------------------------------------------
// Progress & schedule
// ------------------------------------------------------------------

export function phaseProgress(phase: Pick<ProjectPhase, 'id' | 'status'>, milestones: ProjectMilestone[]): number {
  if (phase.status === 'completed') return 100;
  const counted = milestones.filter((m) => m.phase_id === phase.id && m.status !== 'skipped');
  if (counted.length === 0) return 0;
  const done = counted.filter((m) => m.status === 'done').length;
  return Math.round((done / counted.length) * 100);
}

/** Weighted (by phase weight) completion, 0–100. */
export function projectProgress(
  project: Pick<InstallProject, 'status'>,
  phases: ProjectPhase[],
  milestones: ProjectMilestone[],
): number {
  if (project.status === 'completed') return 100;
  const totalWeight = phases.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return 0;
  const earned = phases.reduce((s, p) => s + p.weight * phaseProgress(p, milestones), 0);
  return Math.round(earned / totalWeight);
}

export type ScheduleState = 'not_started' | 'on_track' | 'at_risk' | 'late' | 'paused' | 'done' | 'cancelled';

export interface ScheduleHealth {
  state: ScheduleState;
  overdueMilestones: number;
  daysToTarget: number | null;
  reason: string;
}

export const SCHEDULE_LABEL: Record<ScheduleState, string> = {
  not_started: 'Not started',
  on_track: 'On track',
  at_risk: 'At risk',
  late: 'Late',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function scheduleHealth(
  project: Pick<InstallProject, 'status' | 'start_date' | 'target_end_date'>,
  phases: ProjectPhase[],
  milestones: ProjectMilestone[],
  today: string,
): ScheduleHealth {
  const daysToTarget = project.target_end_date ? daysBetween(today, project.target_end_date) : null;
  const overdue = milestones.filter((m) => m.status === 'pending' && m.due_date !== null && m.due_date < today).length;
  const base = { overdueMilestones: overdue, daysToTarget };

  if (project.status === 'completed') return { ...base, state: 'done', reason: 'Project completed.' };
  if (project.status === 'cancelled') return { ...base, state: 'cancelled', reason: 'Project cancelled.' };
  if (project.status === 'on_hold') return { ...base, state: 'paused', reason: 'Project is on hold.' };
  if (project.status === 'planning') return { ...base, state: 'not_started', reason: 'Project has not started yet.' };

  if (overdue > 0) {
    return { ...base, state: 'late', reason: `${overdue} overdue milestone${overdue === 1 ? '' : 's'}.` };
  }
  if (daysToTarget !== null && daysToTarget < 0) {
    return { ...base, state: 'late', reason: `Target end date passed ${-daysToTarget} day${daysToTarget === -1 ? '' : 's'} ago.` };
  }

  const progress = projectProgress(project, phases, milestones);
  if (daysToTarget !== null && daysToTarget <= 7 && progress < 80) {
    return { ...base, state: 'at_risk', reason: `Target is ${daysToTarget} day${daysToTarget === 1 ? '' : 's'} away at ${progress}% complete.` };
  }
  if (project.start_date && project.target_end_date) {
    const span = daysBetween(project.start_date, project.target_end_date);
    if (span > 0) {
      const elapsed = Math.min(1, Math.max(0, daysBetween(project.start_date, today) / span));
      if (progress + 20 < Math.round(elapsed * 100)) {
        return { ...base, state: 'at_risk', reason: `${progress}% complete vs ${Math.round(elapsed * 100)}% of the schedule elapsed.` };
      }
    }
  }
  return { ...base, state: 'on_track', reason: 'No overdue milestones.' };
}

// ------------------------------------------------------------------
// Progress billing
// ------------------------------------------------------------------

export interface DrawAmounts {
  grossCents: number;
  retainageCents: number;
  netCents: number;
}

/** Mirrors create_project_invoice(): gross from % of contract, minus retainage. */
export function drawAmounts(contractCents: number, retainagePercent: number, percent: number): DrawAmounts {
  const grossCents = Math.round((contractCents * percent) / 100);
  const retainageCents = Math.round((grossCents * retainagePercent) / 100);
  return { grossCents, retainageCents, netCents: grossCents - retainageCents };
}

export type BillingRowStatus = 'scheduled' | 'invoiced' | 'overdue' | 'paid';

export const BILLING_STATUS_LABEL: Record<BillingRowStatus, string> = {
  scheduled: 'Scheduled',
  invoiced: 'Invoiced',
  overdue: 'Overdue',
  paid: 'Paid',
};

/** The invoice only counts while it exists and is not void. */
export function liveInvoice(row: Pick<ProjectBilling, 'invoice_id'>, invoices: Record<string, InvoiceLite>): InvoiceLite | null {
  if (!row.invoice_id) return null;
  const inv = invoices[row.invoice_id];
  return inv && inv.status !== 'void' ? inv : null;
}

export function billingRowStatus(
  row: Pick<ProjectBilling, 'invoice_id'>,
  invoices: Record<string, InvoiceLite>,
  today: string,
): BillingRowStatus {
  const inv = liveInvoice(row, invoices);
  if (!inv) return 'scheduled';
  if (inv.status === 'paid') return 'paid';
  if (inv.due_date && inv.due_date < today) return 'overdue';
  return 'invoiced';
}

export function remainingBillablePercent(billing: Pick<ProjectBilling, 'percent_of_contract'>[]): number {
  const used = billing.reduce((s, b) => s + b.percent_of_contract, 0);
  return Math.max(0, Math.round((100 - used) * 1000) / 1000);
}

export interface BillingSummary {
  contractCents: number;
  scheduledPercent: number;
  unscheduledPercent: number;
  invoicedGrossCents: number;
  billedPercent: number;
  paidCents: number;
  outstandingCents: number;
  overdueCents: number;
  retainageHeldCents: number;
  retainageReleased: boolean;
}

export function billingSummary(
  project: Pick<InstallProject, 'contract_value_cents' | 'approved_change_cents' | 'retainage_percent' | 'retainage_invoice_id'>,
  billing: ProjectBilling[],
  invoices: Record<string, InvoiceLite>,
  today: string,
  changeOrders: ChangeOrderLite[] = [],
): BillingSummary {
  let invoicedGross = 0;
  let paid = 0;
  let outstanding = 0;
  let overdue = 0;
  let retainage = 0;
  for (const row of billing) {
    const inv = liveInvoice(row, invoices);
    if (!inv) continue;
    const gross = row.invoiced_gross_cents ?? drawAmounts(project.contract_value_cents, project.retainage_percent, row.percent_of_contract).grossCents;
    const net = gross - row.retainage_withheld_cents;
    invoicedGross += gross;
    retainage += row.retainage_withheld_cents;
    if (inv.status === 'paid') paid += net;
    else {
      outstanding += net;
      if (inv.due_date && inv.due_date < today) overdue += net;
    }
  }
  // Approved change orders are invoiced separately, in full (no retainage).
  for (const co of changeOrders) {
    if (co.status !== 'approved' || !co.invoice_id) continue;
    const coInvoice = liveInvoice({ invoice_id: co.invoice_id }, invoices);
    if (!coInvoice) continue;
    const gross = co.invoiced_gross_cents ?? co.cost_delta_cents;
    invoicedGross += gross;
    if (coInvoice.status === 'paid') paid += gross;
    else {
      outstanding += gross;
      if (coInvoice.due_date && coInvoice.due_date < today) overdue += gross;
    }
  }
  const scheduledPercent = Math.round(billing.reduce((s, b) => s + b.percent_of_contract, 0) * 1000) / 1000;
  const released = project.retainage_invoice_id ? liveInvoice({ invoice_id: project.retainage_invoice_id }, invoices) !== null : false;
  return {
    contractCents: revisedContractCents(project),
    scheduledPercent,
    unscheduledPercent: Math.max(0, Math.round((100 - scheduledPercent) * 1000) / 1000),
    invoicedGrossCents: invoicedGross,
    billedPercent: revisedContractCents(project) > 0 ? (invoicedGross / revisedContractCents(project)) * 100 : 0,
    paidCents: paid,
    outstandingCents: outstanding,
    overdueCents: overdue,
    retainageHeldCents: released ? 0 : retainage,
    retainageReleased: released,
  };
}

export type BillingBalance = 'ahead' | 'balanced' | 'behind';

/**
 * Earned-value check: billing far ahead of physical progress is a cash-flow
 * and dispute risk; far behind means money is being left on the table.
 */
export function billingBalance(billedPercent: number, progressPercent: number, tolerance = 15): { state: BillingBalance; gap: number } {
  const gap = Math.round(billedPercent - progressPercent);
  if (gap > tolerance) return { state: 'ahead', gap };
  if (gap < -tolerance) return { state: 'behind', gap };
  return { state: 'balanced', gap };
}

// ------------------------------------------------------------------
// Materials & margin
// ------------------------------------------------------------------

export function materialLineCents(m: Pick<ProjectMaterial, 'quantity' | 'unit_cost_cents'>): number {
  return Math.round(m.quantity * m.unit_cost_cents);
}

export interface MaterialsSummary {
  totalCents: number;
  lineCount: number;
  byStatus: Record<MaterialStatus, { count: number; cents: number }>;
}

export function materialsSummary(materials: ProjectMaterial[]): MaterialsSummary {
  const byStatus = {
    planned: { count: 0, cents: 0 },
    ordered: { count: 0, cents: 0 },
    delivered: { count: 0, cents: 0 },
    installed: { count: 0, cents: 0 },
  } as MaterialsSummary['byStatus'];
  let totalCents = 0;
  for (const m of materials) {
    const cents = materialLineCents(m);
    totalCents += cents;
    byStatus[m.status].count += 1;
    byStatus[m.status].cents += cents;
  }
  return { totalCents, lineCount: materials.length, byStatus };
}

export type MarginLevel = 'healthy' | 'thin' | 'at_risk' | 'unknown';

export interface MarginForecast {
  costCents: number;
  marginCents: number;
  marginPercent: number | null;
  level: MarginLevel;
}

export function marginForecast(
  project: Pick<InstallProject, 'contract_value_cents' | 'estimated_labor_cost_cents' | 'approved_change_cents' | 'approved_change_cost_cents'>,
  materialsCents: number,
): MarginForecast {
  const costCents = materialsCents + project.estimated_labor_cost_cents + (project.approved_change_cost_cents ?? 0);
  const revised = revisedContractCents(project);
  const marginCents = revised - costCents;
  if (revised <= 0) return { costCents, marginCents, marginPercent: null, level: 'unknown' };
  const marginPercent = (marginCents / revised) * 100;
  return { costCents, marginCents, marginPercent, level: marginPercent >= 25 ? 'healthy' : marginPercent >= 10 ? 'thin' : 'at_risk' };
}

// ------------------------------------------------------------------
// Templates (a starting point — everything stays editable)
// ------------------------------------------------------------------

export interface TemplatePhase {
  name: string;
  weight: number;
  milestones: { title: string; kind: MilestoneKind }[];
}

export interface TemplateDraw {
  label: string;
  percent: number;
  /** Index into `phases` the draw is tied to, or null for a contract-signing draw. */
  phaseIndex: number | null;
}

export interface ProjectTemplate {
  phases: TemplatePhase[];
  draws: TemplateDraw[];
}

export function templateFor(type: ProjectType): ProjectTemplate {
  const equipment = type === 'solar' ? 'Panels & inverter delivered' : type === 'roofing' ? 'Materials delivered' : 'Equipment delivered';
  const install = type === 'solar' ? 'Array & storage install' : type === 'roofing' ? 'Tear-off & install' : 'Equipment install';
  return {
    phases: [
      {
        name: 'Site survey & permits',
        weight: 1,
        milestones: [
          { title: 'Site survey complete', kind: 'task' },
          { title: 'Contract signed', kind: 'sign_off' },
          { title: 'Permit approved', kind: 'task' },
        ],
      },
      {
        name: 'Procurement & staging',
        weight: 1,
        milestones: [
          { title: 'Materials ordered', kind: 'task' },
          { title: equipment, kind: 'delivery' },
        ],
      },
      {
        name: install,
        weight: 3,
        milestones: [
          { title: 'Rough-in complete', kind: 'task' },
          { title: 'Main install complete', kind: 'task' },
          { title: 'Rough-in inspection passed', kind: 'inspection' },
        ],
      },
      {
        name: 'Commissioning & closeout',
        weight: 1,
        milestones: [
          { title: 'System start-up & testing', kind: 'task' },
          { title: 'Final inspection passed', kind: 'inspection' },
          { title: 'Customer walkthrough & sign-off', kind: 'sign_off' },
        ],
      },
    ],
    draws: [
      { label: 'Deposit', percent: 30, phaseIndex: null },
      { label: 'Materials delivered / rough-in', percent: 40, phaseIndex: 2 },
      { label: 'Final completion', percent: 30, phaseIndex: 3 },
    ],
  };
}

// ------------------------------------------------------------------
// Forms & errors
// ------------------------------------------------------------------

export interface ProjectFormValues {
  name: string;
  customerId: string;
  customerName: string;
  siteAddress: string;
  projectType: ProjectType;
  contractValue: string;
  laborEstimate: string;
  retainagePercent: string;
  startDate: string;
  targetEndDate: string;
  notes: string;
  useTemplate: boolean;
}

export const EMPTY_PROJECT_FORM: ProjectFormValues = {
  name: '',
  customerId: '',
  customerName: '',
  siteAddress: '',
  projectType: 'hvac',
  contractValue: '',
  laborEstimate: '',
  retainagePercent: '0',
  startDate: '',
  targetEndDate: '',
  notes: '',
  useTemplate: true,
};

export type ProjectFormErrors = Partial<Record<keyof ProjectFormValues, string>>;

export function validateProjectForm(v: ProjectFormValues): ProjectFormErrors {
  const e: ProjectFormErrors = {};
  if (!v.name.trim()) e.name = 'Give the project a name.';
  else if (v.name.trim().length > 160) e.name = 'Keep the name under 160 characters.';
  if (!v.customerName.trim()) e.customerName = 'Choose or enter a customer.';
  if (dollarsToCents(v.contractValue) === null) e.contractValue = 'Enter a dollar amount, e.g. 18500 or 18,500.00.';
  if (dollarsToCents(v.laborEstimate) === null) e.laborEstimate = 'Enter a dollar amount.';
  const ret = Number(v.retainagePercent === '' ? 0 : v.retainagePercent);
  if (!Number.isFinite(ret) || ret < 0 || ret > MAX_RETAINAGE_PERCENT) {
    e.retainagePercent = `Retainage must be between 0 and ${MAX_RETAINAGE_PERCENT}%.`;
  }
  if (v.startDate && v.targetEndDate && v.targetEndDate < v.startDate) {
    e.targetEndDate = 'Target end must be on or after the start date.';
  }
  return e;
}

const ERROR_COPY: Record<string, string> = {
  not_authorized: 'You do not have permission to manage billing for projects.',
  not_authenticated: 'Your session expired. Sign in again.',
  already_invoiced: 'This billing step already has an open invoice.',
  no_contract_value: 'Set a contract value before invoicing.',
  project_cancelled: 'This project is cancelled.',
  project_not_completed: 'Mark the project completed before releasing retainage.',
  already_released: 'Retainage has already been released.',
  no_retainage_held: 'There is no retainage to release.',
  billing_exceeds_contract: 'Billing steps cannot add up to more than 100% of the contract.',
  billing_locked: 'This billing step is invoiced. Void the invoice before changing its percentage.',
  invalid_customer: 'That customer is not in your account.',
  invalid_job: 'That job is not in your account.',
  invalid_part: 'That inventory part is not in your account.',
  invalid_phase: 'That phase does not belong to this project.',
  duplicate_key: 'That job is already linked to a project.',
  dependency_cycle: 'That link would create a loop between phases.',
  dependency_self: 'A phase cannot depend on itself.',
  dependency_invalid: 'Both phases must belong to this project.',
  stale_schedule: 'The schedule changed while you were editing. It has been reloaded — try again.',
  phase_locked: 'This phase is locked. Unlock it before changing its dates.',
  phase_completed: 'Completed phases cannot be rescheduled.',
  project_closed: 'Completed or cancelled projects cannot be rescheduled.',
  invalid_range: 'The end date must be on or after the start date.',
  invalid_technician: 'That team member is not in your account.',
  sharing_not_found: 'Project not found.',
  change_order_not_found: 'That change order no longer exists.',
  change_order_locked: 'Only a draft change order can be edited. Recall or revise it first.',
  change_order_fields_locked: 'Status, signature and invoice details are managed automatically.',
  change_order_empty: 'Add a price or schedule change before sending.',
  change_order_not_approved: 'Only an approved change order can be invoiced.',
  change_totals_locked: 'Approved change totals are managed automatically.',
  invalid_transition: 'That status change is not allowed for this change order.',
  invalid_line_items: 'One of the line items is invalid. Check descriptions, quantities and prices.',
  too_many_line_items: 'A change order can have at most 100 line items.',
  nothing_to_invoice: 'This change order has no price change to invoice.',
  schedule_before_start: 'Approving would move the target end date before the project start. Edit the project dates first.',
  signature_mismatch: 'That signature request does not belong to this change order.',
  invalid_project: 'That project is not in your account.',
  project_not_found: 'Project not found.',
};

export function friendlyError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  for (const key of Object.keys(ERROR_COPY)) {
    if (message.includes(key)) return ERROR_COPY[key];
  }
  if (/duplicate key value/i.test(message)) return ERROR_COPY.duplicate_key;
  return fallback;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ------------------------------------------------------------------
// Portfolio rollup (list view)
// ------------------------------------------------------------------

export interface ProjectRollup {
  progress: number;
  schedule: ScheduleHealth;
  billing: BillingSummary;
  nextMilestone: Pick<ProjectMilestone, 'title' | 'due_date'> | null;
}

export function nextPendingMilestone(
  phases: ProjectPhase[],
  milestones: ProjectMilestone[],
): Pick<ProjectMilestone, 'title' | 'due_date'> | null {
  const phaseOrder = new Map(phases.map((p) => [p.id, p.sort_order]));
  const pending = milestones
    .filter((m) => m.status === 'pending')
    .sort((a, b) => {
      if (a.due_date !== b.due_date) {
        if (a.due_date === null) return 1;
        if (b.due_date === null) return -1;
        return a.due_date < b.due_date ? -1 : 1;
      }
      const pa = phaseOrder.get(a.phase_id) ?? 0;
      const pb = phaseOrder.get(b.phase_id) ?? 0;
      return pa !== pb ? pa - pb : a.sort_order - b.sort_order;
    });
  return pending[0] ? { title: pending[0].title, due_date: pending[0].due_date } : null;
}

export function buildRollup(
  project: InstallProject,
  phases: ProjectPhase[],
  milestones: ProjectMilestone[],
  billing: ProjectBilling[],
  invoices: Record<string, InvoiceLite>,
  today: string,
  changeOrders: ChangeOrderLite[] = [],
): ProjectRollup {
  return {
    progress: projectProgress(project, phases, milestones),
    schedule: scheduleHealth(project, phases, milestones, today),
    billing: billingSummary(project, billing, invoices, today, changeOrders),
    nextMilestone: nextPendingMilestone(phases, milestones),
  };
}

/** YYYY-MM-DD plus N calendar days (timezone-safe). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
