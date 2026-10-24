import { supabase } from '@/lib/supabase';
import {
  addDays,
  computeCertifiedPayroll,
  type ComputeResult,
  type JobWorkerClassification,
  type LegalReviewStatus,
  type OvertimeRuleSet,
  type TimeEntry,
  type WageRate,
  type WorkerInfo,
} from '@/lib/prevailingWage';
import {
  buildReportSnapshot,
  type ImportedRate,
  type ReportDeductions,
  type ReportMeta,
  type ReportSnapshot,
  type RuleSetValues,
} from '@/lib/prevailingWageExport';

/**
 * Prevailing wage — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20271102000000_prevailing_wage_engine.sql.
 * Rule tables are edited directly (RLS-guarded); reports are written only through
 * the pw_* RPCs. All math lives in prevailingWage.ts (pure + unit-tested).
 * LEGAL REVIEW REQUIRED — see LEGAL_REVIEW_NOTICE in prevailingWage.ts.
 */

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function fail(error: { message?: string } | null | undefined, fallback = 'Something went wrong. Please try again.'): never {
  throw new Error(error?.message || fallback);
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type Program = 'davis_bacon' | 'service_contract_act' | 'state_prevailing' | 'municipal' | 'project_labor_agreement' | 'custom';
export type ConstructionType = 'building' | 'heavy' | 'highway' | 'residential' | 'service' | 'other';
export type DeterminationStatus = 'draft' | 'active' | 'archived';

export const PROGRAM_LABEL: Record<Program, string> = {
  davis_bacon: 'Davis-Bacon (federal construction)',
  service_contract_act: 'Service Contract Act (federal service)',
  state_prevailing: 'State prevailing wage',
  municipal: 'City / county ordinance',
  project_labor_agreement: 'Project labor agreement',
  custom: 'Custom',
};

export const CONSTRUCTION_LABEL: Record<ConstructionType, string> = {
  building: 'Building',
  heavy: 'Heavy',
  highway: 'Highway',
  residential: 'Residential',
  service: 'Service',
  other: 'Other',
};

export interface Determination {
  id: string;
  name: string;
  program: Program;
  determinationNumber: string | null;
  revision: string | null;
  country: string;
  state: string | null;
  county: string | null;
  locality: string | null;
  constructionType: ConstructionType;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceUrl: string | null;
  sourceNotes: string | null;
  status: DeterminationStatus;
  legalReviewStatus: LegalReviewStatus;
  legalReviewedBy: string | null;
  legalReviewedAt: string | null;
  lockedAt: string | null;
}

export type DeterminationInput = Omit<Determination, 'id' | 'legalReviewStatus' | 'legalReviewedBy' | 'legalReviewedAt' | 'lockedAt'> & { id?: string };

export interface WageRateRow extends WageRate {
  determinationId: string;
  tradeCode: string | null;
  notes: string | null;
}

export type WageRateInput = Omit<WageRateRow, 'id'> & { id?: string };

export interface RuleSetRow extends OvertimeRuleSet {
  description: string | null;
  active: boolean;
  legalReviewedBy: string | null;
  legalReviewedAt: string | null;
}

export type RuleSetInput = RuleSetValues & { id?: string; description?: string | null; active?: boolean };

export interface JobLite {
  id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
}

export interface EmployeeLite {
  id: string;
  fullName: string;
  hourlyRateCents: number | null;
  active: boolean;
}

export interface WorkerProfile {
  id: string;
  employeeId: string;
  defaultClassification: string | null;
  workerIdLast4: string | null;
  address: string | null;
  fringePlanCentsPerHour: number;
  fringePlanDescription: string | null;
  apprenticeRegistration: string | null;
}

export type WorkerProfileInput = Omit<WorkerProfile, 'id'>;

export interface JobAssignment {
  id: string;
  jobId: string;
  determinationId: string;
  ruleSetId: string;
  projectName: string | null;
  contractNumber: string | null;
  awardingAgency: string | null;
  primeContractor: string | null;
  projectLocation: string | null;
  contractorName: string | null;
  contractorAddress: string | null;
  isCertifiedPayroll: boolean;
  rateLockDate: string | null;
  notes: string | null;
}

export type JobAssignmentInput = Omit<JobAssignment, 'id'>;

export interface JobWorker {
  id: string;
  jobId: string;
  employeeId: string;
  classification: string;
  effectiveFrom: string;
}

export type ReportStatus = 'draft' | 'certified' | 'void';

export interface ReportRow {
  id: string;
  jobId: string;
  determinationId: string;
  ruleSetId: string;
  payrollNumber: number;
  weekEnding: string;
  status: ReportStatus;
  isFinal: boolean;
  noWork: boolean;
  totalHours: number;
  totalGrossCents: number;
  totalFringePlanCents: number;
  workerCount: number;
  certifiedByName: string | null;
  certifiedByTitle: string | null;
  certifiedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

export interface ReportFull extends ReportRow {
  snapshot: ReportSnapshot;
}

export interface AuditEntry {
  id: string;
  tableName: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  createdAt: string;
  actor: string | null;
  oldData: Row | null;
  newData: Row | null;
}

// ------------------------------------------------------------------
// Mappers
// ------------------------------------------------------------------

const toDetermination = (r: Row): Determination => ({
  id: String(r.id),
  name: String(r.name),
  program: r.program as Program,
  determinationNumber: str(r.determination_number),
  revision: str(r.revision),
  country: String(r.country ?? 'US'),
  state: str(r.state),
  county: str(r.county),
  locality: str(r.locality),
  constructionType: r.construction_type as ConstructionType,
  effectiveFrom: String(r.effective_from),
  effectiveTo: str(r.effective_to),
  sourceUrl: str(r.source_url),
  sourceNotes: str(r.source_notes),
  status: r.status as DeterminationStatus,
  legalReviewStatus: r.legal_review_status as LegalReviewStatus,
  legalReviewedBy: str(r.legal_reviewed_by),
  legalReviewedAt: str(r.legal_reviewed_at),
  lockedAt: str(r.locked_at),
});

const toRate = (r: Row): WageRateRow => ({
  id: String(r.id),
  determinationId: String(r.determination_id),
  classification: String(r.classification),
  tradeCode: str(r.trade_code),
  effectiveFrom: String(r.effective_from),
  effectiveTo: str(r.effective_to),
  baseRateCents: num(r.base_rate_cents),
  fringeCents: num(r.fringe_cents),
  isApprentice: Boolean(r.is_apprentice),
  otMultiplierOverride: r.ot_multiplier_override === null || r.ot_multiplier_override === undefined ? null : Number(r.ot_multiplier_override),
  notes: str(r.notes),
});

const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const toRuleSet = (r: Row): RuleSetRow => ({
  id: String(r.id),
  name: String(r.name),
  description: str(r.description),
  active: Boolean(r.active),
  workweekStartDow: num(r.workweek_start_dow),
  dailyOtAfter: optNum(r.daily_ot_after),
  dailyDtAfter: optNum(r.daily_dt_after),
  weeklyOtAfter: num(r.weekly_ot_after),
  seventhDayRule: r.seventh_day_rule as OvertimeRuleSet['seventhDayRule'],
  seventhDayOtHours: num(r.seventh_day_ot_hours),
  otMultiplier: num(r.ot_multiplier),
  dtMultiplier: num(r.dt_multiplier),
  saturdayMultiplier: optNum(r.saturday_multiplier),
  sundayMultiplier: optNum(r.sunday_multiplier),
  holidayMultiplier: optNum(r.holiday_multiplier),
  holidays: ((r.holidays as string[] | null) ?? []).map(String),
  fringeOvertimeMode: r.fringe_overtime_mode as OvertimeRuleSet['fringeOvertimeMode'],
  legalReviewStatus: r.legal_review_status as LegalReviewStatus,
  legalReviewedBy: str(r.legal_reviewed_by),
  legalReviewedAt: str(r.legal_reviewed_at),
});

const toAssignment = (r: Row): JobAssignment => ({
  id: String(r.id),
  jobId: String(r.job_id),
  determinationId: String(r.determination_id),
  ruleSetId: String(r.rule_set_id),
  projectName: str(r.project_name),
  contractNumber: str(r.contract_number),
  awardingAgency: str(r.awarding_agency),
  primeContractor: str(r.prime_contractor),
  projectLocation: str(r.project_location),
  contractorName: str(r.contractor_name),
  contractorAddress: str(r.contractor_address),
  isCertifiedPayroll: Boolean(r.is_certified_payroll),
  rateLockDate: str(r.rate_lock_date),
  notes: str(r.notes),
});

const toProfile = (r: Row): WorkerProfile => ({
  id: String(r.id),
  employeeId: String(r.employee_id),
  defaultClassification: str(r.default_classification),
  workerIdLast4: str(r.worker_id_last4),
  address: str(r.address),
  fringePlanCentsPerHour: num(r.fringe_plan_cents_per_hour),
  fringePlanDescription: str(r.fringe_plan_description),
  apprenticeRegistration: str(r.apprentice_registration),
});

const toJobWorker = (r: Row): JobWorker => ({
  id: String(r.id),
  jobId: String(r.job_id),
  employeeId: String(r.employee_id),
  classification: String(r.classification),
  effectiveFrom: String(r.effective_from),
});

const toReport = (r: Row): ReportRow => ({
  id: String(r.id),
  jobId: String(r.job_id),
  determinationId: String(r.determination_id),
  ruleSetId: String(r.rule_set_id),
  payrollNumber: num(r.payroll_number),
  weekEnding: String(r.week_ending),
  status: r.status as ReportStatus,
  isFinal: Boolean(r.is_final),
  noWork: Boolean(r.no_work),
  totalHours: num(r.total_hours),
  totalGrossCents: num(r.total_gross_cents),
  totalFringePlanCents: num(r.total_fringe_plan_cents),
  workerCount: num(r.worker_count),
  certifiedByName: str(r.certified_by_name),
  certifiedByTitle: str(r.certified_by_title),
  certifiedAt: str(r.certified_at),
  voidReason: str(r.void_reason),
  createdAt: String(r.created_at),
});

const REPORT_COLUMNS =
  'id, job_id, determination_id, rule_set_id, payroll_number, week_ending, status, is_final, no_work, total_hours, total_gross_cents, total_fringe_plan_cents, worker_count, certified_by_name, certified_by_title, certified_at, void_reason, created_at';

// ------------------------------------------------------------------
// Wage tables
// ------------------------------------------------------------------

export async function fetchDeterminations(): Promise<Determination[]> {
  const { data, error } = await supabase.from('pw_wage_determinations').select('*').order('name');
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map(toDetermination);
}

export async function saveDetermination(input: DeterminationInput): Promise<void> {
  const payload = {
    name: input.name.trim(),
    program: input.program,
    determination_number: input.determinationNumber?.trim() || null,
    revision: input.revision?.trim() || null,
    country: (input.country || 'US').trim().toUpperCase(),
    state: input.state?.trim().toUpperCase() || null,
    county: input.county?.trim() || null,
    locality: input.locality?.trim() || null,
    construction_type: input.constructionType,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    source_url: input.sourceUrl?.trim() || null,
    source_notes: input.sourceNotes?.trim() || null,
    status: input.status,
  };
  const { error } = input.id
    ? await supabase.from('pw_wage_determinations').update(payload).eq('id', input.id)
    : await supabase.from('pw_wage_determinations').insert(payload);
  if (error) fail(error);
}

export async function setDeterminationReview(id: string, status: LegalReviewStatus, reviewer: string): Promise<void> {
  if (status === 'approved' && reviewer.trim().length < 2) throw new Error('Enter the name of the attorney or compliance professional who reviewed this.');
  const { error } = await supabase
    .from('pw_wage_determinations')
    .update({
      legal_review_status: status,
      legal_reviewed_by: status === 'approved' ? reviewer.trim() : null,
      legal_reviewed_at: status === 'approved' ? new Date().toISOString() : null,
    })
    .eq('id', id);
  if (error) fail(error);
}

export async function deleteDetermination(id: string): Promise<void> {
  const { error } = await supabase.from('pw_wage_determinations').delete().eq('id', id);
  if (error) fail(error, 'Could not delete. A wage table that is assigned to a job or used in a payroll cannot be deleted — archive it instead.');
}

export async function fetchRates(determinationId: string): Promise<WageRateRow[]> {
  const { data, error } = await supabase
    .from('pw_wage_rates')
    .select('*')
    .eq('determination_id', determinationId)
    .order('classification')
    .order('effective_from');
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map(toRate);
}

export async function saveRate(input: WageRateInput): Promise<void> {
  const payload = {
    determination_id: input.determinationId,
    classification: input.classification.trim().replace(/\s+/g, ' '),
    trade_code: input.tradeCode?.trim() || null,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    base_rate_cents: input.baseRateCents,
    fringe_cents: input.fringeCents,
    is_apprentice: input.isApprentice,
    ot_multiplier_override: input.otMultiplierOverride,
    notes: input.notes?.trim() || null,
  };
  const { error } = input.id
    ? await supabase.from('pw_wage_rates').update(payload).eq('id', input.id)
    : await supabase.from('pw_wage_rates').insert(payload);
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new Error('That classification already has a rate starting on this date. Edit it, or use a different effective date.');
    fail(error);
  }
}

export async function deleteRate(id: string): Promise<void> {
  const { error } = await supabase.from('pw_wage_rates').delete().eq('id', id);
  if (error) fail(error);
}

/** Adds imported rows, skipping classification+date pairs that already exist. */
export async function importRates(determinationId: string, rows: ImportedRate[]): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const existing = await fetchRates(determinationId);
  const key = (c: string, d: string) => `${c.trim().replace(/\s+/g, ' ').toLowerCase()}|${d}`;
  const have = new Set(existing.map((r) => key(r.classification, r.effectiveFrom)));
  const fresh = rows.filter((r) => !have.has(key(r.classification, r.effectiveFrom)));
  if (fresh.length > 0) {
    const { error } = await supabase.from('pw_wage_rates').insert(
      fresh.map((r) => ({
        determination_id: determinationId,
        classification: r.classification,
        effective_from: r.effectiveFrom,
        base_rate_cents: r.baseRateCents,
        fringe_cents: r.fringeCents,
        is_apprentice: r.isApprentice,
      })),
    );
    if (error) fail(error);
  }
  return { inserted: fresh.length, skipped: rows.length - fresh.length };
}

