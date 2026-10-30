/**
 * Refrigerant Leak-Repair Loop — client domain logic + API.
 *
 * A regulated appliance (>= 15 lb, GWP > 53) whose leak rate exceeds its
 * category threshold gets a leak case (opened server-side by a trigger on
 * refrigerant_log). Every live case always has a dated next action:
 *
 *   open -> initial_verified -> verified -> followup_scheduled -> closed
 *   (any live state) -> failed -> retrofit / retire plan -> closed
 *   (any live state) -> voided (owner only)
 *
 * EXTENDS refrigerantCompliance.ts (constants, computeLeakRate, certification
 * check, CSV helper) instead of duplicating it. The SQL counterpart is
 * supabase/migrations/*_refrigerant_leak_repair_loop.sql, which enforces every
 * rule server-side; this file gives the UI early, friendly answers and holds the
 * date maths so it can be unit-tested. Figures follow EPA 40 CFR Part 84
 * Subpart C as commonly summarised — NOT legal advice.
 *
 * Vireek PREPARES the chronic-leak (HAWK) data and never files anything with EPA.
 */

import { supabase } from '@/lib/supabase';
import type { CsvColumn } from '@/lib/csvExport';
import {
  ALD_MAX_CALIBRATION_AGE_DAYS,
  ANNUAL_INSPECTION_COUNT,
  CATEGORY_LABELS,
  CHRONIC_LEAK_PCT,
  LEAK_DUE_SOON_DAYS,
  LEAK_FOLLOWUP_TEST_DAYS,
  LEAK_RETROFIT_COMPLETE_YEARS,
  LEAK_RETROFIT_PLAN_DAYS,
  QUARTERLY_INSPECTION_COUNT,
  QUARTERLY_INSPECTION_MIN_LBS,
  RECORD_RETENTION_YEARS,
  checkTechnicianCertification,
  computeLeakRate,
  isRegulatedAppliance,
  type ApplianceCategory,
  type CertCheck,
  type CredentialLike,
  type LeakRateResult,
  type RefrigerantEntry,
} from '@/lib/refrigerantCompliance';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type LeakCaseStatus =
  'open' | 'initial_verified' | 'verified' | 'followup_scheduled' | 'failed' | 'closed' | 'voided';

export type LeakNextAction =
  | 'initial_verification'
  | 'followup_verification'
  | 'schedule_followup'
  | 'followup_inspection'
  | 'submit_retrofit_plan'
  | 'complete_retrofit';

export type LeakCloseReason = 'follow_up_passed' | 'ald_waiver' | 'retrofitted' | 'retired';
export type VerificationKind = 'initial' | 'followup';
export type TestResult = 'pass' | 'fail';
export type TestMethod =
  'electronic_leak_detector' | 'bubble_solution' | 'pressure_decay' | 'ultrasonic' | 'other';
export type InspectionCadence = 'quarterly' | 'annual';
export type InspectionStatus = 'scheduled' | 'completed' | 'failed' | 'waived' | 'cancelled';
export type PlanStatus = 'draft' | 'approved' | 'completed' | 'cancelled';
export type PlanOption = 'retrofit' | 'retire';
export type LeakUrgency = 'overdue' | 'due_soon' | 'on_track' | 'none';

export interface LeakCase {
  id: string;
  equipment_id: string | null;
  customer_id: string | null;
  trigger_entry_id: string | null;
  equipment_label: string | null;
  equipment_serial: string | null;
  site_address: string | null;
  customer_name: string | null;
  refrigerant_type: string | null;
  charge_lbs: number;
  appliance_category: ApplianceCategory;
  threshold_pct: number;
  rate_pct: number;
  status: LeakCaseStatus;
  detected_at: string;
  opened_at: string;
  repair_due_at: string;
  initial_verified_at: string | null;
  normal_operation_on: string | null;
  followup_test_due_on: string | null;
  verified_at: string | null;
  followup_cadence: InspectionCadence | null;
  failed_at: string | null;
  failure_reason: string | null;
  closed_at: string | null;
  close_reason: LeakCloseReason | null;
  voided_at: string | null;
  void_reason: string | null;
  chronic_flagged_at: string | null;
  next_action: LeakNextAction | null;
  next_action_due_at: string | null;
  retain_until: string;
  created_at: string;
}

