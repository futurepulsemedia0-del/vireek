/**
 * Autonomous Revenue Protection (ARP) — client library.
 *
 * Detect -> Explain -> Recover -> Verify. Every case row is created, refreshed
 * and closed by the database (see
 * supabase/migrations/20270106000000_autonomous_revenue_protection.sql).
 * This file only reads cases and calls the small set of RPCs that move a case
 * through Recover — it never computes an at-risk number of its own, so the UI
 * can't drift from what the database detected and verified.
 */

import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/revenueRecovery';

export { formatCents };

// ============================================================
// TYPES
// ============================================================

export type LeakType =
  | 'quote_not_followed_up'
  | 'warranty_under_claim'
  | 'membership_renewal_missed'
  | 'unbilled_job'
  | 'part_markup_leakage'
  | 'cancelled_appointment'
  | 'technician_idle_time';

export type CaseStage = 'explained' | 'recovering' | 'verified' | 'self_resolved' | 'lost' | 'dismissed';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type VerificationKind = 'secured' | 'protected' | 'capacity_filled';

export type RecoveryActionMethod =
  | 'callback'
  | 'sms'
  | 'email'
  | 'quote_resent'
  | 'invoice_sent'
  | 'claim_amended'
  | 'renewal_outreach'
  | 'price_updated'
  | 'rebooked'
  | 'schedule_filled'
  | 'other';

export interface EvidenceItem {
  label: string;
  value: string;
}

export interface CaseExplanation {
  summary?: string;
  evidence?: EvidenceItem[];
  math?: string;
}

export interface RecommendedAction {
  type?: string;
  label?: string;
  href?: string;
}

export interface ProtectionCase {
  id: string;
  user_id: string;
  leak_type: LeakType;
  subject_table: string;
  subject_id: string;
  subject_key: string;
  stage: CaseStage;
  customer_name: string | null;
  customer_phone: string | null;
  at_risk_cents: number;
  value_basis: string;
  confidence: number;
  severity: Severity;
  is_capacity: boolean;
  reason_code: string;
  explanation: CaseExplanation;
  recommended_action: RecommendedAction;
  detected_at: string;
  last_seen_at: string;
  due_at: string | null;
  recovery_started_at: string | null;
  recovery_method: string | null;
  closed_at: string | null;
  verification_kind: VerificationKind | null;
  verified_amount_cents: number | null;
  verification: { reason?: string } | null;
  ledger_event_id: string | null;
  created_at: string;
}

export interface ProtectionSettings {
  user_id: string;
  quote_followup_hours: number;
  renewal_lookahead_days: number;
  min_parts_markup_pct: number;
  idle_min_open_slots: number;
  idle_capacity_fill_pct: number;
  timezone: string;
  last_scan_at: string | null;
}

export type EditableSettings = Omit<ProtectionSettings, 'user_id' | 'last_scan_at'>;

export const DEFAULT_SETTINGS: EditableSettings = {
  quote_followup_hours: 48,
  renewal_lookahead_days: 21,
  min_parts_markup_pct: 40,
  idle_min_open_slots: 2,
  idle_capacity_fill_pct: 50,
  timezone: 'UTC',
};

// ============================================================
// LABELS
// ============================================================

export const LEAK_LABELS: Record<LeakType, string> = {
  quote_not_followed_up: 'Quote not followed up',
  warranty_under_claim: 'Warranty under-claim',
  membership_renewal_missed: 'Membership renewal at risk',
  unbilled_job: 'Completed, not invoiced',
  part_markup_leakage: 'Part markup leakage',
  cancelled_appointment: 'Cancelled, not rebooked',
  technician_idle_time: 'Technician idle time',
};

export const LEAK_COLORS: Record<LeakType, string> = {
  quote_not_followed_up: 'bg-warning-500/10 text-warning-500',
  warranty_under_claim: 'bg-accent/10 text-accent',
  membership_renewal_missed: 'bg-warning-500/10 text-warning-500',
  unbilled_job: 'bg-danger/10 text-danger',
  part_markup_leakage: 'bg-accent/10 text-accent',
  cancelled_appointment: 'bg-danger/10 text-danger',
  technician_idle_time: 'bg-bg-tertiary text-text-secondary',
};

