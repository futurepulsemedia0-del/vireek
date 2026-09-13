export type LossType = 'water_damage' | 'fire_damage' | 'smoke_damage' | 'mold' | 'storm_wind' | 'other';

export type ClaimStatus =
  | 'intake'
  | 'documentation'
  | 'submitted_to_carrier'
  | 'adjuster_scheduled'
  | 'approved'
  | 'denied'
  | 'in_repair'
  | 'closed';

export const LOSS_TYPE_LABELS: Record<LossType, string> = {
  water_damage: 'Water damage',
  fire_damage: 'Fire damage',
  smoke_damage: 'Smoke damage',
  mold: 'Mold remediation',
  storm_wind: 'Storm / wind damage',
  other: 'Other',
};

export const LOSS_TYPE_OPTIONS: LossType[] = [
  'water_damage',
  'fire_damage',
  'smoke_damage',
  'mold',
  'storm_wind',
  'other',
];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  intake: 'Intake',
  documentation: 'Documenting damage',
  submitted_to_carrier: 'Submitted to carrier',
  adjuster_scheduled: 'Adjuster scheduled',
  approved: 'Approved',
  denied: 'Denied',
  in_repair: 'In repair',
  closed: 'Closed',
};

export const CLAIM_STATUS_COLORS: Record<ClaimStatus, string> = {
  intake: 'bg-bg-tertiary text-text-secondary',
  documentation: 'bg-accent/10 text-accent',
  submitted_to_carrier: 'bg-accent/10 text-accent',
  adjuster_scheduled: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-success-500/10 text-success-500',
  denied: 'bg-danger/10 text-danger',
  in_repair: 'bg-warning-500/10 text-warning-500',
  closed: 'bg-bg-tertiary text-text-secondary',
};

// Ordered pipeline — used to populate the status <select> in the same
// sequence a claim actually moves through, "denied" set apart as the
// off-ramp rather than a middle step.
export const CLAIM_STATUS_OPTIONS: ClaimStatus[] = [
  'intake',
  'documentation',
  'submitted_to_carrier',
  'adjuster_scheduled',
  'approved',
  'in_repair',
  'closed',
  'denied',
];

// A claim still actively moving (not denied/closed) — drives the "open
// claims" stat and the default list filter.
export function isOpenClaim(status: ClaimStatus): boolean {
  return status !== 'denied' && status !== 'closed';
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return 'Not on file';
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}
