/**
 * Workforce evidence (background-check / training COMPLETION FACTS) — presentation + validation.
 *
 * Data minimisation is the point: there is deliberately no field for a result, a finding, a report, a score,
 * a date of birth, an ID number or free-text notes. Validation here rejects values that look like such data
 * before they reach the database (the database CHECK constraints are the authority; this is the friendly layer).
 *
 * READINESS tooling: a completed record is not an attestation that the check or training was adequate.
 */

export const RECORD_TYPES = ['background_check', 'security_training', 'offboarding_checklist'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const RECORD_STATUSES = ['completed', 'waived'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export const WAIVER_CODES = ['role_not_applicable', 'not_required_by_policy', 'legal_restriction'] as const;
export type WaiverCode = (typeof WAIVER_CODES)[number];
export const TRAINING_COURSES = ['security_awareness_annual', 'secure_coding', 'privacy_data_handling', 'incident_reporting'] as const;

export type RequirementState = 'current' | 'waived' | 'expired' | 'missing';

export interface Requirement {
  requirement_key: string;
  record_type: 'background_check' | 'security_training';
  course_key: string;
  required: boolean;
  max_age_days: number | null;
  decided_at: string | null;
}

export interface MatrixCell {
  subject_id: string;
  subject_email: string;
  requirement_key: string;
  required: boolean;
  state: RequirementState;
  completed_on: string | null;
  valid_until: string | null;
  provider_label: string | null;
  waiver_code: WaiverCode | null;
}

export interface WorkforceOverview {
  generated_at: string;
  requirements: Requirement[];
  matrix: MatrixCell[];
}

export interface RecordInput {
  subjectId: string;
  recordType: RecordType;
  courseKey: string;
  status: RecordStatus;
  completedOn: string;
  validUntil: string;
  waiverCode: string;
  providerLabel: string;
  externalRef: string;
}

export type RecordError =
  | 'subject_required'
  | 'type_invalid'
  | 'course_required'
  | 'course_not_allowed'
  | 'date_required'
  | 'date_invalid'
  | 'date_future'
  | 'date_too_old'
  | 'valid_until_before'
  | 'waiver_required'
  | 'waiver_not_allowed'
  | 'provider_invalid'
  | 'reference_invalid';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const REF_RE = /^[A-Za-z0-9._-]{3,64}$/;

export function isIsoDay(v: string): boolean {
  if (!ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Rejects labels that look like personal data (emails, long digit runs, markup). */
export function isSafeProviderLabel(v: string): boolean {
  const t = v.trim();
  return t.length >= 2 && t.length <= 80 && !/[@<>]/.test(t) && !/\d{6,}/.test(t);
}

export function validateRecordInput(i: RecordInput, today: string): RecordError[] {
  const e: RecordError[] = [];
  if (!i.subjectId) e.push('subject_required');
  if (!RECORD_TYPES.includes(i.recordType)) e.push('type_invalid');
  if (i.recordType === 'security_training' && !i.courseKey) e.push('course_required');
  if (i.recordType !== 'security_training' && i.courseKey) e.push('course_not_allowed');

  if (i.status === 'completed') {
    if (!i.completedOn) e.push('date_required');
    else if (!isIsoDay(i.completedOn)) e.push('date_invalid');
    else {
      if (i.completedOn > today) e.push('date_future');
      const oldest = new Date(`${today}T00:00:00Z`);
      oldest.setUTCDate(oldest.getUTCDate() - 1830);
      if (i.completedOn < oldest.toISOString().slice(0, 10)) e.push('date_too_old');
      if (i.validUntil && (!isIsoDay(i.validUntil) || i.validUntil < i.completedOn)) e.push('valid_until_before');
    }
    if (i.waiverCode) e.push('waiver_not_allowed');
  } else {
    if (!i.waiverCode || !(WAIVER_CODES as readonly string[]).includes(i.waiverCode)) e.push('waiver_required');
  }
  if (i.providerLabel.trim() && !isSafeProviderLabel(i.providerLabel)) e.push('provider_invalid');
  if (i.externalRef.trim() && !REF_RE.test(i.externalRef.trim())) e.push('reference_invalid');
  return e;
}

export interface WorkforceSummary {
  activeStaff: number;
  requiredRequirements: number;
  gaps: number;
  byRequirement: Record<string, Record<RequirementState, number>>;
}

export function summarizeWorkforce(o: WorkforceOverview): WorkforceSummary {
  const byRequirement: WorkforceSummary['byRequirement'] = {};
  const staff = new Set<string>();
  let gaps = 0;
  for (const c of o.matrix) {
    staff.add(c.subject_id);
    const bucket = (byRequirement[c.requirement_key] ??= { current: 0, waived: 0, expired: 0, missing: 0 });
    bucket[c.state] += 1;
    if (c.required && (c.state === 'expired' || c.state === 'missing')) gaps += 1;
  }
  return { activeStaff: staff.size, requiredRequirements: o.requirements.filter((r) => r.required).length, gaps, byRequirement };
}

/** Defence in depth for the UI: anything not matching the narrow patterns is refused, never silently trimmed. */
export const SENSITIVE_FIELD_NOTICE_KEYS = ['noResults', 'noDocuments', 'noNotes'] as const;