export const SEVERITY_STYLES: Record<Severity, { badge: string; card: string }> = {
  critical: { badge: 'bg-danger/10 text-danger', card: 'border-danger/30 bg-danger/[0.03]' },
  high: { badge: 'bg-danger/10 text-danger', card: 'border-danger/20 bg-bg-secondary' },
  medium: { badge: 'bg-warning-500/10 text-warning-500', card: 'border-border bg-bg-secondary' },
  low: { badge: 'bg-bg-tertiary text-text-secondary', card: 'border-border bg-bg-secondary' },
};

export const STAGE_LABELS: Record<CaseStage, string> = {
  explained: 'Detected',
  recovering: 'Recovering',
  verified: 'Verified',
  self_resolved: 'Resolved on its own',
  lost: 'Lost',
  dismissed: 'Dismissed',
};

export const VALUE_BASIS_LABELS: Record<string, string> = {
  quote_amount: 'From the quote',
  warranty_costs: 'From warranty costs',
  membership_plan: 'From the plan price',
  price_book_match: 'From your price book',
  avg_job_value: 'From your average job value',
  ledger_estimate: 'From the recovery ledger',
  cost_markup_gap: 'From cost vs. target markup',
  capacity_estimate: 'Capacity estimate',
  none: 'No estimate',
};

/** Recovery methods offered per leak type — the first one is the default. */
export const METHODS_BY_LEAK: Record<LeakType, { value: RecoveryActionMethod; label: string }[]> = {
  quote_not_followed_up: [
    { value: 'callback', label: 'Called the customer' },
    { value: 'sms', label: 'Sent a text' },
    { value: 'email', label: 'Sent an email' },
    { value: 'quote_resent', label: 'Resent the quote' },
  ],
  warranty_under_claim: [
    { value: 'claim_amended', label: 'Amended the claim' },
    { value: 'email', label: 'Emailed the manufacturer' },
    { value: 'callback', label: 'Called the manufacturer' },
  ],
  membership_renewal_missed: [
    { value: 'renewal_outreach', label: 'Reached out to renew' },
    { value: 'callback', label: 'Called the customer' },
    { value: 'sms', label: 'Sent a text' },
  ],
  unbilled_job: [
    { value: 'invoice_sent', label: 'Sent the invoice' },
    { value: 'other', label: 'Other' },
  ],
  part_markup_leakage: [
    { value: 'price_updated', label: 'Updated the price book' },
    { value: 'other', label: 'Other' },
  ],
  cancelled_appointment: [
    { value: 'rebooked', label: 'Rebooked the customer' },
    { value: 'callback', label: 'Called the customer' },
    { value: 'sms', label: 'Sent a text' },
  ],
  technician_idle_time: [
    { value: 'schedule_filled', label: 'Filled the schedule' },
    { value: 'other', label: 'Other' },
  ],
};

// ============================================================
// FORMATTING
// ============================================================

export function relativeFromNow(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** Hours until a due date (negative once passed); null when there is no deadline. */
export function hoursUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 3600000);
}

// ============================================================
// QUERIES
// ============================================================

export interface CaseBundle {
  active: ProtectionCase[];
  closed: ProtectionCase[];
}

export async function fetchCases(): Promise<CaseBundle> {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();

  const [activeRes, closedRes] = await Promise.all([
    supabase
      .from('revenue_protection_cases')
      .select('*')
      .in('stage', ['explained', 'recovering'])
      .order('at_risk_cents', { ascending: false })
      .limit(300),
    supabase
      .from('revenue_protection_cases')
      .select('*')
      .in('stage', ['verified', 'self_resolved', 'lost', 'dismissed'])
      .gte('closed_at', since)
      .order('closed_at', { ascending: false })
      .limit(300),
  ]);

  if (activeRes.error) throw activeRes.error;
  if (closedRes.error) throw closedRes.error;

  return {
    active: (activeRes.data as ProtectionCase[]) ?? [],
    closed: (closedRes.data as ProtectionCase[]) ?? [],
  };
}

export async function fetchSettings(): Promise<ProtectionSettings | null> {
  const { data, error } = await supabase.from('revenue_protection_settings').select('*').maybeSingle();
  if (error) throw error;
  return (data as ProtectionSettings | null) ?? null;
}

// ============================================================
// STATS  (pure aggregation of rows the database already produced)
// ============================================================

