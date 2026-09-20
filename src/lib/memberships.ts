export function formatPrice(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(0)}`;
}

export function formatBillingInterval(interval: 'monthly' | 'yearly'): string {
  return interval === 'monthly' ? '/mo' : '/yr';
}

export const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  offered: 'Offered',
  active: 'Active',
  past_due: 'Past due',
  cancelled: 'Cancelled',
  churned: 'Churned',
};

export const MEMBERSHIP_STATUS_COLORS: Record<string, string> = {
  offered: 'bg-accent/10 text-accent',
  active: 'bg-success-500/10 text-success-500',
  past_due: 'bg-warning-500/10 text-warning-500',
  cancelled: 'bg-bg-tertiary text-text-secondary',
  churned: 'bg-danger/10 text-danger',
};

/** Normalizes a yearly or monthly plan price into a monthly figure, for MRR math. */
export function toMonthlyCents(priceCents: number, interval: 'monthly' | 'yearly'): number {
  return interval === 'yearly' ? Math.round(priceCents / 12) : priceCents;
}
