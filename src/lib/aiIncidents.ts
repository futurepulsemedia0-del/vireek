// AI incident register — pure types, constants and validation (no React, no Supabase).
// Mirrors the CHECK constraints and the guard trigger in
// supabase/migrations/20290304000000_ai_incidents.sql. The database is the authority;
// this file only gives fast, translatable feedback before a round trip.

export const AI_INCIDENT_TYPES = [
  'wrong_diagnosis', 'wrong_price_commitment', 'pii_leak_on_call', 'discriminatory_behavior', 'prompt_injection', 'other',
] as const;
export const AI_INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const AI_INCIDENT_STATUSES = ['open', 'investigating', 'contained', 'resolved', 'closed'] as const;
export const AI_INCIDENT_SOURCES = [
  'ai_security_event', 'customer_report', 'staff_review', 'vdp_report', 'monitoring', 'other',
] as const;
export const AI_INCIDENT_OWNER_ROLES = [
  'ai_safety_lead', 'security_lead', 'engineering_lead', 'support_lead', 'legal_counsel',
] as const;
export const AI_NOTIFICATION_STATES = ['not_assessed', 'not_required', 'counsel_review', 'sent'] as const;

export type AiIncidentType = (typeof AI_INCIDENT_TYPES)[number];
export type AiIncidentSeverity = (typeof AI_INCIDENT_SEVERITIES)[number];
export type AiIncidentStatus = (typeof AI_INCIDENT_STATUSES)[number];
export type AiIncidentSource = (typeof AI_INCIDENT_SOURCES)[number];
export type AiIncidentOwnerRole = (typeof AI_INCIDENT_OWNER_ROLES)[number];
export type AiNotificationState = (typeof AI_NOTIFICATION_STATES)[number];

