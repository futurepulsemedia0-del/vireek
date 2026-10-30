import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ClipboardCheck } from 'lucide-react';
import {
  NEXT_ACTION_LABELS,
  fetchInspectionForJob,
  fetchLiveCasesForUnits,
  type LeakInspection,
  type LiveLeakCaseRef,
} from '@/lib/leakRepair';
import { UrgencyBadge, fmtDay } from '@/components/leak/leakUi';

/**
 * Shown on a job's refrigerant panel: (1) this job IS a leak follow-up
 * inspection, and (2) any live leak case on the units being serviced.
 * Renders nothing when there is nothing to show or the lookup fails.
 */
export function JobLeakBanner({ jobId, unitIds }: { jobId: string; unitIds: string[] }) {
  const [cases, setCases] = useState<LiveLeakCaseRef[]>([]);
  const [inspection, setInspection] = useState<LeakInspection | null>(null);
  const key = unitIds.join(',');

  useEffect(() => {
    let alive = true;
    Promise.all([fetchLiveCasesForUnits(unitIds), fetchInspectionForJob(jobId)])
      .then(([c, i]) => {
        if (!alive) return;
        setCases(c);
        setInspection(i && i.status === 'scheduled' ? i : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, key]);

  if (cases.length === 0 && !inspection) return null;
  return (
    <div className="mt-3 space-y-2" aria-label="Leak repair status">
      {inspection && (
        <Link
          to={`/dashboard/refrigerant-leaks?case=${inspection.case_id}`}
          className="focus-ring flex items-start gap-2 rounded-lg bg-accent/10 p-3 text-sm text-text-primary"
        >
          <ClipboardCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <span>
            This job is leak follow-up inspection #{inspection.period_index} (due{' '}
            {fmtDay(inspection.due_date)}). Open the case to record the result.
          </span>
        </Link>
      )}
      {cases.map((c) => (
        <Link
          key={c.id}
          to={`/dashboard/refrigerant-leaks?case=${c.id}`}
          className="focus-ring flex flex-wrap items-center gap-2 rounded-lg bg-warning-500/10 p-3 text-sm text-text-primary"
        >
          <AlertTriangle size={16} className="shrink-0 text-warning-500" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Open leak case on {c.equipment_label ?? 'this unit'}
            {c.next_action && c.next_action_due_at
              ? `: ${NEXT_ACTION_LABELS[c.next_action]} by ${fmtDay(c.next_action_due_at)}`
              : ''}
          </span>
          <UrgencyBadge c={c} />
        </Link>
      ))}
    </div>
  );
}
