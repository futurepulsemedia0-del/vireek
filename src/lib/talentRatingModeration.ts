// Talent Network ratings: report/dispute and moderation. Pure types, constants and validation
// (no React, no Supabase). Mirrors supabase/migrations/20290307000000_talent_ratings_moderation.sql.
// The database is the authority; this file only gives fast, translatable feedback before a round trip.
// Policy text and legal review points: docs/policies/talent-ratings-moderation.md ([COUNSEL]).

export const REPORT_REASONS = [
  'harassment_or_hate', 'discriminatory', 'personal_information', 'not_about_engagement',
  'fake_or_retaliatory', 'false_statement_of_fact', 'other',
] as const;
/** Grounds a moderator may cite to remove or redact. A subset of the report reasons plus `legal_obligation`. */
export const REMOVAL_REASONS = [
  'harassment_or_hate', 'discriminatory', 'personal_information', 'not_about_engagement',
  'fake_or_retaliatory', 'legal_obligation',
] as const;
export const KEEP_REASONS = ['no_violation', 'insufficient_evidence', 'outside_policy'] as const;
export const DECISIONS = ['keep', 'redact_comment', 'remove'] as const;
export const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_kept', 'resolved_redacted', 'resolved_removed', 'withdrawn'] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type RemovalReason = (typeof REMOVAL_REASONS)[number];
export type KeepReason = (typeof KEEP_REASONS)[number];
export type Decision = (typeof DECISIONS)[number];
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type RatingDirection = 'business_to_worker' | 'worker_to_business';
export type StaffScope = 'active' | 'resolved' | 'all';

export const LIMITS = { detailsMin: 20, detailsMax: 1000, noteMin: 10, noteMax: 2000 } as const;

// ----------------------------------------------------------------------------- shapes returned by the RPCs

/** Added to talent_get_engagement_ratings by the moderation migration. All optional: older deployments omit them. */
export interface RatingModerationState {
  mine_removed?: boolean;
  theirs_removed?: boolean;
  theirs_comment_redacted?: boolean;
  can_dispute?: boolean;
  dispute?: { id: string; status: DisputeStatus; decision: Decision | null; created_at: string; resolved_at: string | null } | null;
}

export interface MyDispute {
  id: string; engagement_id: string; status: DisputeStatus; reason_code: ReportReason;
  decision: Decision | null; created_at: string; resolved_at: string | null;
}

export interface StaffDisputeRow {
  id: string; status: DisputeStatus; reason_code: ReportReason; direction: RatingDirection; rating: number | null;
  created_at: string; claimed_at: string | null; resolved_at: string | null; decision: Decision | null;
  assigned_to_me: boolean; assigned_to_other: boolean;
}

export interface StaffLogEntry {
  action: 'opened' | 'withdrawn' | 'claimed' | 'kept' | 'comment_redacted' | 'removed';
  actor_kind: 'ratee' | 'moderator' | 'system'; from_status: string | null; to_status: string | null;
  reason_code: string | null; note: string | null; created_at: string;
}

export interface StaffDisputeDetail {
  id: string; status: DisputeStatus; reason_code: ReportReason; details: string; direction: RatingDirection;
  engagement_id: string; created_at: string; claimed_at: string | null; resolved_at: string | null;
  decision: Decision | null; resolution_code: string | null; resolution_note: string | null;
  assigned_to_me: boolean; conflict: boolean; content_sha256: string;
  rating: {
    rating: number; tags: string[]; comment: string | null; moderation_status: 'visible' | 'under_review' | 'removed';
    comment_redacted_at: string | null; current_sha256: string;
  } | null;
  log: StaffLogEntry[];
}

// ----------------------------------------------------------------------------- helpers

export const isActiveStatus = (s: DisputeStatus): boolean => s === 'open' || s === 'under_review';
export const isResolvedStatus = (s: DisputeStatus): boolean => s === 'resolved_kept' || s === 'resolved_redacted' || s === 'resolved_removed';

/** Reasons a moderator may cite for a decision. */
export function reasonsForDecision(decision: Decision): readonly string[] {
  return decision === 'keep' ? KEEP_REASONS : REMOVAL_REASONS;
}

