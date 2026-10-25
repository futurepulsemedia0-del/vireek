import { AlertTriangle, CalendarClock, CheckCircle2, Flame, HelpCircle, Skull, Droplets, Wind, Zap, ShieldAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  SIGNAL_LABEL,
  describeReview,
  hazardLabel,
  reviewState,
  type SdsDocument,
  type SdsHazardClass,
  type SdsSignal,
} from '@/lib/sds';

const HAZARD_ICON: Record<SdsHazardClass, LucideIcon> = {
  flammable: Flame,
  explosive: Zap,
  oxidizer: Flame,
  compressed_gas: Wind,
  corrosive: Droplets,
  toxic: Skull,
  health_hazard: ShieldAlert,
  irritant: AlertTriangle,
  environmental: Droplets,
};

export function SignalBadge({ signal }: { signal: SdsSignal }) {
  if (signal === 'none') return null;
  const tone = signal === 'danger' ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${tone}`}>
      <ShieldAlert size={12} aria-hidden="true" /> {SIGNAL_LABEL[signal]}
    </span>
  );
}

export function HazardChips({ classes }: { classes: SdsHazardClass[] }) {
  if (classes.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Hazard classes">
      {classes.map((c) => {
        const Icon = HAZARD_ICON[c] ?? AlertTriangle;
        return (
          <li key={c} className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-secondary">
            <Icon size={12} aria-hidden="true" /> {hazardLabel(c)}
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewBadge({ doc }: { doc: Pick<SdsDocument, 'review_due_date'> }) {
  const state = reviewState(doc);
  const label = describeReview(doc);
  const tone =
    state === 'overdue'
      ? 'bg-danger/10 text-danger'
      : state === 'due_soon'
        ? 'bg-warning-500/10 text-warning-500'
        : state === 'current'
          ? 'bg-success/10 text-success'
          : 'bg-bg-tertiary text-text-secondary';
  const Icon = state === 'current' ? CheckCircle2 : state === 'unknown' ? HelpCircle : CalendarClock;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      <Icon size={12} aria-hidden="true" /> {label}
    </span>
  );
}
