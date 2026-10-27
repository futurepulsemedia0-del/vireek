import type { ReactNode } from 'react';
import type { DisplayStatus } from '@/lib/changeOrders';

export const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
export const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/15 text-warning-500',
  danger: 'bg-danger-500/15 text-danger-500',
};

export const statusTone: Record<DisplayStatus, Tone> = {
  draft: 'neutral',
  sent: 'info',
  approved: 'success',
  declined: 'danger',
  cancelled: 'neutral',
  expired: 'warning',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const color = tone === 'danger' ? 'text-danger-500' : tone === 'warning' ? 'text-warning-500' : tone === 'success' ? 'text-success-500' : 'text-text-primary';
  return (
    <div className={panelClass}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1.5 text-xl font-bold tabular-nums sm:text-2xl ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}
