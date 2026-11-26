import { csvCell } from '../safety/core.ts';

/**
 * OSHA recordkeeping (Forms 300 / 300A / 301) — pure logic, roadmap item 109.
 * The database (migration 20290312000000_osha_recordkeeping.sql) is the authority: every rule here that
 * the SQL also enforces is mirrored only to give the user an instant message, and the unit test fails
 * if the two lists of allowed values drift apart. Nothing here is legal advice (`TODO(counsel)`).
 */

export const CLASSIFICATIONS = ['death', 'days_away', 'job_transfer_restriction', 'other_recordable'] as const;
export const ILLNESS_TYPES = ['injury', 'skin_disorder', 'respiratory', 'poisoning', 'hearing_loss', 'other_illness'] as const;
export const PRIVACY_REASONS = ['intimate_body_part', 'sexual_assault', 'mental_illness', 'infectious_disease', 'needlestick_sharps', 'employee_request'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type IllnessType = (typeof ILLNESS_TYPES)[number];
export type PrivacyReason = (typeof PRIVACY_REASONS)[number];

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  death: 'Death',
  days_away: 'Days away from work',
  job_transfer_restriction: 'Job transfer or restriction',
  other_recordable: 'Other recordable case',
};
export const ILLNESS_LABEL: Record<IllnessType, string> = {
  injury: 'Injury',
  skin_disorder: 'Skin disorder',
  respiratory: 'Respiratory condition',
  poisoning: 'Poisoning',
  hearing_loss: 'Hearing loss',
  other_illness: 'All other illnesses',
};
export const PRIVACY_REASON_LABEL: Record<PrivacyReason, string> = {
  intimate_body_part: 'Injury to an intimate body part',
  sexual_assault: 'Sexual assault',
  mental_illness: 'Mental illness',
  infectious_disease: 'Infectious disease (e.g. HIV, hepatitis, TB)',
  needlestick_sharps: 'Needlestick / sharps injury',
  employee_request: 'Employee requested privacy',
};

/** Mirrors the CHECK constraints (180-day cap is `TODO(counsel)`). */
export const MAX_COUNTED_DAYS = 180;
export const MIN_RETENTION_YEARS = 5;
export const DEFAULT_RETENTION_YEARS = 5;
export const PRIVACY_CASE_LABEL = 'Privacy Case';

export interface OshaCaseInput {
  incident_id?: string | null;
  employee_member_id?: string | null;
  employee_name: string;
  employee_address?: string | null;
  employee_dob?: string | null;
  date_hired?: string | null;
  employee_sex?: 'male' | 'female' | null;
  job_title: string;
  privacy_case?: boolean;
  privacy_reason?: PrivacyReason | null;
  date_of_injury: string;
  time_began_work?: string | null;
  time_of_event?: string | null;
  location_where?: string | null;
  description: string;
  activity_before?: string | null;
  how_occurred?: string | null;
  injury_nature?: string | null;
  object_substance?: string | null;
  classification: Classification;
  days_away?: number;
  days_restricted?: number;
  illness_type: IllnessType;
  died_on?: string | null;
  treated_in_er?: boolean | null;
  hospitalized_overnight?: boolean | null;
  treatment_facility?: string | null;
  physician_name?: string | null;
}

export interface OshaCaseRow extends Required<Pick<OshaCaseInput, 'employee_name' | 'job_title' | 'date_of_injury' | 'description' | 'classification' | 'illness_type'>> {
  id: string;
  case_year: number;
  case_seq: number;
  case_no: string;
  incident_id: string | null;
  location_where: string | null;
  days_away: number;
  days_restricted: number;
  privacy_case: boolean;
  voided_at: string | null;
  retain_until: string;
}

export interface OshaLogRow {
  case_no: string;
  employee_name: string;
  job_title: string;
  date_of_injury: string;
  location_where: string | null;
  description: string;
  classification: Classification;
  days_away: number;
  days_restricted: number;
  illness_type: IllnessType;
  privacy_case: boolean;
}

export interface OshaTotals {
  deaths: number;
  days_away_cases: number;
  job_transfer_cases: number;
  other_recordable_cases: number;
  total_days_away: number;
  total_days_restricted: number;
  injuries: number;
  skin_disorders: number;
  respiratory_conditions: number;
  poisonings: number;
  hearing_loss: number;
  other_illnesses: number;
  total_cases: number;
}

export interface OshaSummaryExport {
  year: number;
  establishment: { establishment_name: string | null; street: string | null; city: string | null; state: string | null; zip: string | null; industry_description: string | null; naics_code: string | null } | null;
  avg_employees: number | null;
  total_hours: number | null;
  totals: OshaTotals;
  certification: { name: string; title: string; phone: string | null; at: string } | null;
  missing: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s: string | null | undefined): s is string => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const todayIso = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Instant client-side check. The database re-validates everything. Returns human messages; [] means OK. */