export interface ProtectionStats {
  /** Recoverable money currently at risk (excludes capacity estimates). */
  atRiskCents: number;
  atRiskCount: number;
  criticalCount: number;
  /** Estimated open-capacity opportunity — never mixed into atRiskCents. */
  capacityCents: number;
  capacityCount: number;
  recoveringCount: number;
  recoveringCents: number;
  /** Money proven to have moved (accepted quote, paid invoice, renewal, credit, rebooking). */
  securedCents: number;
  /** Root cause fixed, cash still pending (claim amended, price fixed, invoice sent). */
  protectedCents: number;
  verifiedCount: number;
  lostCents: number;
  lostCount: number;
  selfResolvedCount: number;
  /** verified / (verified + lost) by count over the loaded window; null with no closed cases. */
  verifyRatePercent: number | null;
  byType: { type: LeakType; count: number; cents: number }[];
}

export function computeStats(bundle: CaseBundle): ProtectionStats {
  const money = bundle.active.filter((c) => !c.is_capacity);
  const capacity = bundle.active.filter((c) => c.is_capacity);
  const recovering = money.filter((c) => c.stage === 'recovering');

  const verified = bundle.closed.filter((c) => c.stage === 'verified');
  const lost = bundle.closed.filter((c) => c.stage === 'lost' && !c.is_capacity);

  const sum = (rows: ProtectionCase[], pick: (c: ProtectionCase) => number) => rows.reduce((t, c) => t + pick(c), 0);

  const byTypeMap = new Map<LeakType, { count: number; cents: number }>();
  for (const c of bundle.active) {
    const cur = byTypeMap.get(c.leak_type) ?? { count: 0, cents: 0 };
    cur.count += 1;
    cur.cents += c.at_risk_cents;
    byTypeMap.set(c.leak_type, cur);
  }

  const resolvedTotal = verified.filter((c) => c.verification_kind !== 'capacity_filled').length + lost.length;

  return {
    atRiskCents: sum(money, (c) => c.at_risk_cents),
    atRiskCount: money.length,
    criticalCount: money.filter((c) => c.severity === 'critical').length,
    capacityCents: sum(capacity, (c) => c.at_risk_cents),
    capacityCount: capacity.length,
    recoveringCount: recovering.length,
    recoveringCents: sum(recovering, (c) => c.at_risk_cents),
    securedCents: sum(
      verified.filter((c) => c.verification_kind === 'secured'),
      (c) => c.verified_amount_cents ?? 0
    ),
    protectedCents: sum(
      verified.filter((c) => c.verification_kind === 'protected'),
      (c) => c.verified_amount_cents ?? 0
    ),
    verifiedCount: verified.filter((c) => c.verification_kind !== 'capacity_filled').length,
    lostCents: sum(lost, (c) => c.at_risk_cents),
    lostCount: lost.length,
    selfResolvedCount: bundle.closed.filter((c) => c.stage === 'self_resolved').length,
    verifyRatePercent:
      resolvedTotal > 0
        ? Math.round((verified.filter((c) => c.verification_kind !== 'capacity_filled').length / resolvedTotal) * 100)
        : null,
    byType: Array.from(byTypeMap.entries())
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.cents - a.cents),
  };
}

// ============================================================
// ACTIONS
// ============================================================

export interface ScanResult {
  throttled?: boolean;
  new_cases?: number;
  verification?: { secured_cents: number; protected_cents: number; lost: number; self_resolved: number };
}

export async function runScan(force = false): Promise<ScanResult> {
  const { data, error } = await supabase.rpc('arp_run_scan', { p_force: force });
  if (error) throw error;
  return (data as ScanResult) ?? {};
}

export async function startRecovery(caseId: string, method: RecoveryActionMethod, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('arp_start_recovery', {
    p_case_id: caseId,
    p_method: method,
    p_note: note ?? null,
  });
  if (error) return false;
  return Boolean(data);
}

export async function dismissCase(caseId: string, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('arp_dismiss_case', {
    p_case_id: caseId,
    p_note: note ?? null,
  });
  if (error) return false;
  return Boolean(data);
}

export async function saveSettings(userId: string, values: EditableSettings): Promise<boolean> {
  const { error } = await supabase
    .from('revenue_protection_settings')
    .upsert({ user_id: userId, ...values }, { onConflict: 'user_id' });
  return !error;
}
