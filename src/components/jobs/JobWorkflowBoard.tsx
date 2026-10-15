import { useState } from 'react';
import { ChevronDown, PauseCircle } from 'lucide-react';
import type { Job } from '@/lib/supabase';
import {
  WORKFLOW_STATUSES,
  WORKFLOW_STATUS_META,
  holdAge,
  reasonLabel,
  summarizeHolds,
  type JobHold,
  type WorkflowStatus,
} from '@/lib/jobWorkflow';
import { JobSlaChip } from '@/components/jobs/JobSlaChip';

export interface JobWorkflowBoardProps {
  jobsByStatus: Record<WorkflowStatus, Job[]>;
  holdsByJob: ReadonlyMap<string, JobHold>;
  /** Ticking clock from useOpenJobHolds so SLA chips stay live. */
  now: Date;
  draggingId: string | null;
  dragOverStage: string | null;
  onDragOver: (e: React.DragEvent, status: WorkflowStatus) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, status: WorkflowStatus) => void;
  onCardDragStart: (e: React.DragEvent, job: Job) => void;
  onCardDragEnd: () => void;
  onOpenJob: (job: Job) => void;
}

/**
 * Second kanban band for the five workflow statuses. It auto-opens when any job is paused or a
 * card is being dragged (so it is always a valid drop target), and can be toggled by hand.
 */
export function JobWorkflowBoard({
  jobsByStatus,
  holdsByJob,
  now,
  draggingId,
  dragOverStage,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onOpenJob,
}: JobWorkflowBoardProps) {
  const [manual, setManual] = useState<boolean | null>(null);
  const summary = summarizeHolds([...holdsByJob.values()], now);
  const open = manual ?? (summary.total > 0 || draggingId !== null);

  return (
    <section aria-label="Paused and follow-up jobs" className="mt-4">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-2 rounded-xl px-1 py-2 text-left"
      >
        <PauseCircle size={16} className="text-text-secondary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-text-primary">Paused &amp; follow-up</h2>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">{summary.total}</span>
        {summary.breached > 0 && (
          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">{summary.breached} overdue</span>
        )}
        <ChevronDown size={16} className={`ml-auto text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="mt-2 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {WORKFLOW_STATUSES.map((status) => {
            const meta = WORKFLOW_STATUS_META[status];
            const jobs = jobsByStatus[status] ?? [];
            return (
              <div
                key={status}
                data-testid={`workflow-column-${status}`}
                onDragOver={(e) => onDragOver(e, status)}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, status)}
                className={`rounded-2xl border-x border-b border-t-4 border-border ${meta.border} bg-bg-secondary p-4 shadow-card transition-colors dark:shadow-card-dark ${
                  dragOverStage === status ? 'ring-2 ring-accent/40' : ''
                }`}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
                    <h3 className="truncate text-sm font-semibold text-text-primary">{meta.label}</h3>
                  </div>
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">{jobs.length}</span>
                </div>
                <ul className="min-h-[72px] space-y-2.5">
                  {jobs.map((job) => {
                    const hold = holdsByJob.get(job.id);
                    return (
                      <li key={job.id}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => onCardDragStart(e, job)}
                          onDragEnd={onCardDragEnd}
                          onClick={() => onOpenJob(job)}
                          className={`focus-ring w-full rounded-xl border border-border bg-bg-primary p-3 text-left transition-opacity hover:border-accent/40 ${
                            draggingId === job.id ? 'opacity-40' : ''
                          }`}
                        >
                          <span className="block truncate text-sm font-semibold text-text-primary">{job.customer_name}</span>
                          {job.service_type && <span className="mt-0.5 block truncate text-xs text-text-secondary">{job.service_type}</span>}
                          {hold ? (
                            <>
                              <span className="mt-2 block text-xs text-text-primary">{reasonLabel(status, hold.reason_code)}</span>
                              {hold.reason_note && <span className="mt-0.5 line-clamp-2 block text-xs text-text-secondary">{hold.reason_note}</span>}
                              <span className="mt-2 flex flex-wrap items-center gap-1.5">
                                <JobSlaChip hold={hold} now={now} />
                                <span className="text-[11px] text-text-secondary">for {holdAge(hold, now)}</span>
                              </span>
                            </>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                  {jobs.length === 0 && <li className="py-3 text-center text-xs text-text-secondary/60">Drop a job here</li>}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
