// Types, labels and small pure helpers for Commercial Contract / SLA
// Management. Mirrors the pattern used by src/lib/insuranceClaims.ts —
// no data fetching here, that lives in the page itself.

export type ContractType = 'service_agreement' | 'maintenance_contract' | 'msa' | 'sla_only' | 'other';

export type ContractStatus = 'draft' | 'active' | 'expiring_soon' | 'expired' | 'terminated' | 'renewed';

export type BillingFrequency = 'monthly' | 'quarterly' | 'annual' | 'one_time';

export type BreachType = 'response_time' | 'resolution_time' | 'other';

export type BreachSeverity = 'minor' | 'major' | 'critical';

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  service_agreement: 'Service agreement',
  maintenance_contract: 'Maintenance contract',
  msa: 'Master service agreement (MSA)',
  sla_only: 'SLA-only addendum',
  other: 'Other',
};

export const CONTRACT_TYPE_OPTIONS: ContractType[] = [
  'service_agreement',
  'maintenance_contract',
  'msa',
  'sla_only',
  'other',
];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  terminated: 'Terminated',
  renewed: 'Renewed',
};

export const CONTRACT_STATUS_COLORS: Record<ContractStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  active: 'bg-success-500/10 text-success-500',
  expiring_soon: 'bg-warning-500/10 text-warning-500',
  expired: 'bg-danger/10 text-danger',
  terminated: 'bg-bg-tertiary text-text-secondary',
  renewed: 'bg-accent/10 text-accent',
};

// Ordered the way a contract actually moves through its life —
// used to populate the status <select> in the same sequence.
export const CONTRACT_STATUS_OPTIONS: ContractStatus[] = [
  'draft',
  'active',
  'expiring_soon',
  'renewed',
  'expired',
  'terminated',
];

export const BILLING_FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  one_time: 'One-time',
};

export const BILLING_FREQUENCY_OPTIONS: BillingFrequency[] = ['monthly', 'quarterly', 'annual', 'one_time'];

export const BREACH_TYPE_LABELS: Record<BreachType, string> = {
  response_time: 'Response time',
  resolution_time: 'Resolution time',
  other: 'Other commitment',
};

export const BREACH_TYPE_OPTIONS: BreachType[] = ['response_time', 'resolution_time', 'other'];

export const BREACH_SEVERITY_LABELS: Record<BreachSeverity, string> = {
  minor: 'Minor',
  major: 'Major',
  critical: 'Critical',
};

export const BREACH_SEVERITY_COLORS: Record<BreachSeverity, string> = {
  minor: 'bg-bg-tertiary text-text-secondary',
  major: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

export const BREACH_SEVERITY_OPTIONS: BreachSeverity[] = ['minor', 'major', 'critical'];

// A contract still in force (not expired/terminated) — drives the
// "active contracts" stat and the default list filter.
export function isLiveContract(status: ContractStatus): boolean {
  return status === 'active' || status === 'expiring_soon';
}

// Days remaining until end_date; negative once it's past. Null when
// there's no end date on file (open-ended / MSA-style contracts).
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const ms = new Date(dateStr).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}

// Client-side "is this within its renewal notice window" check —
// there's no scheduled job flipping status automatically (see the
// migration notes), so the UI computes it live from end_date.
export function isWithinRenewalWindow(
  endDate: string | null | undefined,
  renewalNoticeDays: number
): boolean {
  const remaining = daysUntil(endDate);
  return remaining !== null && remaining >= 0 && remaining <= renewalNoticeDays;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return 'Not on file';
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return 'Not set';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hr`;
}

// Sum of penalty_amount_cents across a set of breaches, capped at
// penalty_cap_percentage of contract_value_cents — matches the intent of
// the two fields on commercial_contracts (the cap is informational here;
// enforcing it is a business decision made when a credit is actually
// issued, not silently on read).
export function totalPenaltyCents(breaches: { penalty_amount_cents: number | null }[]): number {
  return breaches.reduce((sum, b) => sum + (b.penalty_amount_cents ?? 0), 0);
}
