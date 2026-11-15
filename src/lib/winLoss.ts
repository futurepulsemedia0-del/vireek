/**
 * Win/loss analysis — pure types, vocabulary and validation (no I/O).
 * Mirrors the CHECK constraints in supabase/migrations/20290305000000_win_loss_records.sql;
 * the database is the trust boundary, this file only gives fast, translatable feedback.
 */

export const OUTCOMES = ['won', 'lost', 'no_decision'] as const;
export type WinLossOutcome = (typeof OUTCOMES)[number];

/** Keep in sync with win_loss_reasons_valid in the migration. */
export const REASONS = [
  'price', 'features', 'voice_quality', 'integrations', 'trust_compliance', 'onboarding_effort',
  'support', 'brand_awareness', 'timing_budget', 'champion_left', 'status_quo', 'other',
] as const;
export type WinLossReason = (typeof REASONS)[number];

export const INTERVIEW_STATUSES = ['not_requested', 'requested', 'completed', 'declined'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const LIMITS = {
  dealName: 200,
  competitor: 120,
  notes: 4000,
  maxReasons: 5,
  maxValueCents: 100_000_000_000,
  minDate: '2020-01-01',
} as const;

/** Below this many decided deals a win rate is anecdote, not signal; the UI flags it. */
export const MIN_DECIDED_FOR_RATE = 5;

export interface WinLossRecord {
  id: string;
  deal_name: string;
  outcome: WinLossOutcome;
  competitor: string | null;
  reasons: WinLossReason[];
  notes: string | null;
  closed_on: string;
  deal_value_cents: number | null;
  interview_status: InterviewStatus;
  created_at: string;
  updated_at: string;
}

export type WinLossPayload = Pick<
  WinLossRecord,
  'deal_name' | 'outcome' | 'competitor' | 'reasons' | 'notes' | 'closed_on' | 'deal_value_cents' | 'interview_status'
>;

export interface WinLossDraft {
  dealName: string;
  outcome: WinLossOutcome | '';
  competitor: string;
  reasons: WinLossReason[];
  notes: string;
  closedOn: string;
  dealValue: string; // whole or decimal dollars, as typed
  interviewStatus: InterviewStatus;
}

export type DraftErrorKey =
  | 'dealNameRequired' | 'dealNameTooLong' | 'outcomeRequired' | 'competitorRequiredForLoss' | 'competitorTooLong'
  | 'reasonsRequired' | 'reasonsTooMany' | 'notesTooLong' | 'dateInvalid' | 'dateFuture' | 'valueInvalid';

export type DraftErrors = Partial<Record<keyof WinLossDraft, DraftErrorKey>>;

export const emptyDraft = (today: string): WinLossDraft => ({
  dealName: '', outcome: '', competitor: '', reasons: [], notes: '', closedOn: today, dealValue: '', interviewStatus: 'not_requested',
});

export const draftFromRecord = (r: WinLossRecord): WinLossDraft => ({
  dealName: r.deal_name,
  outcome: r.outcome,
  competitor: r.competitor ?? '',
  reasons: [...r.reasons],
  notes: r.notes ?? '',
  closedOn: r.closed_on,
  dealValue: r.deal_value_cents === null ? '' : String(r.deal_value_cents / 100),
  interviewStatus: r.interview_status,
});

/** "1,250.50" / "1250" -> cents. null = blank. NaN = invalid. */
export function dollarsToCents(input: string): number | null {
  const s = input.trim().replace(/,/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) ? cents : Number.NaN;
}

const isRealDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** `today` is injected (YYYY-MM-DD, UTC) so the function stays pure and testable. */
export function validateDraft(
  d: WinLossDraft,
  today: string,
): { ok: true; payload: WinLossPayload } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const dealName = d.dealName.trim();
  const competitor = d.competitor.trim();
  const notes = d.notes.trim();
  const reasons = [...new Set(d.reasons)];

  if (!dealName) errors.dealName = 'dealNameRequired';
  else if (dealName.length > LIMITS.dealName) errors.dealName = 'dealNameTooLong';

  if (!d.outcome) errors.outcome = 'outcomeRequired';
  if (competitor.length > LIMITS.competitor) errors.competitor = 'competitorTooLong';
  else if (d.outcome === 'lost' && !competitor) errors.competitor = 'competitorRequiredForLoss';

  if (reasons.length > LIMITS.maxReasons) errors.reasons = 'reasonsTooMany';
  else if ((d.outcome === 'won' || d.outcome === 'lost') && reasons.length < 1) errors.reasons = 'reasonsRequired';

  if (notes.length > LIMITS.notes) errors.notes = 'notesTooLong';

  if (!isRealDate(d.closedOn) || d.closedOn < LIMITS.minDate) errors.closedOn = 'dateInvalid';
  else {
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() + 1);
    if (d.closedOn > limit.toISOString().slice(0, 10)) errors.closedOn = 'dateFuture';
  }

  const cents = dollarsToCents(d.dealValue);
  if (cents !== null && (Number.isNaN(cents) || cents < 0 || cents > LIMITS.maxValueCents)) errors.dealValue = 'valueInvalid';

  if (Object.keys(errors).length > 0 || !d.outcome) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      deal_name: dealName,
      outcome: d.outcome,
      competitor: competitor || null,
      reasons,
      notes: notes || null,
      closed_on: d.closedOn,
      deal_value_cents: cents,
      interview_status: d.interviewStatus,
    },
  };
}

// ---------- aggregate view (win_loss_summary) ----------
export type SummaryDimension = 'overall' | 'competitor' | 'reason' | 'quarter';

export interface SummaryRow {
  dimension: SummaryDimension;
  bucket: string;
  wins: number;
  losses: number;
  no_decisions: number;
  decided: number;
  win_rate_pct: number | null;
  won_value_cents: number;
  lost_value_cents: number;
}

export type GroupedSummary = Record<SummaryDimension, SummaryRow[]>;

/** Buckets: quarters newest first; everything else by decided deals, then name. */
export function groupSummary(rows: readonly SummaryRow[]): GroupedSummary {
  const out: GroupedSummary = { overall: [], competitor: [], reason: [], quarter: [] };
  for (const r of rows) if (r.dimension in out) out[r.dimension].push(r);
  out.quarter.sort((a, b) => b.bucket.localeCompare(a.bucket));
  for (const k of ['competitor', 'reason'] as const) {
    out[k].sort((a, b) => b.decided + b.no_decisions - (a.decided + a.no_decisions) || a.bucket.localeCompare(b.bucket));
  }
  return out;
}

export const isLowSample = (r: Pick<SummaryRow, 'decided'>): boolean => r.decided < MIN_DECIDED_FOR_RATE;
export const isKnownReason = (v: string): v is WinLossReason => (REASONS as readonly string[]).includes(v);
