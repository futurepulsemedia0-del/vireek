export const NEED_TYPE_LABELS: Record<string, string> = {
  overflow_calls: 'Overflow call handling',
  technician_labor: 'Technician / labor help',
  both: 'Overflow calls + labor',
};

export const OFFER_STATUS_LABELS: Record<string, string> = {
  offered: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

export const OFFER_STATUS_COLORS: Record<string, string> = {
  offered: 'bg-warning-subtle text-warning',
  accepted: 'bg-success-subtle text-success',
  declined: 'bg-bg-tertiary text-text-secondary',
  withdrawn: 'bg-bg-tertiary text-text-secondary',
};

export function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'Expires soon';
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}
