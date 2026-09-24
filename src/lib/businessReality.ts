/**
 * Business Reality Engine — client library.
 *
 * No new tables, no AI call. Reads what's already there — jobs, quotes,
 * payment_requests, job_evidence_checks, price_book_items, business_decisions
 * — and surfaces three things:
 *   1. Missing data       — fields that should be set but aren't.
 *   2. Contradictions     — what's reported vs what the field/records show.
 *   3. Decisions at risk  — pending AI recommendations (Decision Engine)
 *                           resting on a data domain that's currently thin.
 *
 * The "reality score" is a plain, disclosed formula (100 minus a fixed
 * per-finding deduction by severity) — no hidden weighting.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type RealityCategory = 'missing_data' | 'contradiction' | 'unreliable_decision';
export type RealitySeverity = 'low' | 'medium' | 'high';

export interface RealityFinding {
  id: string;
  category: RealityCategory;
  severity: RealitySeverity;
  title: string;
  detail: string;
  count: number;
  sample: string[];
}

export interface RealityReport {
  score: number;
  generatedAt: string;
  findings: RealityFinding[];
  domainCompleteness: {
    billingPct: number | null;
    dispatchPct: number | null;
  };
}

export const CATEGORY_LABELS: Record<RealityCategory, string> = {
  missing_data: 'Missing data',
  contradiction: 'Reported vs. field reality',
  unreliable_decision: 'Decisions built on thin data',
};

export const SEVERITY_LABELS: Record<RealitySeverity, string> = {
  low: 'Worth a look',
  medium: 'Should fix',
  high: 'Fix soon',
};

export const SEVERITY_COLORS: Record<RealitySeverity, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
};

const SEVERITY_WEIGHT: Record<RealitySeverity, number> = { low: 5, medium: 10, high: 15 };
const COMPLETENESS_ALERT_THRESHOLD = 70; // below this %, a decision resting on it gets flagged

// ============================================================
// BUILD
// ============================================================

export async function buildRealityReport(): Promise<RealityReport> {
  const [
    missingTech,
    missingSchedule,
    missingPrice,
    completedUnverified,
    unresolvedEvidence,
    jobsPaid,
    paidPayments,
    acceptedQuotes,
    jobsWithLead,
    billingJobs,
    dispatchJobs,
    decisions,
  ] = await Promise.all([
    supabase.from('jobs').select('id, customer_name', { count: 'exact' })
      .not('job_status', 'in', '(cancelled,completed)').is('assigned_technician_id', null).limit(10),
    supabase.from('jobs').select('id, customer_name', { count: 'exact' })
      .eq('job_status', 'scheduled').is('scheduled_datetime', null).limit(10),
    supabase.from('price_book_items').select('id, service_name', { count: 'exact' })
      .eq('active', true).is('price_cents', null).is('price_max_cents', null).limit(10),
    supabase.from('jobs').select('id, customer_name', { count: 'exact' })
      .eq('job_status', 'completed').is('evidence_verified_at', null).limit(10),
    supabase.from('job_evidence_checks').select('id, job_id', { count: 'exact' })
      .eq('resolved', false).in('verdict', ['fail', 'needs_attention']).limit(10),
    supabase.from('jobs').select('id, customer_name').eq('invoice_status', 'paid').limit(500),
    supabase.from('payment_requests').select('job_id').eq('status', 'paid').not('job_id', 'is', null).limit(2000),
    supabase.from('quotes').select('id, lead_id, customer_name, responded_at')
      .eq('status', 'accepted').not('lead_id', 'is', null).order('responded_at', { ascending: false }).limit(300),
    supabase.from('jobs').select('lead_id').not('lead_id', 'is', null).limit(2000),
    supabase.from('jobs').select('id, invoice_amount').eq('job_status', 'completed').limit(2000),
    supabase.from('jobs').select('id, assigned_technician_id').not('job_status', 'eq', 'cancelled').limit(2000),
    supabase.from('business_decisions').select('id, category, title, confidence_score')
      .in('status', ['pending', 'approved']).limit(100),
  ]);

  const findings: RealityFinding[] = [];

  // ---- Missing data --------------------------------------------------
  if ((missingTech.count ?? 0) > 0) {
    findings.push({
      id: 'missing_technician',
      category: 'missing_data',
      severity: 'medium',
      title: 'Open jobs with no technician assigned',
      detail: 'These are active jobs nobody is on the hook for yet.',
      count: missingTech.count ?? 0,
      sample: (missingTech.data ?? []).map((j) => j.customer_name),
    });
  }
  if ((missingSchedule.count ?? 0) > 0) {
    findings.push({
      id: 'missing_schedule',
      category: 'missing_data',
      severity: 'high',
      title: "Jobs marked 'scheduled' with no scheduled time",
      detail: 'The status says scheduled, but there is nothing on the calendar to show for it.',
      count: missingSchedule.count ?? 0,
      sample: (missingSchedule.data ?? []).map((j) => j.customer_name),
    });
  }
  if ((missingPrice.count ?? 0) > 0) {
    findings.push({
      id: 'missing_price',
      category: 'missing_data',
      severity: 'high',
      title: 'Active price book items with no price set',
      detail: 'Anything the AI or a technician quotes off these will be a guess.',
      count: missingPrice.count ?? 0,
      sample: (missingPrice.data ?? []).map((p) => p.service_name),
    });
  }

  // ---- Reported vs. field reality -------------------------------------
  if ((completedUnverified.count ?? 0) > 0) {
    findings.push({
      id: 'completed_unverified',
      category: 'contradiction',
      severity: 'medium',
      title: "Jobs marked 'completed' with no field evidence check",
      detail: 'Reported done, but nothing on file confirms it from the field.',
      count: completedUnverified.count ?? 0,
      sample: (completedUnverified.data ?? []).map((j) => j.customer_name),
    });
  }
  if ((unresolvedEvidence.count ?? 0) > 0) {
    findings.push({
      id: 'unresolved_evidence',
      category: 'contradiction',
      severity: 'high',
      title: 'Unresolved quality/safety flags from field photo checks',
      detail: 'The field evidence itself is flagged fail or needs-attention and nobody has closed it out.',
      count: unresolvedEvidence.count ?? 0,
      sample: (unresolvedEvidence.data ?? []).map((c) => c.job_id),
    });
  }

  const paidJobIds = new Set((paidPayments.data ?? []).map((p) => p.job_id as string));
  const paidMismatch = (jobsPaid.data ?? []).filter((j) => !paidJobIds.has(j.id));
  if (paidMismatch.length > 0) {
    findings.push({
      id: 'paid_mismatch',
      category: 'contradiction',
      severity: 'high',
      title: "Jobs marked 'paid' with no matching payment record",
      detail: 'The invoice status says paid, but there is no paid payment_requests row backing it up.',
      count: paidMismatch.length,
      sample: paidMismatch.slice(0, 10).map((j) => j.customer_name),
    });
  }

  const leadIdsWithJob = new Set((jobsWithLead.data ?? []).map((j) => j.lead_id as string));
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3-day grace period
  const staleAccepted = (acceptedQuotes.data ?? []).filter(
    (q) => !leadIdsWithJob.has(q.lead_id as string) && (!q.responded_at || new Date(q.responded_at).getTime() < cutoff)
  );
  if (staleAccepted.length > 0) {
    findings.push({
      id: 'accepted_no_job',
      category: 'contradiction',
      severity: 'medium',
      title: "Quotes marked 'accepted' that never became a job",
      detail: 'The customer said yes on paper, but no job was ever created for it.',
      count: staleAccepted.length,
      sample: staleAccepted.slice(0, 10).map((q) => q.customer_name),
    });
  }

  // ---- Domain completeness (feeds the decisions check below) ----------
  const billingRows = billingJobs.data ?? [];
  const billingPct = billingRows.length > 0
    ? Math.round((billingRows.filter((j) => typeof j.invoice_amount === 'number').length / billingRows.length) * 100)
    : null;

  const dispatchRows = dispatchJobs.data ?? [];
  const dispatchPct = dispatchRows.length > 0
    ? Math.round((dispatchRows.filter((j) => j.assigned_technician_id !== null).length / dispatchRows.length) * 100)
    : null;

  // ---- Decisions built on thin data ------------------------------------
  const billingCategories = new Set(['pricing', 'collections']);
  const dispatchCategories = new Set(['dispatch', 'staffing']);
  const shakyDecisions = (decisions.data ?? []).filter((d) => {
    if (billingCategories.has(d.category) && billingPct !== null && billingPct < COMPLETENESS_ALERT_THRESHOLD) return true;
    if (dispatchCategories.has(d.category) && dispatchPct !== null && dispatchPct < COMPLETENESS_ALERT_THRESHOLD) return true;
    return false;
  });
  if (shakyDecisions.length > 0) {
    findings.push({
      id: 'decisions_on_thin_data',
      category: 'unreliable_decision',
      severity: 'high',
      title: 'Pending Decision Engine recommendations resting on incomplete data',
      detail:
        billingPct !== null && billingPct < COMPLETENESS_ALERT_THRESHOLD
          ? `Only ${billingPct}% of completed jobs have a recorded invoice amount — pricing/collections calls made on that data may be off.`
          : `Only ${dispatchPct}% of open jobs have an assigned technician — dispatch/staffing calls made on that data may be off.`,
      count: shakyDecisions.length,
      sample: shakyDecisions.slice(0, 10).map((d) => d.title),
    });
  }

  const deduction = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const score = Math.max(0, 100 - deduction);

  return {
    score,
    generatedAt: new Date().toISOString(),
    findings,
    domainCompleteness: { billingPct, dispatchPct },
  };
}