// ------------------------------------------------------------------
// Overtime rule sets
// ------------------------------------------------------------------

export async function fetchRuleSets(): Promise<RuleSetRow[]> {
  const { data, error } = await supabase.from('pw_overtime_rule_sets').select('*').order('name');
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map(toRuleSet);
}

export async function saveRuleSet(input: RuleSetInput): Promise<void> {
  const payload = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    active: input.active ?? true,
    workweek_start_dow: input.workweekStartDow,
    daily_ot_after: input.dailyOtAfter,
    daily_dt_after: input.dailyDtAfter,
    weekly_ot_after: input.weeklyOtAfter,
    seventh_day_rule: input.seventhDayRule,
    seventh_day_ot_hours: input.seventhDayOtHours,
    ot_multiplier: input.otMultiplier,
    dt_multiplier: input.dtMultiplier,
    saturday_multiplier: input.saturdayMultiplier,
    sunday_multiplier: input.sundayMultiplier,
    holiday_multiplier: input.holidayMultiplier,
    holidays: [...new Set(input.holidays)].sort(),
    fringe_overtime_mode: input.fringeOvertimeMode,
  };
  const { error } = input.id
    ? await supabase.from('pw_overtime_rule_sets').update(payload).eq('id', input.id)
    : await supabase.from('pw_overtime_rule_sets').insert(payload);
  if (error) fail(error);
}