export function validateCaseInput(i: OshaCaseInput, now: Date = new Date()): string[] {
  const e: string[] = [];
  if (!i.employee_name?.trim()) e.push('Enter the employee’s name.');
  if (!i.job_title?.trim()) e.push('Enter the job title.');
  if (!i.description?.trim() || i.description.trim().length < 3) e.push('Describe the injury or illness.');
  if (!isIsoDate(i.date_of_injury)) e.push('Enter a valid date of injury.');
  else if (i.date_of_injury > todayIso(now)) e.push('The date of injury cannot be in the future.');
  if (!(CLASSIFICATIONS as readonly string[]).includes(i.classification)) e.push('Choose the most serious outcome.');
  if (!(ILLNESS_TYPES as readonly string[]).includes(i.illness_type)) e.push('Choose the type of injury or illness.');
  for (const [label, v] of [['Days away', i.days_away ?? 0], ['Days of restriction', i.days_restricted ?? 0]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_COUNTED_DAYS) e.push(`${label} must be a whole number from 0 to ${MAX_COUNTED_DAYS}.`);
  }
  if (i.classification === 'death') {
    if (!isIsoDate(i.died_on)) e.push('Enter the date of death.');
    else if (isIsoDate(i.date_of_injury) && i.died_on < i.date_of_injury) e.push('The date of death cannot be before the injury.');
  }
  if (i.privacy_case !== true && i.privacy_reason) e.push('Turn on “Privacy case” to record a privacy reason.');
  if (i.privacy_reason && !(PRIVACY_REASONS as readonly string[]).includes(i.privacy_reason)) e.push('Unknown privacy reason.');
  return e;
}

/** Dec 31 of the case year plus the retention period (never below the minimum). Same formula as the SQL. */
export function computeRetainUntil(caseYear: number, retentionYears: number): string {
  const years = Math.max(MIN_RETENTION_YEARS, Math.floor(Number.isFinite(retentionYears) ? retentionYears : DEFAULT_RETENTION_YEARS));
  return `${caseYear + years}-12-31`;
}
export const isPastRetention = (retainUntil: string, today: string): boolean => retainUntil < today;

/** A privacy case never shows the employee's name on the log. */
export const logName = (r: { employee_name: string; privacy_case: boolean }): string => (r.privacy_case ? PRIVACY_CASE_LABEL : r.employee_name);

/** Form 301 / 300 prefill from a safety incident. The user must still confirm every field. */
export function caseDraftFromIncident(inc: { id: string; occurred_at: string; description: string }): Pick<OshaCaseInput, 'incident_id' | 'date_of_injury' | 'description'> {
  const d = new Date(inc.occurred_at);
  return { incident_id: inc.id, date_of_injury: Number.isNaN(d.getTime()) ? '' : todayIso(d), description: inc.description.slice(0, 2000) };
}

export function summaryMissingLabels(missing: string[]): string[] {
  const map: Record<string, string> = {
    establishment_name: 'Establishment name',
    establishment_address: 'Establishment address',
    avg_employees: 'Annual average number of employees',
    total_hours: 'Total hours worked by all employees',
  };
  return missing.map((m) => map[m] ?? m);
}

const mark = (b: boolean) => (b ? 'X' : '');

/** Form 300 columns as CSV (UTF-8; caller adds the BOM). Privacy cases are already masked by the server. */
export function logToCsv(rows: OshaLogRow[]): string {
  const head = ['Case no.', 'Employee name', 'Job title', 'Date of injury or onset', 'Where the event occurred', 'Describe injury or illness',
    'Death', 'Days away from work', 'Job transfer or restriction', 'Other recordable cases', 'Days away', 'Days on transfer or restriction',
    'Injury', 'Skin disorder', 'Respiratory condition', 'Poisoning', 'Hearing loss', 'All other illnesses'];
  const body = rows.map((r) => [
    r.case_no, logName(r), r.job_title, r.date_of_injury, r.location_where ?? '', r.description,
    mark(r.classification === 'death'), mark(r.classification === 'days_away'), mark(r.classification === 'job_transfer_restriction'), mark(r.classification === 'other_recordable'),
    r.days_away, r.days_restricted,
    mark(r.illness_type === 'injury'), mark(r.illness_type === 'skin_disorder'), mark(r.illness_type === 'respiratory'),
    mark(r.illness_type === 'poisoning'), mark(r.illness_type === 'hearing_loss'), mark(r.illness_type === 'other_illness'),
  ]);
  return [head, ...body].map((l) => l.map(csvCell).join(',')).join('\r\n');
}

/** Form 300A as label,value CSV. Rows for inputs that are still missing stay empty rather than 0. */
export function summaryToCsv(s: OshaSummaryExport): string {
  const t = s.totals;
  const est = s.establishment;
  const rows: Array<[string, unknown]> = [
    ['Year', s.year],
    ['Establishment name', est?.establishment_name ?? ''],
    ['Street', est?.street ?? ''], ['City', est?.city ?? ''], ['State', est?.state ?? ''], ['ZIP', est?.zip ?? ''],
    ['Industry description', est?.industry_description ?? ''], ['NAICS', est?.naics_code ?? ''],
    ['Annual average number of employees', s.avg_employees ?? ''],
    ['Total hours worked by all employees', s.total_hours ?? ''],
    ['Total number of deaths', t.deaths],
    ['Total number of cases with days away from work', t.days_away_cases],
    ['Total number of cases with job transfer or restriction', t.job_transfer_cases],
    ['Total number of other recordable cases', t.other_recordable_cases],
    ['Total number of days away from work', t.total_days_away],
    ['Total number of days of job transfer or restriction', t.total_days_restricted],
    ['Injuries', t.injuries], ['Skin disorders', t.skin_disorders], ['Respiratory conditions', t.respiratory_conditions],
    ['Poisonings', t.poisonings], ['Hearing loss', t.hearing_loss], ['All other illnesses', t.other_illnesses],
    ['Certified by', s.certification?.name ?? ''], ['Title', s.certification?.title ?? ''],
    ['Phone', s.certification?.phone ?? ''], ['Certified at', s.certification?.at ?? ''],
  ];
  return rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`).join('\r\n');
}

/** Average of employees and hours are typed by the owner; keep them as safe integers. */
export function parseWholeNumber(text: string, max: number): number | null {
  const s = text.trim().replace(/,/g, '');
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}
