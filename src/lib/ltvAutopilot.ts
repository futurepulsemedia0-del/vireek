/**
 * Lifetime Value Autopilot — client library.
 *
 * customer_ltv_profiles is filled by recompute_customer_ltv_profiles()
 * (see supabase/migrations/20261204000000_lifetime_value_autopilot.sql).
 * This file reads those profiles, maps each segment to a specific
 * existing Automation Marketplace template (never invents a new send
 * channel), and checks automation_installs to say whether that template
 * is already on for this account.
 */

import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/priceBook';

export { formatCents };

// ============================================================
// TYPES
// ============================================================

export type LtvTrend = 'new' | 'rising' | 'stable' | 'declining';
export type LtvSegment =
  | 'new_customer'
  | 'vip_growing'
  | 'vip_at_risk'
  | 'core_stable'
  | 'reactivation_candidate'
  | 'low_value';
export type LtvActionStatus = 'pending' | 'actioned' | 'dismissed';

export interface LtvProfile {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  lifetime_value_cents: number;
  trailing_90d_cents: number;
  prior_90d_cents: number;
  predicted_annual_value_cents: number;
  completed_job_count: number;
  days_since_last_job: number | null;
  trend: LtvTrend;
  segment: LtvSegment;
  action_status: LtvActionStatus;
  action_note: string | null;
  actioned_by: string | null;
  actioned_at: string | null;
  last_computed_at: string;
  created_at: string;
  updated_at: string;
}

export interface AutopilotSummary {
  totalCustomers: number;
  totalLifetimeCents: number;
  totalPredictedAnnualCents: number;
  pendingCount: number;
  bySegment: Record<LtvSegment, number>;
}

// ============================================================
// SEGMENT PLAYBOOK — maps 1:1 to real slugs in
// src/lib/automationMarketplace.ts. null = no automated send fits;
// this segment is either healthy (core_stable) or not worth automating
// (low_value), and the page says so honestly instead of forcing a match.
// ============================================================

export const SEGMENT_LABELS: Record<LtvSegment, string> = {
  new_customer: 'New customer',
  vip_growing: 'VIP — growing',
  vip_at_risk: 'VIP — at risk',
  core_stable: 'Core — stable',
  reactivation_candidate: 'Reactivation candidate',
  low_value: 'Low value',
};

export const SEGMENT_COLORS: Record<LtvSegment, string> = {
  new_customer: 'bg-accent/10 text-accent',
  vip_growing: 'bg-success-500/10 text-success-500',
  vip_at_risk: 'bg-danger/10 text-danger',
  core_stable: 'bg-bg-tertiary text-text-secondary',
  reactivation_candidate: 'bg-warning-500/10 text-warning-500',
  low_value: 'bg-bg-tertiary text-text-secondary',
};

export const SEGMENT_RECOMMENDED_ACTION: Record<LtvSegment, string> = {
  new_customer: 'Lock in the relationship early — ask for a review while satisfaction is highest.',
  vip_growing: 'Ask for a referral or offer a membership — they\u2019re already spending more, they\u2019re warm for both.',
  vip_at_risk: 'Call personally before an automated message — a VIP going quiet is worth a human touch first.',
  core_stable: 'No action needed — steady, healthy spend at a normal cadence.',
  reactivation_candidate: 'Send a maintenance/seasonal reminder to re-open the relationship.',
  low_value: 'Not a priority for outreach spend right now.',
};

/** null = no existing Automation Marketplace template is a good fit for this segment. */
export const SEGMENT_TEMPLATE_SLUG: Record<LtvSegment, string | null> = {
  new_customer: 'post-job-review-request',
  vip_growing: 'membership-renewal-referral-ask',
  vip_at_risk: 'vip-customer-auto-tag',
  core_stable: null,
  reactivation_candidate: 'seasonal-maintenance-reminder',
  low_value: null,
};

// ============================================================
// DATA ACCESS
// ============================================================

export async function fetchProfiles(): Promise<LtvProfile[]> {
  const { data, error } = await supabase
    .from('customer_ltv_profiles')
    .select('*')
    .order('lifetime_value_cents', { ascending: false });

  if (error) throw error;
  return (data as LtvProfile[]) || [];
}

/** Recomputes every customer's LTV profile for this account. Safe to run
 *  anytime — an upsert, never duplicates rows. */
export async function runRecompute(): Promise<number> {
  const { data, error } = await supabase.rpc('recompute_customer_ltv_profiles');
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function setActionStatus(
  id: string,
  status: Exclude<LtvActionStatus, 'pending'>,
  note: string | undefined,
  actorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('customer_ltv_profiles')
    .update({
      action_status: status,
      action_note: note ?? null,
      actioned_by: actorId,
      actioned_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) throw error;
}

/** Which of this account's Automation Marketplace templates are active,
 *  so the page can say "already on" vs "turn this on" per segment. */
export async function fetchActiveTemplateSlugs(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('automation_installs')
    .select('template_slug')
    .eq('status', 'active');

  if (error) throw error;
  return new Set((data || []).map((r) => r.template_slug as string));
}

// ============================================================
// AGGREGATION
// ============================================================

const EMPTY_SEGMENT_COUNTS: Record<LtvSegment, number> = {
  new_customer: 0,
  vip_growing: 0,
  vip_at_risk: 0,
  core_stable: 0,
  reactivation_candidate: 0,
  low_value: 0,
};

export function computeSummary(profiles: LtvProfile[]): AutopilotSummary {
  const bySegment = { ...EMPTY_SEGMENT_COUNTS };
  let totalLifetimeCents = 0;
  let totalPredictedAnnualCents = 0;
  let pendingCount = 0;

  for (const p of profiles) {
    bySegment[p.segment] += 1;
    totalLifetimeCents += p.lifetime_value_cents;
    totalPredictedAnnualCents += p.predicted_annual_value_cents;
    if (p.action_status === 'pending' && p.segment !== 'core_stable' && p.segment !== 'low_value') {
      pendingCount += 1;
    }
  }

  return { totalCustomers: profiles.length, totalLifetimeCents, totalPredictedAnnualCents, pendingCount, bySegment };
}

export function relativeTime(days: number | null): string {
  if (days === null) return 'No jobs yet';
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