/** True when the stored content hash still matches the rating: nothing changed since it was reported. */
export const contentUnchanged = (d: Pick<StaffDisputeDetail, 'content_sha256' | 'rating'>): boolean =>
  d.rating !== null && d.rating.current_sha256 === d.content_sha256;

// ----------------------------------------------------------------------------- validation

export type ReportErrorKey = 'reasonRequired' | 'detailsTooShort' | 'detailsTooLong';
export interface ReportErrors { reason?: ReportErrorKey; details?: ReportErrorKey }

export function validateReport(reason: string, details: string): ReportErrors {
  const errors: ReportErrors = {};
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) errors.reason = 'reasonRequired';
  const len = details.trim().length;
  if (len < LIMITS.detailsMin) errors.details = 'detailsTooShort';
  else if (len > LIMITS.detailsMax) errors.details = 'detailsTooLong';
  return errors;
}

export type DecisionErrorKey = 'decisionRequired' | 'reasonRequired' | 'noteTooShort' | 'noteTooLong';
export interface DecisionErrors { decision?: DecisionErrorKey; reason?: DecisionErrorKey; note?: DecisionErrorKey }

export function validateDecision(decision: string, reason: string, note: string): DecisionErrors {
  const errors: DecisionErrors = {};
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    errors.decision = 'decisionRequired';
  } else if (!reasonsForDecision(decision as Decision).includes(reason)) {
    errors.reason = 'reasonRequired';
  }
  const len = note.trim().length;
  if (len < LIMITS.noteMin) errors.note = 'noteTooShort';
  else if (len > LIMITS.noteMax) errors.note = 'noteTooLong';
  return errors;
}

export const hasErrors = (e: object): boolean => Object.keys(e).length > 0;

// ----------------------------------------------------------------------------- error mapping

export type ModerationErrorKind =
  | 'forbidden' | 'conflict' | 'notVisible' | 'alreadyReported' | 'alreadyRemoved' | 'limit'
  | 'notClaimed' | 'notOpen' | 'decided' | 'invalid' | 'generic';

interface DbError { code?: string; message?: string }

/** Maps a Postgres error from the moderation RPCs to a kind the UI translates. Raw messages are never shown. */
export function classifyError(error: DbError | null | undefined): ModerationErrorKind {
  if (!error) return 'generic';
  const msg = (error.message ?? '').toLowerCase();
  switch (error.code) {
    case '42501': return msg.includes('involved') ? 'conflict' : 'forbidden';
    case '54000': return 'limit';
    case '22023':
      if (msg.includes('no visible rating')) return 'notVisible';
      if (msg.includes('already been reported')) return 'alreadyReported';
      if (msg.includes('already been removed')) return 'alreadyRemoved';
      if (msg.includes('claim this report')) return 'notClaimed';
      if (msg.includes('no longer open')) return 'notOpen';
      if (msg.includes('already been decided')) return 'decided';
      return 'invalid';
    default: return 'generic';
  }
}

// ----------------------------------------------------------------------------- parsing (defensive: RPC data is untyped)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseMyDisputes(data: unknown): MyDispute[] {
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map((r) => ({
    id: String(r.id), engagement_id: String(r.engagement_id), status: r.status as DisputeStatus,
    reason_code: r.reason_code as ReportReason, decision: (r.decision as Decision | null) ?? null,
    created_at: String(r.created_at), resolved_at: (r.resolved_at as string | null) ?? null,
  }));
}

export function parseStaffList(data: unknown): StaffDisputeRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map((r) => ({
    id: String(r.id), status: r.status as DisputeStatus, reason_code: r.reason_code as ReportReason,
    direction: r.direction as RatingDirection, rating: typeof r.rating === 'number' ? r.rating : null,
    created_at: String(r.created_at), claimed_at: (r.claimed_at as string | null) ?? null,
    resolved_at: (r.resolved_at as string | null) ?? null, decision: (r.decision as Decision | null) ?? null,
    assigned_to_me: r.assigned_to_me === true, assigned_to_other: r.assigned_to_other === true,
  }));
}

export function parseStaffDetail(data: unknown): StaffDisputeDetail | null {
  if (!isRecord(data) || typeof data.id !== 'string') return null;
  return data as unknown as StaffDisputeDetail;
}
