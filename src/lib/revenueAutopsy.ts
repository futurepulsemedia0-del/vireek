/**
 * Revenue Autopsy Engine — client library.
 *
 * Every row in revenue_autopsy_findings is created automatically by a
 * database trigger the moment a revenue_recovery_events row is confirmed
 * lost (status -> 'written_off') — see
 * supabase/migrations/20261203000000_revenue_autopsy_engine.sql. This
 * file only reads those findings, aggregates them into a pattern
 * library, and calls the one RPC that backfills pre-existing losses. It
 * never invents a root cause of its own.
 */

import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/priceBook';
import type { RecoverySourceType, RecoveryStatus } from '@/lib/revenueRecovery';

export { formatCents };

// ============================================================
// TYPES
// ============================================================

export type RootCause =
  | 'price_objection'
  | 'went_to_competitor'
  | 'slow_response'
  | 'unresolved_sales_objection'
  | 'scope_mismatch'
  | 'scheduling_conflict'
  | 'financing_friction'
  | 'billing_or_payment_issue'
  | 'unknown';

export type AutopsyConfidence = 'high' | 'medium' | 'low' | 'confirmed';

export interface AutopsyFinding {
  id: string;
  recovery_event_id: string;
  root_cause: RootCause;
  confidence: AutopsyConfidence;
  contributing_factors: string[];
  dollar_amount_cents: number;
  auto_detected: boolean;
  prevention_note: string | null;
  reviewed: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined from revenue_recovery_events — read-only here.
  revenue_recovery_events: {
    customer_name: string;
    occurred_at: string;
    source_type: RecoverySourceType;
    status: RecoveryStatus;
  } | null;
}

export interface PatternRow {
  root_cause: RootCause;
  count: number;
  totalCents: number;
  needsReviewCount: number;
  last30Cents: number;
  prior30Cents: number;
}

export interface AutopsyStats {
  totalCases: number;
  totalCents: number;
  needsReviewCount: number;
  topCause: RootCause | null;
}

// ============================================================
// LABELS
// ============================================================

export const ROOT_CAUSE_LABELS: Record<RootCause, string> = {
  price_objection: 'Price objection',
  went_to_competitor: 'Went to a competitor',
  slow_response: 'Slow response / no follow-up',
  unresolved_sales_objection: 'Objection raised, never resolved',
  scope_mismatch: 'Scope mismatch',
  scheduling_conflict: 'Scheduling / timing conflict',
  financing_friction: 'Financing friction',
  billing_or_payment_issue: 'Billing or payment issue',
  unknown: 'Needs review — no clear signal',
};

export const ROOT_CAUSE_PREVENTION: Record<RootCause, string> = {
  price_objection: 'Offer tiered pricing or a financing option before the customer has to ask for one.',
  went_to_competitor: 'Shorten quote turnaround time and follow up within the first hour, while you\u2019re still top of mind.',
  slow_response: 'Route unanswered calls to a callback queue with a same-day SLA instead of voicemail.',
  unresolved_sales_objection: 'Coach the team on the specific objection language flagged below before the next similar call.',
  scope_mismatch: 'Confirm scope in writing (photos/measurements) before the quote goes out, not after it\u2019s declined.',
  scheduling_conflict: 'Offer more appointment windows or a waitlist for the customer\u2019s preferred time.',
  financing_friction: 'Surface financing options earlier in the quote flow, before the total is presented.',
  billing_or_payment_issue: 'Send the invoice at job completion, not days later, and retry failed charges automatically.',
  unknown: 'Review this case manually — no automatic signal was strong enough to classify it.',
};

export const ROOT_CAUSE_COLORS: Record<RootCause, string> = {
  price_objection: 'bg-warning-500/10 text-warning-500',
  went_to_competitor: 'bg-danger/10 text-danger',
  slow_response: 'bg-danger/10 text-danger',
  unresolved_sales_objection: 'bg-warning-500/10 text-warning-500',
  scope_mismatch: 'bg-bg-tertiary text-text-secondary',
  scheduling_conflict: 'bg-bg-tertiary text-text-secondary',
  financing_friction: 'bg-warning-500/10 text-warning-500',
  billing_or_payment_issue: 'bg-danger/10 text-danger',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

export const CONFIDENCE_LABELS: Record<AutopsyConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence — please review',
  confirmed: 'Confirmed by your team',
};

// ============================================================
// DATA ACCESS
// ============================================================

export async function fetchFindings(): Promise<AutopsyFinding[]> {
  const { data, error } = await supabase
    .from('revenue_autopsy_findings')
    .select('*, revenue_recovery_events(customer_name, occurred_at, source_type, status)')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data as unknown as AutopsyFinding[]) || [];
}

/** Runs the one-time backfill for written_off events that predate this
 *  feature. Safe to call repeatedly — findings already created are
 *  skipped (ON CONFLICT DO NOTHING in the RPC). */
export async function runBackfill(): Promise<number> {
  const { data, error } = await supabase.rpc('backfill_revenue_autopsy_findings');
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function reviewFinding(
  id: string,
  updates: { root_cause?: RootCause; prevention_note?: string },
  reviewerId: string,
): Promise<void> {
  const { error } = await supabase
    .from('revenue_autopsy_findings')
    .update({
      ...updates,
      confidence: 'confirmed',
      reviewed: true,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) throw error;
}

// ============================================================
// AGGREGATION — computed client-side from the findings already fetched,
// same approach as buildValueAtRiskReport() / summarizeUnderpricing().
// ============================================================

export function buildPatternLibrary(findings: AutopsyFinding[]): PatternRow[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const map = new Map<RootCause, PatternRow>();

  for (const f of findings) {
    const row =
      map.get(f.root_cause) ??
      ({ root_cause: f.root_cause, count: 0, totalCents: 0, needsReviewCount: 0, last30Cents: 0, prior30Cents: 0 } as PatternRow);

    row.count += 1;
    row.totalCents += f.dollar_amount_cents;
    if (!f.reviewed && f.confidence !== 'confirmed') row.needsReviewCount += 1;

    const ageMs = now - new Date(f.created_at).getTime();
    if (ageMs <= 30 * day) row.last30Cents += f.dollar_amount_cents;
    else if (ageMs <= 60 * day) row.prior30Cents += f.dollar_amount_cents;

    map.set(f.root_cause, row);
  }

  return [...map.values()].sort((a, b) => b.totalCents - a.totalCents);
}

export function computeStats(findings: AutopsyFinding[]): AutopsyStats {
  const totalCents = findings.reduce((sum, f) => sum + f.dollar_amount_cents, 0);
  const needsReviewCount = findings.filter((f) => !f.reviewed && f.confidence !== 'confirmed').length;
  const pattern = buildPatternLibrary(findings);

  return {
    totalCases: findings.length,
    totalCents,
    needsReviewCount,
    topCause: pattern[0]?.root_cause ?? null,
  };
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