export interface LeakVerificationTest {
  id: string;
  case_id: string;
  kind: VerificationKind;
  result: TestResult;
  performed_at: string;
  on_time: boolean;
  method: TestMethod;
  technician_id: string | null;
  technician_name: string | null;
  cert_type: string;
  cert_number: string | null;
  notes: string | null;
  signed_at: string;
}

export interface LeakInspection {
  id: string;
  case_id: string;
  period_index: number;
  cadence: InspectionCadence;
  due_date: string;
  status: InspectionStatus;
  job_id: string | null;
  completed_at: string | null;
  technician_name: string | null;
  result: TestResult | null;
  notes: string | null;
  waived_reason: string | null;
}

export interface LeakRetrofitPlan {
  id: string;
  case_id: string;
  status: PlanStatus;
  plan_due_on: string;
  complete_by: string;
  option: PlanOption | null;
  proposed_refrigerant: string | null;
  notes: string | null;
  approved_at: string | null;
  completed_on: string | null;
}

export interface LeakCaseEvent {
  id: string;
  case_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  detail: string | null;
  created_at: string;
}

export interface LeakSummary {
  active: number;
  overdue: number;
  due_soon: number;
  failed: number;
  chronic: number;
}

export interface ChronicCandidate {
  equipment_id: string;
  customer_name: string | null;
  site_address: string | null;
  equipment_label: string | null;
  equipment_serial: string | null;
  refrigerant_type: string | null;
  appliance_category: ApplianceCategory;
  charge_lbs: number;
  pounds_added: number;
  leak_rate_pct: number;
  additions: number;
  first_addition_at: string;
  last_addition_at: string;
  case_count: number;
  latest_case_status: LeakCaseStatus | null;
  year: number;
}

/* ------------------------------------------------------------------ */
/*  Labels                                                              */
/* ------------------------------------------------------------------ */

export const STATUS_LABELS: Record<LeakCaseStatus, string> = {
  open: 'Open — repair + first test due',
  initial_verified: 'First test passed',
  verified: 'Verified',
  followup_scheduled: 'Follow-up inspections scheduled',
  failed: 'Repair failed — retrofit / retire',
  closed: 'Closed',
  voided: 'Voided',
};

export const NEXT_ACTION_LABELS: Record<LeakNextAction, string> = {
  initial_verification: 'Complete repair and sign the initial verification test',
  followup_verification: 'Sign the follow-up verification test',
  schedule_followup: 'Schedule follow-up inspections',
  followup_inspection: 'Complete the follow-up inspection',
  submit_retrofit_plan: 'Submit the retrofit / retire plan',
  complete_retrofit: 'Complete the retrofit / retirement',
};

export const CLOSE_REASON_LABELS: Record<LeakCloseReason, string> = {
  follow_up_passed: 'Follow-up inspections passed',
  ald_waiver: 'Follow-ups waived (calibrated ALD)',
  retrofitted: 'Retrofitted',
  retired: 'Retired',
};

export const METHOD_LABELS: Record<TestMethod, string> = {
  electronic_leak_detector: 'Electronic leak detector',
  bubble_solution: 'Bubble solution',
  pressure_decay: 'Pressure decay',
  ultrasonic: 'Ultrasonic',
  other: 'Other',
};

export const TEST_KIND_LABELS: Record<VerificationKind, string> = {
  initial: 'Initial verification test',
  followup: 'Follow-up verification test',
};

export const LEGAL_NOTICE =
  'Prepared from your own records under EPA 40 CFR Part 84 Subpart C as commonly summarised. ' +
  'This is not legal advice; confirm requirements against the current regulation. Vireek never files anything with EPA.';

/* ------------------------------------------------------------------ */
/*  Date maths (UTC days, "YYYY-MM-DD") — mirrors the SQL helpers        */
/* ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

/** YYYY-MM-DD (UTC) of a Date or ISO string. */
export function utcDay(d: Date | string): string {
  return (typeof d === 'string' ? new Date(d) : d).toISOString().slice(0, 10);
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** date + n months, clamped to the end of a short month (Jan 31 + 1 month = Feb 28) — same as Postgres. */
export function addMonths(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)))
    .toISOString()
    .slice(0, 10);
}