export const LIMITS = { titleMin: 3, titleMax: 160, summaryMin: 10, summaryMax: 4000, callIdMax: 128, postmortemMin: 3, postmortemMax: 500 } as const;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Same idea as the guard trigger: catches obvious e-mail addresses, nothing more. It is NOT a PII scanner. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export interface AiIncident {
  id: string;
  ref: string;
  incidentType: AiIncidentType;
  severity: AiIncidentSeverity;
  status: AiIncidentStatus;
  title: string;
  summary: string;
  source: AiIncidentSource;
  ownerRole: AiIncidentOwnerRole;
  callId: string | null;
  customerNotification: AiNotificationState;
  regulatorNotification: AiNotificationState;
  postmortemRef: string | null;
  detectedAt: string;
  containedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiIncidentDraft {
  title: string;
  summary: string;
  incidentType: AiIncidentType;
  severity: AiIncidentSeverity;
  source: AiIncidentSource;
  ownerRole: AiIncidentOwnerRole;
  callId: string;
  /** Value of a <input type="datetime-local"> (local time, no zone) or ''. Empty = now. */
  detectedAt: string;
}

export interface AiIncidentPatch {
  status?: AiIncidentStatus;
  customerNotification?: AiNotificationState;
  regulatorNotification?: AiNotificationState;
  postmortemRef?: string | null;
}

export type FieldErrorKey = 'required' | 'tooShort' | 'tooLong' | 'email' | 'future' | 'invalid';
export type DraftErrors = Partial<Record<'title' | 'summary' | 'callId' | 'detectedAt', FieldErrorKey>>;

/** Starting severity and owner suggested by docs/compliance/policies/ai-incident-response.md §3. */
export const TYPE_DEFAULTS: Readonly<Record<AiIncidentType, { severity: AiIncidentSeverity; ownerRole: AiIncidentOwnerRole }>> = {
  wrong_diagnosis: { severity: 'medium', ownerRole: 'engineering_lead' },
  wrong_price_commitment: { severity: 'medium', ownerRole: 'support_lead' },
  pii_leak_on_call: { severity: 'critical', ownerRole: 'security_lead' },
  discriminatory_behavior: { severity: 'high', ownerRole: 'ai_safety_lead' },
  prompt_injection: { severity: 'medium', ownerRole: 'security_lead' },
  other: { severity: 'medium', ownerRole: 'ai_safety_lead' },
};

export function emptyDraft(): AiIncidentDraft {
  return {
    title: '', summary: '', incidentType: 'wrong_diagnosis', severity: TYPE_DEFAULTS.wrong_diagnosis.severity,
    source: 'staff_review', ownerRole: TYPE_DEFAULTS.wrong_diagnosis.ownerRole, callId: '', detectedAt: '',
  };
}

/** Parses a datetime-local value as local time. Returns null for empty or invalid input. */
export function parseLocalDateTime(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function checkText(value: string, min: number, max: number): FieldErrorKey | null {
  const t = value.trim();
  if (!t) return 'required';
  if (t.length < min) return 'tooShort';
  if (t.length > max) return 'tooLong';
  if (EMAIL_RE.test(t)) return 'email';
  return null;
}

export function validateDraft(draft: AiIncidentDraft, now: Date = new Date()): DraftErrors {
  const errors: DraftErrors = {};
  const title = checkText(draft.title, LIMITS.titleMin, LIMITS.titleMax);
  if (title) errors.title = title;
  const summary = checkText(draft.summary, LIMITS.summaryMin, LIMITS.summaryMax);
  if (summary) errors.summary = summary;
  if (draft.callId.trim().length > LIMITS.callIdMax) errors.callId = 'tooLong';
  if (draft.detectedAt) {
    const d = parseLocalDateTime(draft.detectedAt);
    if (!d) errors.detectedAt = 'invalid';
    else if (d.getTime() > now.getTime() + FUTURE_SKEW_MS) errors.detectedAt = 'future';
  }
  return errors;
}

export function hasErrors(e: DraftErrors): boolean {
  return Object.keys(e).length > 0;
}

/** Row shape sent to PostgREST. Server-controlled columns (ref, reported_by, timestamps) are never sent. */
export function toInsertRow(draft: AiIncidentDraft): Record<string, unknown> {
  const detected = parseLocalDateTime(draft.detectedAt);
  const row: Record<string, unknown> = {
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    incident_type: draft.incidentType,
    severity: draft.severity,
    source: draft.source,
    owner_role: draft.ownerRole,
    call_id: draft.callId.trim() || null,
  };
  if (detected) row.detected_at = detected.toISOString();
  return row;
}

export function toUpdateRow(patch: AiIncidentPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.customerNotification !== undefined) row.customer_notification = patch.customerNotification;
  if (patch.regulatorNotification !== undefined) row.regulator_notification = patch.regulatorNotification;
  if (patch.postmortemRef !== undefined) row.postmortem_ref = patch.postmortemRef === null ? null : patch.postmortemRef.trim() || null;
  return row;
}

/** Client-side mirror of the trigger rule: high/critical need a postmortem reference to be closed. */
export function closeBlockedReason(severity: AiIncidentSeverity, status: AiIncidentStatus, postmortemRef: string | null): 'postmortem' | null {
  const needs = severity === 'high' || severity === 'critical';
  return status === 'closed' && needs && !(postmortemRef ?? '').trim() ? 'postmortem' : null;
}

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Tolerant mapper: an unexpected value never crashes the page, it falls back to the most cautious option. */
export function toIncident(row: Record<string, unknown>): AiIncident {
  return {
    id: str(row.id),
    ref: str(row.ref),
    incidentType: oneOf(AI_INCIDENT_TYPES, row.incident_type, 'other'),
    severity: oneOf(AI_INCIDENT_SEVERITIES, row.severity, 'high'),
    status: oneOf(AI_INCIDENT_STATUSES, row.status, 'open'),
    title: str(row.title),
    summary: str(row.summary),
    source: oneOf(AI_INCIDENT_SOURCES, row.source, 'other'),
    ownerRole: oneOf(AI_INCIDENT_OWNER_ROLES, row.owner_role, 'ai_safety_lead'),
    callId: strOrNull(row.call_id),
    customerNotification: oneOf(AI_NOTIFICATION_STATES, row.customer_notification, 'not_assessed'),
    regulatorNotification: oneOf(AI_NOTIFICATION_STATES, row.regulator_notification, 'not_assessed'),
    postmortemRef: strOrNull(row.postmortem_ref),
    detectedAt: str(row.detected_at),
    containedAt: strOrNull(row.contained_at),
    resolvedAt: strOrNull(row.resolved_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export const isActive = (i: Pick<AiIncident, 'status'>): boolean => i.status !== 'closed';

/** Notification still undecided on an incident that matters (policy §6: must not stay not_assessed past triage). */
export function awaitsNotificationDecision(i: AiIncident): boolean {
  return isActive(i)
    && (i.severity === 'high' || i.severity === 'critical')
    && (i.customerNotification === 'not_assessed' || i.regulatorNotification === 'not_assessed');
}

export interface AiIncidentSummary { active: number; critical: number; awaitingNotification: number }

export function summariseIncidents(rows: readonly AiIncident[]): AiIncidentSummary {
  return {
    active: rows.filter(isActive).length,
    critical: rows.filter((r) => isActive(r) && r.severity === 'critical').length,
    awaitingNotification: rows.filter(awaitsNotificationDecision).length,
  };
}

export type StatusFilter = 'active' | 'all' | AiIncidentStatus;
export type SeverityFilter = 'all' | AiIncidentSeverity;

export function filterIncidents(rows: readonly AiIncident[], status: StatusFilter, severity: SeverityFilter): AiIncident[] {
  return rows.filter((r) => {
    if (status === 'active' ? !isActive(r) : status !== 'all' && r.status !== status) return false;
    return severity === 'all' || r.severity === severity;
  });
}

const SEVERITY_RANK: Record<AiIncidentSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Active first, then most severe, then most recently detected. Does not mutate the input. */
export function sortIncidents(rows: readonly AiIncident[]): AiIncident[] {
  return [...rows].sort((a, b) =>
    Number(isActive(b)) - Number(isActive(a))
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || b.detectedAt.localeCompare(a.detectedAt));
}