export async function setRuleSetReview(id: string, status: LegalReviewStatus, reviewer: string): Promise<void> {
  if (status === 'approved' && reviewer.trim().length < 2) throw new Error('Enter the name of the attorney or compliance professional who reviewed this.');
  const { error } = await supabase
    .from('pw_overtime_rule_sets')
    .update({
      legal_review_status: status,
      legal_reviewed_by: status === 'approved' ? reviewer.trim() : null,
      legal_reviewed_at: status === 'approved' ? new Date().toISOString() : null,
    })
    .eq('id', id);
  if (error) fail(error);
}

export async function deleteRuleSet(id: string): Promise<void> {
  const { error } = await supabase.from('pw_overtime_rule_sets').delete().eq('id', id);
  if (error) fail(error, 'Could not delete. A rule set that is assigned to a job or used in a payroll cannot be deleted — deactivate it instead.');
}

// ------------------------------------------------------------------
// Jobs, workers, assignments
// ------------------------------------------------------------------

export async function fetchJobsLite(): Promise<JobLite[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, service_type, address')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) fail(error);
  return (data as JobLite[] | null) ?? [];
}

export async function fetchEmployeesLite(): Promise<EmployeeLite[]> {
  const { data, error } = await supabase.from('employees').select('id, full_name, hourly_rate_cents, active').order('full_name');
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: String(r.id),
    fullName: String(r.full_name),
    hourlyRateCents: optNum(r.hourly_rate_cents),
    active: Boolean(r.active),
  }));
}

