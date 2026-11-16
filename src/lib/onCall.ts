export const ROTATION_TYPE_LABELS: Record<string, string> = {
  daily: 'Daily rotation',
  weekly: 'Weekly rotation',
};

export const NOTIFY_VIA_LABELS: Record<string, string> = {
  sms: 'Text message',
  call: 'Phone call',
  both: 'Text + call',
};

export const ESCALATION_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  acknowledged: 'Acknowledged',
  exhausted: 'Exhausted',
  cancelled: 'Cancelled',
};

export const ESCALATION_STATUS_COLORS: Record<string, string> = {
  active: 'bg-warning-subtle text-warning',
  acknowledged: 'bg-success-subtle text-success',
  exhausted: 'bg-error-500/10 text-error-500',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};

export function formatHandoffHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:00 ${period}`;
}
