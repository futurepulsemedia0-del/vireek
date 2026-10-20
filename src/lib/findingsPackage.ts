/**
 * Findings Packages (inspection + quote photo packages) — client domain module.
 *
 * Pure rules live in the shared engine so the dashboard, the customer page and
 * the edge function can never disagree about what a total means. Options reuse
 * the tiered-estimate shape from src/lib/estimates.ts (Good / Better / Best).
 *
 * Schema: supabase/migrations/20271101000000_findings_packages.sql
 */

import type { UserPermissions } from '@/contexts/AuthContext';
import type { AnnotationPoint } from '@/lib/expertAssist';
import {
  TIER_META,
  createEmptyOption,
  normaliseOptions,
  type EstimateOption,
  type EstimateTier,
} from '@/lib/estimates';
import {
  SEVERITY_LABEL,
  defaultOptionId,
  isDecisionable,
  isUuid,
  optionTotalCents,
  selectionTotals,
  shareState,
  sortFindings,
  validateForSend,
  MAX_FINDINGS,
  type FindingDecision,
  type FindingSeverity,
  type PackageStatus,
  type ShareState,
} from '../../supabase/functions/_shared/findings/engine';

export {
  SEVERITY_LABEL,
  defaultOptionId,
  isDecisionable,
  isUuid,
  optionTotalCents,
  selectionTotals,
  shareState,
  sortFindings,
  validateForSend,
  MAX_FINDINGS,
};
export type { FindingDecision, FindingSeverity, PackageStatus, ShareState };

// ============================================================
// TYPES
// ============================================================

export interface FindingsPackageRow {
  id: string;
  user_id: string;
  job_id: string | null;
  customer_id: string | null;
  title: string;
  summary: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  address: string | null;
  technician_name: string | null;
  status: PackageStatus;
  tax_percent: number;
  share_token: string;
  share_enabled: boolean;
  share_expires_at: string | null;
  sent_at: string | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  responded_at: string | null;
  approver_name: string | null;
  approved_total_cents: number;
  converted_job_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FindingItemRow {
  id: string;
  package_id: string;
  sort_order: number;
  photo_id: string | null;
  storage_path: string;
  title: string;
  description: string | null;
  severity: FindingSeverity;
  annotations: AnnotationPoint[];
  options: EstimateOption[];
  recommended_option_id: string | null;
  decision: FindingDecision;
  approved_option_id: string | null;
  approved_cents: number | null;
  decided_at: string | null;
}

export interface FindingItemView extends FindingItemRow {
  /** Signed URL (1h) for the private bucket; null when signing failed. */
  photo_url: string | null;
}

export interface PublicFinding {
  id: string;
  title: string;
  description: string | null;
  severity: FindingSeverity;
  annotations: AnnotationPoint[];
  options: EstimateOption[];
  recommended_option_id: string | null;
  decision: FindingDecision;
  approved_option_id: string | null;
  approved_cents: number | null;
  photo_url: string | null;
}

export interface PublicFindings {
  package: {
    title: string;
    summary: string | null;
    status: PackageStatus;
    customer_name: string;
    address: string | null;
    technician_name: string | null;
    tax_percent: number;
    sent_at: string | null;
    share_expires_at: string | null;
    responded_at: string | null;
    approved_total_cents: number;
  };
  businessName: string | null;
  items: PublicFinding[];
}

export type PublicFindingsResult =
  | { ok: true; data: PublicFindings }
  | { ok: false; reason: 'not_found' | 'expired' | 'error' };

export interface ApprovalResult {
  status: PackageStatus;
  approved_count: number;
  declined_count: number;
  approved_total_cents: number;
  job_created: boolean;
}

// ============================================================
// LABELS / PERMISSIONS / LINKS
// ============================================================

export const STATUS_LABEL: Record<PackageStatus, string> = {
  draft: 'Draft',
  sent: 'Awaiting customer',
  approved: 'Approved',
  partially_approved: 'Partly approved',
  declined: 'Declined',
};

export const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  urgent: 'bg-danger/10 text-danger border-danger/30',
  recommended: 'bg-accent/10 text-accent border-accent/30',
  monitor: 'bg-bg-tertiary text-text-secondary border-border',
};

export const SEVERITIES: FindingSeverity[] = ['urgent', 'recommended', 'monitor'];

/** Everyone on the account can build findings in the field; sending prices to customers needs job visibility. */
export function canManageFindings(isOwner: boolean, permissions: UserPermissions): boolean {
  return isOwner || permissions.can_view_all_jobs === true;
}

export function getFindingsShareUrl(token: string): string {
  return `${window.location.origin}/findings/${token}`;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

// ============================================================
// OPTION LADDER HELPERS (reuse tiered-estimate builders)
// ============================================================

/** Next free tier for a finding, in Good → Better → Best order. Null when all three exist. */
export function nextFreeTier(options: Pick<EstimateOption, 'tier'>[]): EstimateTier | null {
  const used = new Set(options.map((o) => o.tier));
  return (['good', 'better', 'best'] as EstimateTier[]).find((t) => !used.has(t)) ?? null;
}

/** Adds the next tier; the first option ever added is the recommended one. */
export function addOption(options: EstimateOption[]): EstimateOption[] {
  const tier = nextFreeTier(options);
  if (!tier) return options;
  return [...options, createEmptyOption(tier, options.length === 0)];
}

/** Marks exactly one option recommended (or none when id is null). */
export function setRecommended(options: EstimateOption[], optionId: string | null): EstimateOption[] {
  return options.map((o) => ({ ...o, recommended: o.id === optionId }));
}

/** What gets persisted for a finding's options: blanks stripped, tier-sorted, one recommended. */
export function prepareOptionsForSave(options: EstimateOption[]): {
  options: EstimateOption[];
  recommendedId: string | null;
} {
  const order = { good: 0, better: 1, best: 2 } as const;
  const cleaned = normaliseOptions(options.filter((o) => o.line_items.some((li) => li.description.trim())))
    .sort((a, b) => order[a.tier] - order[b.tier]);
  return { options: cleaned, recommendedId: cleaned.find((o) => o.recommended)?.id ?? null };
}

export function tierLabel(tier: EstimateTier): string {
  return TIER_META[tier].label;
}

/** Package-level headline for the list: what's on the table and what was won. */
export function packageHeadline(
  pkg: Pick<FindingsPackageRow, 'status' | 'approved_total_cents'>,
  potentialCents: number,
): string {
  if (pkg.status === 'approved' || pkg.status === 'partially_approved') return `${formatMoney(pkg.approved_total_cents)} approved`;
  if (pkg.status === 'declined') return 'Declined';
  return potentialCents > 0 ? `${formatMoney(potentialCents)} recommended` : 'No prices yet';
}

/** Recommended-option total across approvable findings — the "what could close" number. */
export function potentialCents(
  items: Pick<FindingItemRow, 'severity' | 'options' | 'recommended_option_id'>[],
  taxPercent: number,
): number {
  let total = 0;
  for (const item of items) {
    if (!isDecisionable(item)) continue;
    const id = defaultOptionId(item);
    const option = item.options.find((o) => o.id === id);
    if (option) total += optionTotalCents(option, taxPercent);
  }
  return total;
}
