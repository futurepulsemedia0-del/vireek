/**
 * Uncertainty & Evidence Map — client library.
 *
 * Every other intelligence surface in this dashboard (forecasts, AI actions,
 * customer intelligence, integrations) presents a number or a recommendation
 * as if it were solid ground. It rarely is. This engine does the opposite:
 * instead of another confident number, it maps out *where the ground is thin*
 * — where a decision is currently resting on missing data, a small sample,
 * a broken sync, or an AI action nobody has actually reviewed.
 *
 * Real trust is built by saying "we don't know yet" in the right place, not
 * by projecting confidence everywhere. Every item below ships with a plain
 * `detail` string explaining exactly why it's uncertain and a
 * `recommendedAction` — never a hidden score with no explanation.
 *
 * Data sources read (all pre-existing, nothing new added to the schema):
 *   - jobs                     (completion evidence: notes, diagnosis, signature, invoice)
 *   - customers                (profile completeness: phone, email, address, contact recency)
 *   - business_profile + regional_demand_snapshots (forecast sample size, via lib/regionalDemand)
 *   - integrations             (sync health, via lib/integrationRecovery)
 *   - agent_action_log         (AI actions currently waiting on a human, via lib/agentGovernance)
 *
 * Every section below is wrapped defensively: if a table/column has moved in
 * your schema, that one domain quietly reports zero items instead of
 * breaking the whole map.
 */

import { supabase } from '@/lib/supabase';
import { getIntegrationHealth } from '@/lib/integrationRecovery';
import type { Integration } from '@/lib/supabase';
import { fetchMyBusinessSegment, fetchRegionalSnapshot } from '@/lib/regionalDemand';

// ============================================================
// ASSUMPTIONS — disclosed thresholds. Tune to your real numbers.
// ============================================================

export interface UncertaintyAssumptions {
  /** How far back to scan jobs/customers for evidence gaps. */
  lookbackDays: number;
  /** A regional forecast built on fewer businesses than this is flagged low-sample. */
  lowSampleForecastThreshold: number;
  /** A customer profile with no contact in this many days is flagged stale. */
  staleContactDays: number;
}

export const UNCERTAINTY_ASSUMPTIONS: UncertaintyAssumptions = {
  lookbackDays: 60,
  lowSampleForecastThreshold: 15,
  staleContactDays: 120,
};

export type UncertaintyDomain =
  | 'data_quality'
  | 'customer_profile'
  | 'forecast_reliability'
  | 'integration_sync'
  | 'ai_review';

export type UncertaintySeverity = 'low' | 'medium' | 'high';

export interface UncertaintyItem {
  id: string;
  domain: UncertaintyDomain;
  severity: UncertaintySeverity;
  title: string;
  /** Plain-language explanation of why this is uncertain — never a bare score. */
  detail: string;
  affectedCount: number;
  sampleLabel: string;
  recommendedAction: string;
}

export interface UncertaintyDomainSummary {
  domain: UncertaintyDomain;
  label: string;
  confidencePct: number;
  itemCount: number;
  highSeverityCount: number;
}

export interface UncertaintyReport {
  generatedAt: string;
  /** 0-100 — how much of the business surface currently rests on solid evidence. */
  overallConfidencePct: number;
  items: UncertaintyItem[];
  domainSummaries: UncertaintyDomainSummary[];
  assumptions: UncertaintyAssumptions;
}

export const DOMAIN_LABELS: Record<UncertaintyDomain, string> = {
  data_quality: 'Data Quality',
  customer_profile: 'Customer Profiles',
  forecast_reliability: 'Forecast Reliability',
  integration_sync: 'Integration Sync',
  ai_review: 'AI Actions Needing You',
};

export const DOMAIN_ORDER: UncertaintyDomain[] = [
  'data_quality',
  'customer_profile',
  'forecast_reliability',
  'integration_sync',
  'ai_review',
];

export const SEVERITY_COLORS: Record<UncertaintySeverity, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/15 text-warning-500',
  high: 'bg-danger/15 text-danger',
};

// ============================================================
// Domain builders — each one is isolated and never throws upward.
// ============================================================

