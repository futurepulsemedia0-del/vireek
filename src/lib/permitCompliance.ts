/**
 * AI Permit / Code / Compliance Engine — client domain logic.
 *
 * Before a job starts, the `analyze-job-compliance` Edge Function reviews the
 * job's location, trade, scope and customer type against a curated rule
 * library (plus an AI layer that can only ADD context) and stores one review
 * per job: permit likelihood + a prioritised list of permit / inspection /
 * licensing / safety / documentation / regulation requirements.
 *
 * Users track each requirement (open → in progress → satisfied / not
 * applicable, permit number, note). Starting a job with unresolved blockers
 * needs a recorded acknowledgement (who / when / why) — a soft gate that is
 * written to the audit log; it never blocks a status change in the database.
 *
 * Server counterparts:
 *   supabase/functions/analyze-job-compliance
 *   supabase/functions/_shared/permit-rules/*   (keep types below in sync)
 *   supabase/migrations/*_ai_permit_compliance_engine.sql
 */

import { supabase } from '@/lib/supabase';

export type ComplianceCategory =
  'permit' | 'inspection' | 'licensing' | 'safety' | 'documentation' | 'regulation';
export type ComplianceSeverity = 'blocker' | 'warning' | 'info';
export type ComplianceConfidence = 'high' | 'medium' | 'low';
export type PermitLikelihood = 'likely_required' | 'possibly_required' | 'unlikely' | 'unknown';
export type ItemStatus = 'open' | 'in_progress' | 'satisfied' | 'not_applicable';

export interface ComplianceItem {
  key: string;
  category: ComplianceCategory;
  severity: ComplianceSeverity;
  title: string;
  detail: string;
  authority: string | null;
  reference: string | null;
  confidence: ComplianceConfidence;
  source: 'rule' | 'ai';
}

export interface ComplianceJurisdiction {
  country: string | null;
  state: string | null;
  stateName: string | null;
  city: string | null;
  zip: string | null;
  label: string;
  basis: 'address' | 'country_only' | 'unknown';
  coverage: 'us_curated' | 'country_curated' | 'generic';
}

export interface ItemProgress {
  status: ItemStatus;
  permit_number: string | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface ComplianceReview {
  id: string;
  job_id: string;
  jurisdiction: ComplianceJurisdiction;
  work_types: string[];
  permit_likelihood: PermitLikelihood;
  summary: string | null;
  requirements: ComplianceItem[];
  verify_questions: string[];
  item_progress: Record<string, ItemProgress>;
  ai_status: 'ok' | 'unavailable' | 'skipped';
  rules_version: string | null;
  model: string | null;
  generated_at: string;
  created_at: string;
}

export interface StartStatus {
  has_review: boolean;
  unresolved: { key: string; title: string }[];
  acknowledged: boolean;
  needs_ack: boolean;
}

export const PERMIT_LIKELIHOOD_META: Record<
  PermitLikelihood,
  { label: string; className: string }
> = {
  likely_required: { label: 'Permit likely required', className: 'bg-danger/10 text-danger' },
  possibly_required: {
    label: 'Permit may be required',
    className: 'bg-warning-500/10 text-warning-500',
  },
  unlikely: { label: 'Permit unlikely', className: 'bg-success-500/10 text-success-500' },
  unknown: { label: 'Permit status unknown', className: 'bg-bg-tertiary text-text-secondary' },
};

export const SEVERITY_META: Record<ComplianceSeverity, { label: string; className: string }> = {
  blocker: { label: 'Resolve before starting', className: 'bg-danger/10 text-danger' },
  warning: { label: 'Important', className: 'bg-warning-500/10 text-warning-500' },
  info: { label: 'Good to know', className: 'bg-bg-tertiary text-text-secondary' },
};

export const CATEGORY_LABELS: Record<ComplianceCategory, string> = {
  permit: 'Permit',
  inspection: 'Inspection',
  licensing: 'Licensing',
  safety: 'Safety',
  documentation: 'Documentation',
  regulation: 'Regulation',
};

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  satisfied: 'Done',
  not_applicable: 'Not applicable',
};

