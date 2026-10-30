import { AlertTriangle, CheckCircle2, Clock, Ban, XCircle } from 'lucide-react';
import {
  STATUS_LABELS,
  daysToNextAction,
  leakUrgency,
  type LeakCase,
  type LeakCaseStatus,
  type LeakCaseLike,
} from '@/lib/leakRepair';

export const inputClass =
  'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
export const btnPrimary =
  'focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
export const btnGhost =
  'focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50';
export const btnDanger =
  'focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-medium text-danger disabled:opacity-50';

/** "2026-10-18" or an ISO timestamp -> locale date (UTC day, so it matches the server's dates). */
export function fmtDay(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_TONE: Record<LeakCaseStatus, string> = {
  open: 'bg-warning-500/10 text-warning-500',
  initial_verified: 'bg-accent/10 text-accent',
  verified: 'bg-accent/10 text-accent',
  followup_scheduled: 'bg-accent/10 text-accent',
  failed: 'bg-danger/10 text-danger',
  closed: 'bg-success-500/10 text-success-500',
  voided: 'bg-bg-tertiary text-text-secondary',
};

const STATUS_SHORT: Record<LeakCaseStatus, string> = {
  open: 'Open',
  initial_verified: 'First test passed',
  verified: 'Verified',
  followup_scheduled: 'Follow-ups scheduled',
  failed: 'Repair failed',
  closed: 'Closed',
  voided: 'Voided',
};

export function StatusBadge({ status }: { status: LeakCaseStatus }) {
  const Icon =
    status === 'closed'
      ? CheckCircle2
      : status === 'failed'
        ? XCircle
        : status === 'voided'
          ? Ban
          : Clock;
  return (
    <span
      title={STATUS_LABELS[status]}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}
    >
      <Icon size={11} aria-hidden="true" /> {STATUS_SHORT[status]}
    </span>
  );
}

/** Overdue / due-soon pill for the case's next action. Text + icon, never colour alone. */
export function UrgencyBadge({ c, now }: { c: LeakCaseLike; now?: Date }) {
  const urgency = leakUrgency(c, now);
  const d = daysToNextAction(c, now);
  if (urgency === 'none' || d === null) return null;
  if (urgency === 'overdue') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
        <AlertTriangle size={11} aria-hidden="true" /> Overdue {Math.abs(d)}d
      </span>
    );
  }
  if (urgency === 'due_soon') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">
        <Clock size={11} aria-hidden="true" /> {d === 0 ? 'Due today' : `Due in ${d}d`}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
      <Clock size={11} aria-hidden="true" /> {d}d left
    </span>
  );
}

export const unitTitle = (c: Pick<LeakCase, 'equipment_label' | 'equipment_serial'>) =>
  (c.equipment_label ?? 'Unit') + (c.equipment_serial ? ` · S/N ${c.equipment_serial}` : '');