export async function fetchAssignments(): Promise<JobAssignment[]> {
  const { data, error } = await supabase.from('pw_job_assignments').select('*').order('created_at', { ascending: false });
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map(toAssignment);
}

export async function saveAssignment(input: JobAssignmentInput): Promise<void> {
  const payload = {
    job_id: input.jobId,
    determination_id: input.determinationId,
    rule_set_id: input.ruleSetId,
    project_name: input.projectName?.trim() || null,
    contract_number: input.contractNumber?.trim() || null,
    awarding_agency: input.awardingAgency?.trim() || null,
    prime_contractor: input.primeContractor?.trim() || null,
    project_location: input.projectLocation?.trim() || null,
    contractor_name: input.contractorName?.trim() || null,
    contractor_address: input.contractorAddress?.trim() || null,
    is_certified_payroll: input.isCertifiedPayroll,
    rate_lock_date: input.rateLockDate || null,
    notes: input.notes?.trim() || null,
  };
  const { error } = await supabase.from('pw_job_assignments').upsert(payload, { onConflict: 'job_id' });
  if (error) fail(error);
}

export async function deleteAssignment(jobId: string): Promise<void> {
  const { error } = await supabase.from('pw_job_assignments').delete().eq('job_id', jobId);
  if (error) fail(error);
}