function severityFromRatio(affected: number, total: number): UncertaintySeverity {
  if (total <= 0) return 'low';
  const ratio = affected / total;
  if (ratio >= 0.4) return 'high';
  if (ratio >= 0.15) return 'medium';
  return 'low';
}

async function buildDataQualityItems(): Promise<UncertaintyItem[]> {
  const since = new Date(Date.now() - UNCERTAINTY_ASSUMPTIONS.lookbackDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .select('id, job_status, invoice_amount, invoice_status, completion_notes, technician_diagnosis, customer_signature_data_url, assigned_technician_id, scheduled_datetime')
    .gte('created_at', since);
  if (error || !data) return [];

  const completed = data.filter((j) => j.job_status === 'completed');
  const undocumented = completed.filter((j) => !j.completion_notes && !j.technician_diagnosis && !j.customer_signature_data_url);
  const unbilled = completed.filter((j) => j.invoice_status === 'not_sent' || j.invoice_amount === null);
  const unassignedScheduled = data.filter((j) => j.job_status === 'scheduled' && !j.assigned_technician_id);

  const items: UncertaintyItem[] = [];
  if (completed.length > 0 && undocumented.length > 0) {
    items.push({
      id: 'dq-undocumented-completions',
      domain: 'data_quality',
      severity: severityFromRatio(undocumented.length, completed.length),
      title: 'Completed jobs with no evidence on file',
      detail: `${undocumented.length} of ${completed.length} jobs completed in the last ${UNCERTAINTY_ASSUMPTIONS.lookbackDays} days have no completion notes, technician diagnosis, or customer signature — any downstream report built on "what happened" for these jobs is a guess, not a record.`,
      affectedCount: undocumented.length,
      sampleLabel: `${undocumented.length} / ${completed.length} completed jobs`,
      recommendedAction: 'Require a completion note or signature before a job can be marked completed.',
    });
  }
  if (completed.length > 0 && unbilled.length > 0) {
    items.push({
      id: 'dq-unbilled-completions',
      domain: 'data_quality',
      severity: severityFromRatio(unbilled.length, completed.length),
      title: 'Completed jobs with no invoice amount recorded',
      detail: `${unbilled.length} completed jobs have no invoice sent or no invoice amount — revenue, margin, and profitability figures elsewhere in the dashboard are undercounted by an unknown amount until these are billed.`,
      affectedCount: unbilled.length,
      sampleLabel: `${unbilled.length} / ${completed.length} completed jobs`,
      recommendedAction: 'Reconcile unbilled completions in Quotes/Billing before trusting revenue totals this period.',
    });
  }
  if (unassignedScheduled.length > 0) {
    items.push({
      id: 'dq-unassigned-scheduled',
      domain: 'data_quality',
      severity: severityFromRatio(unassignedScheduled.length, data.length),
      title: 'Scheduled jobs with no technician assigned',
      detail: `${unassignedScheduled.length} upcoming jobs have no assigned technician — capacity and dispatch views elsewhere are planning around a slot that may not actually be staffed.`,
      affectedCount: unassignedScheduled.length,
      sampleLabel: `${unassignedScheduled.length} scheduled jobs`,
      recommendedAction: 'Assign a technician or flag the job as at-risk in Dispatch Board.',
    });
  }
  return items;
}

async function buildCustomerProfileItems(): Promise<UncertaintyItem[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, phone, email, address, lifecycle_stage, last_contacted_at');
  if (error || !data) return [];

  const staleCutoff = Date.now() - UNCERTAINTY_ASSUMPTIONS.staleContactDays * 86_400_000;
  const missingContact = data.filter((c) => !c.phone && !c.email);
  const missingAddress = data.filter((c) => !c.address);
  const activeStale = data.filter(
    (c) =>
      (c.lifecycle_stage === 'active' || c.lifecycle_stage === 'vip') &&
      (!c.last_contacted_at || new Date(c.last_contacted_at).getTime() < staleCutoff),
  );

  const items: UncertaintyItem[] = [];
  if (missingContact.length > 0) {
    items.push({
      id: 'cp-missing-contact',
      domain: 'customer_profile',
      severity: severityFromRatio(missingContact.length, data.length),
      title: 'Customers with no phone and no email on file',
      detail: `${missingContact.length} of ${data.length} customer profiles have neither a phone number nor an email — outreach, campaigns, and churn-risk scoring for these customers cannot actually reach them, so treat any "customer contacted" metric that includes them as incomplete.`,
      affectedCount: missingContact.length,
      sampleLabel: `${missingContact.length} / ${data.length} customers`,
      recommendedAction: 'Prompt for a phone or email the next time these customers are on a call or job.',
    });
  }
  if (missingAddress.length > 0) {
    items.push({
      id: 'cp-missing-address',
      domain: 'customer_profile',
      severity: severityFromRatio(missingAddress.length, data.length),
      title: 'Customers with no address on file',
      detail: `${missingAddress.length} customer profiles have no address — Regional Demand, Dispatch Board, and Weather Surge cannot factor these customers into location-based decisions; they are effectively invisible to every location-aware feature.`,
      affectedCount: missingAddress.length,
      sampleLabel: `${missingAddress.length} / ${data.length} customers`,
      recommendedAction: 'Backfill addresses from job history where a matching job exists.',
    });
  }
  if (activeStale.length > 0) {
    items.push({
      id: 'cp-active-stale',
      domain: 'customer_profile',
      severity: severityFromRatio(activeStale.length, data.length),
      title: 'Active/VIP customers with no recent contact',
      detail: `${activeStale.length} customers marked active or VIP have not been contacted in over ${UNCERTAINTY_ASSUMPTIONS.staleContactDays} days — their lifecycle stage may no longer reflect reality, which quietly skews churn-risk and LTV figures that assume "active" means "current."`,
      affectedCount: activeStale.length,
      sampleLabel: `${activeStale.length} active/VIP customers`,
      recommendedAction: 'Re-verify lifecycle stage on next contact, or route to a re-engagement campaign.',
    });
  }
  return items;
}

async function buildForecastReliabilityItems(): Promise<UncertaintyItem[]> {
  try {
    const { service_area, primary_industry } = await fetchMyBusinessSegment();
    if (!service_area || !primary_industry) {
      return [
        {
          id: 'fc-no-segment',
          domain: 'forecast_reliability',
          severity: 'medium',
          title: 'Regional demand forecast has no segment to compare against',
          detail: 'Service area and/or primary industry are not set on the business profile, so Regional Demand cannot be benchmarked against comparable businesses at all — any regional insight shown elsewhere is not yet grounded in a real peer group.',
          affectedCount: 1,
          sampleLabel: 'Business profile',
          recommendedAction: 'Set service area and primary industry in Business Profile.',
        },
      ];
    }
    const snapshot = await fetchRegionalSnapshot(service_area, primary_industry);
    if (!snapshot) return [];
    if (snapshot.sample_size < UNCERTAINTY_ASSUMPTIONS.lowSampleForecastThreshold) {
      return [
        {
          id: 'fc-low-sample',
          domain: 'forecast_reliability',
          severity: snapshot.sample_size < UNCERTAINTY_ASSUMPTIONS.lowSampleForecastThreshold / 2 ? 'high' : 'medium',
          title: `Regional demand forecast for ${snapshot.region_label} is a small-sample estimate`,
          detail: `The comparison is built from only ${snapshot.sample_size} businesses (below the ${UNCERTAINTY_ASSUMPTIONS.lowSampleForecastThreshold}-business reliability threshold) — call-volume and emergency-rate trends shown in Regional Demand for this area can swing sharply from a single business joining or leaving the sample, and should be read as directional, not precise.`,
          affectedCount: snapshot.sample_size,
          sampleLabel: `${snapshot.sample_size} businesses in sample`,
          recommendedAction: 'Treat this forecast as directional until the regional sample grows; avoid pricing or staffing decisions on it alone.',
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

async function buildIntegrationSyncItems(): Promise<UncertaintyItem[]> {
  const { data, error } = await supabase.from('integrations').select('*');
  if (error || !data) return [];
  const rows = data as Integration[];
  const unhealthy = rows.filter((row) => getIntegrationHealth(row).needsRecovery);
  if (unhealthy.length === 0) return [];

  return unhealthy.map((row) => {
    const health = getIntegrationHealth(row);
    return {
      id: `is-${row.id}`,
      domain: 'integration_sync' as const,
      severity: 'high' as const,
      title: `${row.integration_type ?? 'Integration'} sync is not healthy`,
      detail: `${health.title}: ${health.detail} Any data this integration feeds (calendar, payments, calls, reviews) has not synced since the failure — figures elsewhere may be stale rather than wrong.`,
      affectedCount: 1,
      sampleLabel: row.integration_type ?? row.id,
      recommendedAction: health.primaryActionLabel,
    };
  });
}

async function buildAiReviewItems(): Promise<UncertaintyItem[]> {
  const since = new Date(Date.now() - UNCERTAINTY_ASSUMPTIONS.lookbackDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('agent_action_log')
    .select('id, action_slug, agent_source, status, amount_cents, created_at')
    .eq('status', 'pending_approval')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error || !data || data.length === 0) return [];

  const bySource = new Map<string, number>();
  for (const row of data) {
    bySource.set(row.agent_source, (bySource.get(row.agent_source) ?? 0) + 1);
  }

  return Array.from(bySource.entries()).map(([source, count]) => ({
    id: `ar-${source}`,
    domain: 'ai_review' as const,
    severity: severityFromRatio(count, Math.max(data.length, 1)),
    title: `${count} AI action${count === 1 ? '' : 's'} from "${source}" waiting on human approval`,
    detail: `These actions were proposed by the "${source}" agent but have not been approved, rejected, or executed — until someone decides, the intended effect (a message, a charge, a schedule change) has not actually happened, regardless of what any activity log elsewhere implies.`,
    affectedCount: count,
    sampleLabel: `${count} pending action${count === 1 ? '' : 's'}`,
    recommendedAction: 'Review the pending queue in Agent Governance and approve or reject each action.',
  }));
}

// ============================================================
// Aggregation
// ============================================================

export async function buildUncertaintyReport(): Promise<UncertaintyReport> {
  const [dataQuality, customerProfile, forecast, integrationSync, aiReview] = await Promise.all([
    buildDataQualityItems().catch(() => []),
    buildCustomerProfileItems().catch(() => []),
    buildForecastReliabilityItems().catch(() => []),
    buildIntegrationSyncItems().catch(() => []),
    buildAiReviewItems().catch(() => []),
  ]);

  const byDomain: Record<UncertaintyDomain, UncertaintyItem[]> = {
    data_quality: dataQuality,
    customer_profile: customerProfile,
    forecast_reliability: forecast,
    integration_sync: integrationSync,
    ai_review: aiReview,
  };

  const severityWeight: Record<UncertaintySeverity, number> = { low: 8, medium: 22, high: 40 };

  const domainSummaries: UncertaintyDomainSummary[] = DOMAIN_ORDER.map((domain) => {
    const items = byDomain[domain];
    const penalty = items.reduce((sum, item) => sum + severityWeight[item.severity], 0);
    const confidencePct = Math.max(0, 100 - Math.min(100, penalty));
    return {
      domain,
      label: DOMAIN_LABELS[domain],
      confidencePct,
      itemCount: items.length,
      highSeverityCount: items.filter((i) => i.severity === 'high').length,
    };
  });

  const overallConfidencePct = domainSummaries.length
    ? Math.round(domainSummaries.reduce((sum, d) => sum + d.confidencePct, 0) / domainSummaries.length)
    : 100;

  const items = DOMAIN_ORDER.flatMap((domain) => byDomain[domain]);

  return {
    generatedAt: new Date().toISOString(),
    overallConfidencePct,
    items,
    domainSummaries,
    assumptions: UNCERTAINTY_ASSUMPTIONS,
  };
}

export function confidenceLabel(pct: number): string {
  if (pct >= 80) return 'Solid ground';
  if (pct >= 55) return 'Mostly solid, some gaps';
  if (pct >= 30) return 'Thin — verify before deciding';
  return 'Unreliable — do not decide on this alone';
}
