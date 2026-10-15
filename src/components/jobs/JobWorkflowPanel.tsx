import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Loader2, PauseCircle, Play } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import { JobSection, Pill } from '@/components/jobs/detail/JobSection';
import { JobHoldDialog } from '@/components/jobs/JobHoldDialog';
import { JobSlaChip } from '@/components/jobs/JobSlaChip';
import { fetchJobHoldHistory, resumeJobFromWorkflow, setJobWorkflowStatus } from '@/lib/jobWorkflowApi';
import {
  RESUME_TARGETS,
  WORKFLOW_STATUS_META,
  holdAge,
  isWorkflowStatus,
  reasonLabel,
  suggestResumeStatus,
  type HoldPayload,
  type JobHold,
  type ResumeTarget,
} from '@/lib/jobWorkflow';

const RESUME_LABELS: Record<ResumeTarget, string> = { scheduled: 'Scheduled', en_route: 'En route', in_progress: 'In progress' };
const CLOSED = new Set(['completed', 'cancelled', 'no_show']);

/**
 * Job-detail card for the extended workflow: shows the open hold (reason, SLA, reminders),
 * lets the team pause / change status with a required reason, resume, and review history.
 * Self-contained — it loads its own hold history and calls `onChanged` after any change so the
 * page can re-sync the job row.
 */
export function JobWorkflowPanel({
  job,
  canEdit,
  onChanged,
}: {
  job: Pick<Job, 'id' | 'customer_name' | 'job_status'>;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [history, setHistory] = useState<JobHold[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resumeTo, setResumeTo] = useState<ResumeTarget>('scheduled');
  const [resumeNote, setResumeNote] = useState('');
  const [resuming, setResuming] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      setHistory(await fetchJobHoldHistory(job.id));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [job.id]);

  // Reload when the job's status changes (realtime sync, other tab, board drag...).
  useEffect(() => {
    void load();
  }, [load, job.job_status]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const current = useMemo(() => history?.find((h) => !h.resolved_at && h.status === job.job_status) ?? null, [history, job.job_status]);
  const past = useMemo(() => (history ?? []).filter((h) => h.resolved_at), [history]);
  const onWorkflow = isWorkflowStatus(job.job_status);
  const closed = CLOSED.has(job.job_status);

  useEffect(() => {
    if (current) setResumeTo(suggestResumeStatus(current.previous_status));
  }, [current]);

  const submitHold = async (payload: HoldPayload): Promise<string | null> => {
    const res = await setJobWorkflowStatus(job.id, payload);
    if (!res.ok) return res.message ?? 'Could not update the job status.';
    toast(`Job set to ${WORKFLOW_STATUS_META[payload.status].label.toLowerCase()}`, 'success');
    setDialogOpen(false);
    await load();
    onChanged();
    return null;
  };

  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      const res = await resumeJobFromWorkflow(job.id, resumeTo, resumeNote);
      if (res.ok) {
        toast('Job resumed', 'success');
        setResumeNote('');
        await load();
        onChanged();
      } else {
        toast(res.message ?? 'Could not resume the job', 'error');
      }
    } finally {
      setResuming(false);
    }
  };

  // Nothing to show for closed jobs that never had a hold.
  if (closed && past.length === 0 && !current) return null;

  return (
    <JobSection
      title="Hold & follow-up"
      icon={PauseCircle}
      action={
        canEdit && !closed ? (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/10"
          >
            {onWorkflow ? 'Change status' : 'Pause or flag…'}
          </button>
        ) : undefined
      }
    >
      {history === null && !loadError && (
        <p className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-danger">
          Couldn&apos;t load hold details.{' '}
          <button type="button" onClick={() => void load()} className="focus-ring rounded font-semibold underline">
            Retry
          </button>
        </p>
      )}

      {history !== null && !current && (
        <p className="text-sm text-text-secondary">
          {onWorkflow ? 'This job is in a paused status without a recorded reason.' : 'This job is active. Pause it or flag a follow-up when work can\'t continue.'}
        </p>
      )}

      {current && (
        <div className="space-y-3" data-testid="current-hold">
          <div className="flex flex-wrap items-center gap-2">
            <Pill className="bg-bg-tertiary text-text-primary">{WORKFLOW_STATUS_META[current.status].label}</Pill>
            <JobSlaChip hold={current} now={now} />
            <span className="text-xs text-text-secondary">for {holdAge(current, now)}</span>
          </div>
          <p className="text-sm font-medium text-text-primary">{reasonLabel(current.status, current.reason_code)}</p>
          {current.reason_note && <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{current.reason_note}</p>}
          <dl className="grid gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-2">
            {current.expected_resume_at && (
              <div>
                <dt className="inline">Expected to resume: </dt>
                <dd className="inline text-text-primary">{new Date(current.expected_resume_at).toLocaleString()}</dd>
              </div>
            )}
            {current.max_reminders > 0 && (
              <div>
                <dt className="inline">Reminders: </dt>
                <dd className="inline text-text-primary">
                  {current.reminders_sent} of {current.max_reminders} sent
                </dd>
              </div>
            )}
          </dl>

          {canEdit && (
            <div className="rounded-xl border border-border bg-bg-primary p-3">
              <p className="text-xs font-semibold text-text-primary">Resume work</p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-xs text-text-secondary">
                  <span className="mb-1 block">Resume as</span>
                  <select
                    value={resumeTo}
                    onChange={(e) => setResumeTo(e.target.value as ResumeTarget)}
                    className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
                  >
                    {RESUME_TARGETS.map((t) => (
                      <option key={t} value={t}>
                        {RESUME_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="min-w-[10rem] flex-1 text-xs text-text-secondary">
                  <span className="mb-1 block">Note (optional)</span>
                  <input
                    value={resumeNote}
                    onChange={(e) => setResumeNote(e.target.value)}
                    maxLength={1000}
                    className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
                    placeholder="e.g. Part installed, rebooked"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void resume()}
                  disabled={resuming}
                  className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                >
                  {resuming ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                  Resume
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {past.length > 0 && (
        <details className="mt-4 group">
          <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-lg text-xs font-semibold text-text-secondary hover:text-text-primary">
            <History size={13} aria-hidden="true" /> History ({past.length})
          </summary>
          <ol className="mt-2 space-y-2">
            {past.map((h) => (
              <li key={h.id} className="rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs">
                <p className="font-medium text-text-primary">
                  {WORKFLOW_STATUS_META[h.status].label} · {reasonLabel(h.status, h.reason_code)}
                </p>
                {h.reason_note && <p className="mt-0.5 break-words text-text-secondary">{h.reason_note}</p>}
                <p className="mt-0.5 text-text-secondary">
                  {new Date(h.started_at).toLocaleDateString()} → {h.resolved_at ? new Date(h.resolved_at).toLocaleDateString() : '—'}
                  {h.sla_breached_at ? ' · SLA breached' : ''}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}

      <JobHoldDialog open={dialogOpen} jobLabel={job.customer_name} initialStatus={null} onSubmit={submitHold} onClose={() => setDialogOpen(false)} />
    </JobSection>
  );
}
