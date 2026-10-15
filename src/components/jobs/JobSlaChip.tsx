import { Clock } from 'lucide-react';
import { SLA_TONE, computeSla, type JobHold } from '@/lib/jobWorkflow';

/**
 * Live SLA badge for an open hold. Pass the ticking `now` from useOpenJobHolds so every chip
 * on the page updates together; omit it for a one-off render.
 */
export function JobSlaChip({ hold, now, className = '' }: { hold: JobHold; now?: Date; className?: string }) {
  const sla = computeSla(hold, now);
  if (sla.state === 'none') return null;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${SLA_TONE[sla.state]} ${className}`}
      title={hold.sla_due_at ? `SLA due ${new Date(hold.sla_due_at).toLocaleString()}` : undefined}
      data-sla-state={sla.state}
    >
      <Clock size={11} aria-hidden="true" />
      {sla.label}
    </span>
  );
}