/** Jobs a compliance review is useful for — before or during the visit, not after it's done. */
export const COMPLIANCE_ELIGIBLE_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);

/** A job is worth reviewing only once it says what the work is. */
export function hasReviewableScope(job: {
  service_type?: unknown;
  dispatch_note?: unknown;
}): boolean {
  return (
    (typeof job.service_type === 'string' && job.service_type.trim() !== '') ||
    (typeof job.dispatch_note === 'string' && job.dispatch_note.trim() !== '')
  );
}

export function progressFor(
  review: Pick<ComplianceReview, 'item_progress'>,
  key: string,
): ItemProgress | null {
  return review.item_progress?.[key] ?? null;
}

export function isResolved(review: Pick<ComplianceReview, 'item_progress'>, key: string): boolean {
  const s = progressFor(review, key)?.status ?? 'open';
  return s === 'satisfied' || s === 'not_applicable';
}

/** Mirrors compliance_unresolved_blockers() in SQL. */
export function unresolvedBlockers(
  review: Pick<ComplianceReview, 'requirements' | 'item_progress'>,
): ComplianceItem[] {
  return review.requirements.filter((r) => r.severity === 'blocker' && !isResolved(review, r.key));
}

export interface ComplianceCounts {
  blockers: number;
  warnings: number;
  info: number;
  resolved: number;
  total: number;
}

export function complianceCounts(
  review: Pick<ComplianceReview, 'requirements' | 'item_progress'>,
): ComplianceCounts {
  const counts: ComplianceCounts = {
    blockers: 0,
    warnings: 0,
    info: 0,
    resolved: 0,
    total: review.requirements.length,
  };
  for (const r of review.requirements) {
    if (isResolved(review, r.key)) {
      counts.resolved += 1;
      continue;
    }
    if (r.severity === 'blocker') counts.blockers += 1;
    else if (r.severity === 'warning') counts.warnings += 1;
    else counts.info += 1;
  }
  return counts;
}

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

function rpcMessage(error: { message?: string } | null, fallback: string): string {
  const m = error?.message ?? '';
  // Our RPCs raise short, user-safe messages; anything else gets the generic fallback.
  return m && m.length < 160 && !/relation|column|function|syntax|permission denied/i.test(m)
    ? m
    : fallback;
}

export async function fetchComplianceReview(jobId: string): Promise<ComplianceReview | null> {
  const { data, error } = await supabase
    .from('job_compliance_reviews')
    .select('*')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) throw error;
  return (data as ComplianceReview) ?? null;
}

export async function generateComplianceReview(
  jobId: string,
  opts: { force?: boolean; jurisdictionOverride?: string } = {},
): Promise<ComplianceReview> {
  const { data, error } = await supabase.functions.invoke('analyze-job-compliance', {
    body: { jobId, ...opts },
  });
  if (error) {
    throw new Error(
      await functionErrorMessage(
        error,
        'Could not reach the compliance engine. Check your connection and try again.',
      ),
    );
  }
  if (data?.error) throw new Error(String(data.error));
  return data as ComplianceReview;
}

export async function setComplianceItemProgress(
  jobId: string,
  key: string,
  status: ItemStatus,
  extra: { permitNumber?: string; note?: string } = {},
): Promise<ItemProgress> {
  const { data, error } = await supabase.rpc('set_compliance_item_progress', {
    p_job_id: jobId,
    p_key: key,
    p_status: status,
    p_permit_number: extra.permitNumber?.trim() || null,
    p_note: extra.note?.trim() || null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not save this update.'));
  return data as ItemProgress;
}

export async function fetchStartStatus(jobId: string): Promise<StartStatus> {
  const { data, error } = await supabase.rpc('compliance_start_status', { p_job_id: jobId });
  if (error) throw new Error(rpcMessage(error, 'Could not check compliance status.'));
  return data as StartStatus;
}

export async function acknowledgeComplianceReview(jobId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_compliance_review', {
    p_job_id: jobId,
    p_reason: reason,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not record your acknowledgement.'));
}
