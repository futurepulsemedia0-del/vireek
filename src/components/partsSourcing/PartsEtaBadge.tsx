// Recreated: verify against original intent
import { CalendarClock } from 'lucide-react';
import { isEtaWarning, type EtaCheck } from '@/lib/partsSourcing';

interface Props {
  check?: (EtaCheck & { eta?: string | null }) | null;
}

/** Dispatch-board badge: only shown when parts delivery puts the appointment at risk. Renders nothing otherwise. */
export function PartsEtaBadge({ check }: Props) {
  if (!check || !isEtaWarning(check.status)) return null;

  const late = Math.max(1, check.daysLate);
  const text =
    check.status === 'conflict'
      ? `Parts arrive ${late} day${late === 1 ? '' : 's'} after the appointment`
      : check.status === 'tight'
        ? 'Parts arrive on the appointment day'
        : 'Parts needed — no delivery date';
  const tone = check.status === 'conflict' ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`} title={text}>
      <CalendarClock size={11} aria-hidden="true" />
      {text}
    </span>
  );
}