export async function fetchJobWorkers(jobId: string): Promise<JobWorker[]> {
  const { data, error } = await supabase.from('pw_job_workers').select('*').eq('job_id', jobId).order('effective_from');
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map(toJobWorker);
}

export async function saveJobWorker(input: Omit<JobWorker, 'id'>): Promise<void> {
  const { error } = await supabase.from('pw_job_workers').upsert(
    { job_id: input.jobId, employee_id: input.employeeId, classification: input.classification.trim().replace(/\s+/g, ' '), effective_from: input.effectiveFrom },
    { onConflict: 'job_id,employee_id,effective_from' },
  );
  if (error) fail(error);
}

export async function deleteJobWorker(id: string): Promise<void> {
  const { error } = await supabase.from('pw_job_workers').delete().eq('id', id);
  if (error) fail(error);
}

export async function fetchWorkerProfiles(): Promise<WorkerProfile[]> {
  const { data, error } = await supabase.from('pw_worker_profiles').select('*');
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map(toProfile);
}

export async function saveWorkerProfile(input: WorkerProfileInput): Promise<void> {
  const { error } = await supabase.from('pw_worker_profiles').upsert(
    {
      employee_id: input.employeeId,
      default_classification: input.defaultClassification?.trim() || null,
      worker_id_last4: input.workerIdLast4?.trim() || null,
      address: input.address?.trim() || null,
      fringe_plan_cents_per_hour: input.fringePlanCentsPerHour,
      fringe_plan_description: input.fringePlanDescription?.trim() || null,
      apprentice_registration: input.apprenticeRegistration?.trim() || null,
    },
    { onConflict: 'employee_id' },
  );
  if (error) fail(error);
}

export async function fetchAuditLog(limit = 40): Promise<AuditEntry[]> {
  const { data, error } = await supabase
    .from('pw_audit_log')
    .select('id, table_name, action, actor, old_data, new_data, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error);
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: String(r.id),
    tableName: String(r.table_name),
    action: r.action as AuditEntry['action'],
    createdAt: String(r.created_at),
    actor: str(r.actor),
    oldData: (r.old_data as Row | null) ?? null,
    newData: (r.new_data as Row | null) ?? null,
  }));
}