/** Whole days from `fromDay` to `toDay` (negative when `toDay` is earlier). */
export function daysBetween(fromDay: string, toDay: string): number {
  const a = parseDay(fromDay);
  const b = parseDay(toDay);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / MS_PER_DAY);
}

/** Second verification test is due 10 days after the first, or after return to normal operation if later. */
export function followUpTestDueOn(initialOn: string, normalOperationOn?: string | null): string {
  const base = normalOperationOn && normalOperationOn > initialOn ? normalOperationOn : initialOn;
  return addDays(base, LEAK_FOLLOWUP_TEST_DAYS);
}

export function inspectionCadence(chargeLbs: number): InspectionCadence {
  return chargeLbs >= QUARTERLY_INSPECTION_MIN_LBS ? 'quarterly' : 'annual';
}

/** Follow-up inspection dates, each anchored on the verification date (no drift). */
export function inspectionSchedule(
  verifiedOn: string,
  chargeLbs: number,
): { cadence: InspectionCadence; dueDates: string[] } {
  const cadence = inspectionCadence(chargeLbs);
  const count = cadence === 'quarterly' ? QUARTERLY_INSPECTION_COUNT : ANNUAL_INSPECTION_COUNT;
  const step = cadence === 'quarterly' ? 3 : 12;
  return {
    cadence,
    dueDates: Array.from({ length: count }, (_, i) => addMonths(verifiedOn, step * (i + 1))),
  };
}

/** Failed repair: retrofit/retire plan draft due in 30 days; completion within 1 year. */
export function retrofitDates(failedOn: string): { planDueOn: string; completeBy: string } {
  return {
    planDueOn: addDays(failedOn, LEAK_RETROFIT_PLAN_DAYS),
    completeBy: addMonths(failedOn, 12 * LEAK_RETROFIT_COMPLETE_YEARS),
  };
}

/** Records are kept 3 years from closure (or from opening while live). */
export function caseRetainUntil(anchor: string): string {
  return addMonths(utcDay(anchor), 12 * RECORD_RETENTION_YEARS);
}

/** Follow-up inspections are waived only for a calibrated ALD (calibration not older than a year at verification). */
export function aldWaiverApplies(input: {
  aldCalibrated: boolean;
  aldCalibratedOn: string | null | undefined;
  verifiedOn: string;
}): boolean {
  if (!input.aldCalibrated || !input.aldCalibratedOn) return false;
  return input.aldCalibratedOn >= addDays(input.verifiedOn, -ALD_MAX_CALIBRATION_AGE_DAYS);
}

/* ------------------------------------------------------------------ */
/*  Trigger evaluation (opens a case)                                   */
/* ------------------------------------------------------------------ */

export interface LeakTriggerInput {
  entries: Pick<RefrigerantEntry, 'id' | 'event_type' | 'pounds' | 'performed_at' | 'voided_at'>[];
  fullChargeLbs: number | null | undefined;
  category?: ApplianceCategory | null;
  refrigerantType?: string | null;
  installDate?: string | null;
  /** Latest verified repair / completed retrofit: additions at or before it no longer count. */
  baselineResetAt?: string | null;
  asOf?: Date;
}

export interface LeakTriggerResult {
  regulated: boolean;
  leak: LeakRateResult;
  /** true = a leak case must exist (regulated AND over the category threshold). */
  shouldOpenCase: boolean;
  /** repair deadline: the exceeding addition + 30 days. */
  repairDueAt: string | null;
}

export function evaluateLeakTrigger(input: LeakTriggerInput): LeakTriggerResult {
  const asOf = input.asOf ?? new Date();
  const cut = input.baselineResetAt ? new Date(input.baselineResetAt).getTime() : null;
  const entries = input.entries.filter(
    (e) => cut === null || new Date(e.performed_at).getTime() > cut,
  );
  const leak = computeLeakRate({
    entries,
    fullChargeLbs: input.fullChargeLbs,
    category: input.category,
    baselineDate: input.baselineResetAt ?? input.installDate ?? null,
    asOf,
  });
  const regulated = isRegulatedAppliance(input.fullChargeLbs, input.refrigerantType);
  return {
    regulated,
    leak,
    shouldOpenCase: regulated && leak.exceeds,
    repairDueAt: leak.repairDeadline,
  };
}