// ------------------------------------------------------------------
// Computation (reads approved timesheets, runs the pure engine)
// ------------------------------------------------------------------

const TIMESHEET_LIMIT = 5000;

export interface JobWeekComputation {
  assignment: JobAssignment;
  determination: Determination;
  ruleSet: RuleSetRow;
  rates: WageRateRow[];
  result: ComputeResult;
  meta: Omit<ReportMeta, 'isFinal' | 'noWork'>;
}

export async function computeJobWeek(jobId: string, weekEnding: string): Promise<JobWeekComputation> {
  const { data: aRow, error: aErr } = await supabase.from('pw_job_assignments').select('*').eq('job_id', jobId).maybeSingle();
  if (aErr) fail(aErr);
  if (!aRow) throw new Error('Set up prevailing wage for this job first (Job setup tab).');
  const assignment = toAssignment(aRow as Row);

  const [detRes, rsRes, rateRes] = await Promise.all([
    supabase.from('pw_wage_determinations').select('*').eq('id', assignment.determinationId).single(),
    supabase.from('pw_overtime_rule_sets').select('*').eq('id', assignment.ruleSetId).single(),
    fetchRates(assignment.determinationId),
  ]);
  if (detRes.error) fail(detRes.error);
  if (rsRes.error) fail(rsRes.error);
  const determination = toDetermination(detRes.data as Row);
  const ruleSet = toRuleSet(rsRes.data as Row);

  const weekStart = addDays(weekEnding, -6);
  const { data: tsData, error: tsErr } = await supabase
    .from('timesheets')
    .select('id, employee_id, work_date, regular_hours, overtime_hours, job_id, status')
    .gte('work_date', weekStart)
    .lte('work_date', weekEnding)
    .in('status', ['approved', 'pending'])
    .limit(TIMESHEET_LIMIT);
  if (tsErr) fail(tsErr);
  const sheets = (tsData as Row[] | null) ?? [];
  if (sheets.length >= TIMESHEET_LIMIT) throw new Error('Too many timesheet rows for one week to process safely. Contact support.');

  const approved = sheets.filter((s) => s.status === 'approved');
  const pendingEntryCount = sheets.length - approved.length;
  const entries: TimeEntry[] = approved.map((s) => ({
    id: String(s.id),
    employeeId: String(s.employee_id),
    workDate: String(s.work_date),
    hours: num(s.regular_hours) + num(s.overtime_hours),
    jobId: str(s.job_id),
  }));

  const employeeIds = [...new Set(entries.map((e) => e.employeeId))];
  const otherJobIds = [...new Set(entries.map((e) => e.jobId).filter((j): j is string => !!j && j !== jobId))];

  const [emps, profiles, jobWorkers, others] = await Promise.all([
    employeeIds.length ? supabase.from('employees').select('id, full_name, hourly_rate_cents').in('id', employeeIds) : Promise.resolve({ data: [], error: null }),
    fetchWorkerProfiles(),
    fetchJobWorkers(jobId),
    otherJobIds.length ? supabase.from('pw_job_assignments').select('job_id, rule_set_id').in('job_id', otherJobIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (emps.error) fail(emps.error);
  if (others.error) fail(others.error);

  const profileByEmp = new Map(profiles.map((p) => [p.employeeId, p]));
  const workers: WorkerInfo[] = ((emps.data as Row[] | null) ?? []).map((e) => {
    const p = profileByEmp.get(String(e.id));
    return {
      employeeId: String(e.id),
      name: String(e.full_name),
      workerIdLast4: p?.workerIdLast4 ?? null,
      address: p?.address ?? null,
      defaultClassification: p?.defaultClassification ?? null,
      hourlyRateCents: optNum(e.hourly_rate_cents),
      fringePlanCentsPerHour: p?.fringePlanCentsPerHour ?? 0,
    };
  });
  const jobWorkerClasses: JobWorkerClassification[] = jobWorkers.map((w) => ({ employeeId: w.employeeId, classification: w.classification, effectiveFrom: w.effectiveFrom }));
  const mixedRuleSets = ((others.data as Row[] | null) ?? []).some((r) => String(r.rule_set_id) !== assignment.ruleSetId);

  const result = computeCertifiedPayroll({
    jobId,
    weekEnding,
    rules: ruleSet,
    determination: {
      id: determination.id,
      name: determination.name,
      effectiveFrom: determination.effectiveFrom,
      effectiveTo: determination.effectiveTo,
      legalReviewStatus: determination.legalReviewStatus,
    },
    rates: rateRes,
    entries,
    workers,
    jobWorkerClasses,
    pendingEntryCount,
    mixedRuleSets,
  });

  return {
    assignment,
    determination,
    ruleSet,
    rates: rateRes,
    result,
    meta: {
      contractorName: assignment.contractorName ?? '',
      contractorAddress: assignment.contractorAddress ?? '',
      projectName: assignment.projectName ?? '',
      contractNumber: assignment.contractNumber ?? '',
      awardingAgency: assignment.awardingAgency ?? '',
      primeContractor: assignment.primeContractor ?? '',
      projectLocation: assignment.projectLocation ?? '',
      determinationName: determination.name,
      determinationNumber: determination.determinationNumber ?? '',
      determinationRevision: determination.revision ?? '',
      program: PROGRAM_LABEL[determination.program],
      ruleSetName: ruleSet.name,
    },
  };
}

// ------------------------------------------------------------------
// Reports
// ------------------------------------------------------------------

export async function fetchReports(jobId?: string): Promise<ReportRow[]> {
  let q = supabase.from('pw_certified_reports').select(REPORT_COLUMNS).order('week_ending', { ascending: false }).order('payroll_number', { ascending: false }).limit(200);
  if (jobId) q = q.eq('job_id', jobId);
  const { data, error } = await q;
  if (error) fail(error);
  return ((data as unknown as Row[] | null) ?? []).map(toReport);
}

export async function fetchReport(id: string): Promise<ReportFull> {
  const { data, error } = await supabase.from('pw_certified_reports').select(`${REPORT_COLUMNS}, snapshot`).eq('id', id).single();
  if (error) fail(error);
  const row = data as unknown as Row;
  return { ...toReport(row), snapshot: row.snapshot as ReportSnapshot };
}

export interface SaveDraftInput {
  jobId: string;
  weekEnding: string;
  isFinal: boolean;
  noWork: boolean;
  deductions: Record<string, ReportDeductions>;
}

/** Recomputes from current data and stores (or replaces) the draft for this job + week. */
export async function saveDraft(input: SaveDraftInput): Promise<{ reportId: string; computation: JobWeekComputation; snapshot: ReportSnapshot }> {
  const computation = await computeJobWeek(input.jobId, input.weekEnding);
  if (input.noWork && computation.result.lines.length > 0) throw new Error('This week has approved hours on the job, so it cannot be filed as "no work performed".');
  const snapshot = buildReportSnapshot(
    computation.result,
    computation.ruleSet,
    { ...computation.meta, isFinal: input.isFinal, noWork: input.noWork },
    input.deductions,
  );
  const { data, error } = await supabase.rpc('pw_save_report', {
    p_job_id: input.jobId,
    p_week_ending: input.weekEnding,
    p_snapshot: snapshot,
    p_is_final: input.isFinal,
    p_no_work: input.noWork,
  });
  if (error) fail(error);
  return { reportId: data as string, computation, snapshot };
}

export interface CertifyInput extends SaveDraftInput {
  signerName: string;
  signerTitle: string;
}

/** Refreshes the draft from current data, then certifies it — so a certified payroll is never stale. */
export async function certifyFresh(input: CertifyInput): Promise<string> {
  const { reportId, computation } = await saveDraft(input);
  if (computation.result.certifyBlockers.length > 0) throw new Error(computation.result.certifyBlockers.join(' '));
  const { error } = await supabase.rpc('pw_certify_report', { p_report_id: reportId, p_name: input.signerName, p_title: input.signerTitle || null });
  if (error) fail(error);
  return reportId;
}

export async function voidReport(reportId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('pw_void_report', { p_report_id: reportId, p_reason: reason });
  if (error) fail(error);
}

export async function discardDraft(reportId: string): Promise<void> {
  const { error } = await supabase.rpc('pw_discard_draft', { p_report_id: reportId });
  if (error) fail(error);
}