/** Calendar-year leak % (UTC) for the chronic-leaker rule: pounds added in `year` / full charge. */
export function calendarYearLeakPct(
  entries: Pick<RefrigerantEntry, 'event_type' | 'pounds' | 'performed_at' | 'voided_at'>[],
  fullChargeLbs: number | null | undefined,
  year: number,
): number | null {
  if (typeof fullChargeLbs !== 'number' || !(fullChargeLbs > 0)) return null;
  const added = entries
    .filter(
      (e) =>
        e.event_type === 'added' &&
        !e.voided_at &&
        new Date(e.performed_at).getUTCFullYear() === year,
    )
    .reduce((s, e) => s + e.pounds, 0);
  return Math.round((added / fullChargeLbs) * 1000) / 10;
}

export function isChronicLeaker(pct: number | null): boolean {
  return pct !== null && pct > CHRONIC_LEAK_PCT;
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Same transition map the database enforces. */
export const LEAK_TRANSITIONS: Record<LeakCaseStatus, readonly LeakCaseStatus[]> = {
  open: ['initial_verified', 'failed', 'voided'],
  initial_verified: ['verified', 'failed', 'voided'],
  verified: ['followup_scheduled', 'closed', 'failed', 'voided'],
  followup_scheduled: ['closed', 'failed', 'voided'],
  failed: ['closed', 'voided'],
  closed: [],
  voided: [],
};

export function canTransition(from: LeakCaseStatus, to: LeakCaseStatus): boolean {
  return LEAK_TRANSITIONS[from].includes(to);
}

export function isLive(status: LeakCaseStatus): boolean {
  return status !== 'closed' && status !== 'voided';
}

export interface LeakCaseLike {
  status: LeakCaseStatus;
  next_action: LeakNextAction | null;
  next_action_due_at: string | null;
}

/** The invariant the database enforces: a live case has a dated next action. */
export function hasDatedNextAction(c: LeakCaseLike): boolean {
  return !isLive(c.status) || (c.next_action !== null && Boolean(c.next_action_due_at));
}

/** Days until the next action (negative = overdue); null when there is none. */
export function daysToNextAction(c: LeakCaseLike, now: Date = new Date()): number | null {
  if (!isLive(c.status) || !c.next_action_due_at) return null;
  return daysBetween(utcDay(now), c.next_action_due_at.slice(0, 10));
}

export function leakUrgency(c: LeakCaseLike, now: Date = new Date()): LeakUrgency {
  const d = daysToNextAction(c, now);
  if (d === null) return 'none';
  if (d < 0) return 'overdue';
  return d <= LEAK_DUE_SOON_DAYS ? 'due_soon' : 'on_track';
}

/** Overdue first, then soonest due; finished cases last. */
export function sortCases<T extends LeakCaseLike & { opened_at: string }>(
  cases: T[],
  now = new Date(),
): T[] {
  return [...cases].sort((a, b) => {
    const da = daysToNextAction(a, now);
    const db = daysToNextAction(b, now);
    if (da === null && db === null) return b.opened_at.localeCompare(a.opened_at);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

/* ------------------------------------------------------------------ */
/*  Test signing                                                        */
/* ------------------------------------------------------------------ */

/** Early, friendly version of the server check: is the signer certified ON THE TEST DATE? */
export function checkTestSigner(
  credentials: CredentialLike[],
  technicianId: string | null | undefined,
  performedAt: Date,
  chargeLbs: number,
): CertCheck {
  return checkTechnicianCertification(credentials, technicianId, {
    chargeLbs,
    onDate: performedAt,
  });
}

export interface TestInput {
  kind: VerificationKind;
  result: TestResult;
  performedAt: string;
  technicianId: string;
  method: TestMethod | '';
  notes?: string;
  normalOperationOn?: string | null;
}

export function validateTest(
  input: Partial<TestInput>,
  c: Pick<LeakCase, 'status' | 'detected_at' | 'repair_due_at'>,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  if (input.kind !== 'initial' && input.kind !== 'followup') errors.push('Choose the test.');
  if (input.kind === 'initial' && c.status !== 'open')
    errors.push('The initial test can only be signed while the case is open.');
  if (input.kind === 'followup' && c.status !== 'initial_verified')
    errors.push('Sign the initial test first; the follow-up test comes after it.');
  if (input.result !== 'pass' && input.result !== 'fail') errors.push('Choose pass or fail.');
  if (!input.technicianId) errors.push('Choose the technician who signs.');
  if (!input.method) errors.push('Choose the test method.');
  if (!input.performedAt) errors.push('Enter the date and time of the test.');
  else {
    const t = new Date(input.performedAt).getTime();
    if (Number.isNaN(t)) errors.push('Test date is invalid.');
    else if (t > now.getTime() + 5 * 60_000) errors.push('Test date cannot be in the future.');
    else if (t < new Date(c.detected_at).getTime())
      errors.push('Test date is before the leak was detected.');
  }
  if (
    input.normalOperationOn &&
    input.kind === 'initial' &&
    input.performedAt &&
    input.normalOperationOn < utcDay(input.performedAt)
  )
    errors.push('Return-to-normal-operation date cannot be before the test.');
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Chronic-leak export for EPA HAWK (prepare only)                     */
/* ------------------------------------------------------------------ */

export const HAWK_EXPORT_NOTICE =
  'Prepared data only. Vireek does not submit anything to EPA. Verify field names and format against ' +
  "EPA's current HAWK instructions before you file.";

export const HAWK_COLUMNS: CsvColumn<ChronicCandidate>[] = [
  { header: 'Reporting year', accessor: (r) => r.year },
  { header: 'Facility / customer', accessor: (r) => r.customer_name ?? '' },
  { header: 'Site address', accessor: (r) => r.site_address ?? '' },
  { header: 'Appliance', accessor: (r) => r.equipment_label ?? '' },
  { header: 'Appliance serial', accessor: (r) => r.equipment_serial ?? '' },
  { header: 'Appliance category', accessor: (r) => CATEGORY_LABELS[r.appliance_category] },
  { header: 'Refrigerant', accessor: (r) => r.refrigerant_type ?? '' },
  { header: 'Full charge (lb)', accessor: (r) => Number(r.charge_lbs).toFixed(2) },
  { header: 'Refrigerant added in year (lb)', accessor: (r) => Number(r.pounds_added).toFixed(2) },
  { header: 'Leak rate (% of full charge)', accessor: (r) => Number(r.leak_rate_pct).toFixed(1) },
  { header: 'Number of additions', accessor: (r) => r.additions },
  { header: 'First addition (UTC)', accessor: (r) => new Date(r.first_addition_at).toISOString() },
  { header: 'Last addition (UTC)', accessor: (r) => new Date(r.last_addition_at).toISOString() },
  { header: 'Leak cases on record', accessor: (r) => r.case_count },
  {
    header: 'Latest case status',
    accessor: (r) => (r.latest_case_status ? STATUS_LABELS[r.latest_case_status] : ''),
  },
  { header: 'Appliance ID (Vireek)', accessor: (r) => r.equipment_id },
];

export function hawkFilename(year: number): string {
  return `hawk-chronic-leak-data_${year}_PREPARED-NOT-FILED.csv`;
}

/* ------------------------------------------------------------------ */
/*  Errors                                                              */
/* ------------------------------------------------------------------ */

const ERROR_MARKERS = [
  'leak_cert_required',
  'leak_case_invalid_state',
  'leak_signer_mismatch',
  'ald_flag_rpc_only',
] as const;

/** Turns the database's guard errors into something a technician can act on. */
export function friendlyLeakError(message: string): string {
  for (const m of ERROR_MARKERS) {
    if (message.includes(m)) {
      if (m === 'ald_flag_rpc_only')
        return 'The ALD flag can only be changed from the leak-case screen.';
      return message.replace(new RegExp(`^.*${m}:\\s*`), '');
    }
  }
  if (message.includes('immutable'))
    return 'This record is part of the compliance ledger and cannot be edited.';
  if (message.includes('Only the')) return message.replace(/^.*?(Only the)/, '$1');
  if (message.includes('permission denied')) return 'You do not have permission to do that.';
  return message.replace(/^leak (case|test|inspection): /, '');
}

/* ------------------------------------------------------------------ */
/*  API                                                                 */
/* ------------------------------------------------------------------ */

const CASE_COLUMNS =
  'id, equipment_id, customer_id, trigger_entry_id, equipment_label, equipment_serial, site_address, customer_name, refrigerant_type, charge_lbs, appliance_category, threshold_pct, rate_pct, status, detected_at, opened_at, repair_due_at, initial_verified_at, normal_operation_on, followup_test_due_on, verified_at, followup_cadence, failed_at, failure_reason, closed_at, close_reason, voided_at, void_reason, chronic_flagged_at, next_action, next_action_due_at, retain_until, created_at';

function numCase(row: LeakCase): LeakCase {
  return { ...row, charge_lbs: Number(row.charge_lbs), rate_pct: Number(row.rate_pct) };
}

export async function fetchLeakCases(): Promise<LeakCase[]> {
  const { data, error } = await supabase
    .from('leak_cases')
    .select(CASE_COLUMNS)
    .order('opened_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(friendlyLeakError(error.message));
  return ((data ?? []) as unknown as LeakCase[]).map(numCase);
}

export async function fetchLeakSummary(): Promise<LeakSummary> {
  const { data, error } = await supabase.rpc('leak_case_summary');
  if (error) throw new Error(friendlyLeakError(error.message));
  const s = (data ?? {}) as Partial<LeakSummary>;
  return {
    active: Number(s.active ?? 0),
    overdue: Number(s.overdue ?? 0),
    due_soon: Number(s.due_soon ?? 0),
    failed: Number(s.failed ?? 0),
    chronic: Number(s.chronic ?? 0),
  };
}

export interface LeakCaseDetail {
  tests: LeakVerificationTest[];
  inspections: LeakInspection[];
  plan: LeakRetrofitPlan | null;
  events: LeakCaseEvent[];
}

export async function fetchLeakCaseDetail(caseId: string): Promise<LeakCaseDetail> {
  const [tests, inspections, plan, events] = await Promise.all([
    supabase
      .from('leak_verification_tests')
      .select(
        'id, case_id, kind, result, performed_at, on_time, method, technician_id, technician_name, cert_type, cert_number, notes, signed_at',
      )
      .eq('case_id', caseId)
      .order('performed_at', { ascending: true }),
    supabase
      .from('leak_followup_inspections')
      .select(
        'id, case_id, period_index, cadence, due_date, status, job_id, completed_at, technician_name, result, notes, waived_reason',
      )
      .eq('case_id', caseId)
      .order('period_index', { ascending: true }),
    supabase
      .from('leak_retrofit_plans')
      .select(
        'id, case_id, status, plan_due_on, complete_by, option, proposed_refrigerant, notes, approved_at, completed_on',
      )
      .eq('case_id', caseId)
      .maybeSingle(),
    supabase
      .from('leak_case_events')
      .select('id, case_id, event_type, from_status, to_status, detail, created_at')
      .eq('case_id', caseId)
      .order('created_at', { ascending: true }),
  ]);
  for (const r of [tests, inspections, plan, events]) {
    if (r.error) throw new Error(friendlyLeakError(r.error.message));
  }
  return {
    tests: (tests.data ?? []) as LeakVerificationTest[],
    inspections: (inspections.data ?? []) as LeakInspection[],
    plan: (plan.data ?? null) as LeakRetrofitPlan | null,
    events: (events.data ?? []) as LeakCaseEvent[],
  };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(friendlyLeakError(error.message));
  return data;
}

export async function signVerificationTest(caseId: string, t: TestInput): Promise<void> {
  await rpc('record_leak_verification_test', {
    p_case_id: caseId,
    p_kind: t.kind,
    p_result: t.result,
    p_performed_at: new Date(t.performedAt).toISOString(),
    p_technician_id: t.technicianId,
    p_method: t.method,
    p_notes: t.notes?.trim() || null,
    p_normal_operation_on: t.normalOperationOn || null,
  });
}

export async function completeInspection(
  inspectionId: string,
  result: TestResult,
  technicianId: string | null,
  notes: string,
): Promise<void> {
  await rpc('complete_leak_inspection', {
    p_inspection_id: inspectionId,
    p_result: result,
    p_technician_id: technicianId,
    p_notes: notes.trim() || null,
  });
}

export async function saveRetrofitPlan(
  caseId: string,
  option: PlanOption | null,
  proposedRefrigerant: string,
  notes: string,
): Promise<void> {
  await rpc('save_leak_retrofit_plan', {
    p_case_id: caseId,
    p_option: option,
    p_proposed_refrigerant: proposedRefrigerant.trim() || null,
    p_notes: notes.trim() || null,
  });
}

export async function approveRetrofitPlan(caseId: string): Promise<void> {
  await rpc('approve_leak_retrofit_plan', { p_case_id: caseId });
}

export async function completeRetrofitPlan(
  caseId: string,
  completedOn: string,
  notes: string,
): Promise<void> {
  await rpc('complete_leak_retrofit_plan', {
    p_case_id: caseId,
    p_completed_on: completedOn || null,
    p_notes: notes.trim() || null,
  });
}

export async function voidLeakCase(caseId: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new Error('Give a reason of at least 5 characters.');
  await rpc('void_leak_case', { p_case_id: caseId, p_reason: reason.trim() });
}

export async function setAldFlag(
  equipmentId: string,
  calibrated: boolean,
  calibratedOn: string | null,
): Promise<void> {
  await rpc('set_equipment_ald_flag', {
    p_equipment_id: equipmentId,
    p_calibrated: calibrated,
    p_calibrated_on: calibrated ? calibratedOn : null,
  });
}

/** Opens cases for existing ledger data that exceeded a threshold before this feature existed. Returns how many opened. */
export async function scanLeakCases(): Promise<number> {
  return Number(await rpc('scan_leak_cases', {}));
}

export async function fetchChronicCandidates(year: number): Promise<ChronicCandidate[]> {
  const { data, error } = await supabase.rpc('leak_chronic_candidates', { p_year: year });
  if (error) throw new Error(friendlyLeakError(error.message));
  return ((data ?? []) as ChronicCandidate[]).map((r) => ({
    ...r,
    charge_lbs: Number(r.charge_lbs),
    pounds_added: Number(r.pounds_added),
    leak_rate_pct: Number(r.leak_rate_pct),
  }));
}

export interface UnitAld {
  id: string;
  ald_calibrated: boolean;
  ald_calibrated_on: string | null;
}

export async function fetchUnitAld(equipmentId: string): Promise<UnitAld | null> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, ald_calibrated, ald_calibrated_on')
    .eq('id', equipmentId)
    .maybeSingle();
  if (error) throw new Error(friendlyLeakError(error.message));
  return (data ?? null) as UnitAld | null;
}

/** Leak case that a field job belongs to (a follow-up inspection job), if any. */
export async function fetchInspectionForJob(
  jobId: string,
): Promise<(LeakInspection & { equipment_label: string | null }) | null> {
  const { data, error } = await supabase
    .from('leak_followup_inspections')
    .select(
      'id, case_id, period_index, cadence, due_date, status, job_id, completed_at, technician_name, result, notes, waived_reason',
    )
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) throw new Error(friendlyLeakError(error.message));
  return (data ?? null) as (LeakInspection & { equipment_label: string | null }) | null;
}

export interface LiveLeakCaseRef {
  id: string;
  equipment_id: string | null;
  equipment_label: string | null;
  status: LeakCaseStatus;
  next_action: LeakNextAction | null;
  next_action_due_at: string | null;
}

/** Live (not closed / voided) leak cases for a set of units — used by the job screen. */
export async function fetchLiveCasesForUnits(equipmentIds: string[]): Promise<LiveLeakCaseRef[]> {
  if (equipmentIds.length === 0) return [];
  const { data, error } = await supabase
    .from('leak_cases')
    .select('id, equipment_id, equipment_label, status, next_action, next_action_due_at')
    .in('equipment_id', equipmentIds)
    .not('status', 'in', '(closed,voided)');
  if (error) throw new Error(friendlyLeakError(error.message));
  return (data ?? []) as LiveLeakCaseRef[];
}
