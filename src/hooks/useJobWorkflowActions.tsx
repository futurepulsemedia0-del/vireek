import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { JobHoldDialog } from '@/components/jobs/JobHoldDialog';
import { useOpenJobHolds } from '@/hooks/useOpenJobHolds';
import { fetchWorkflowPolicies, resumeJobFromWorkflow, setJobWorkflowStatus } from '@/lib/jobWorkflowApi';
import {
  DEFAULT_WORKFLOW_POLICIES,
  WORKFLOW_STATUS_META,
  type HoldPayload,
  type ResumeTarget,
  type WorkflowPolicy,
  type WorkflowStatus,
} from '@/lib/jobWorkflow';

type JobRef = { id: string; customer_name: string };

/**
 * Everything a jobs list/board needs for the extended workflow in one hook: open holds (with a
 * ticking clock), the "reason required" dialog, and the enter / resume actions.
 * `onChanged` lets the page patch its local job list; `refreshKey` re-reads holds when the
 * page's own data (e.g. realtime) shows a workflow status changed elsewhere.
 */
export function useJobWorkflowActions({
  onChanged,
  refreshKey = '',
}: {
  onChanged: (jobId: string, status: string) => void;
  refreshKey?: string;
}) {
  const { toast } = useToast();
  const { byJob, now, summary, refresh } = useOpenJobHolds();
  const [target, setTarget] = useState<{ job: JobRef; status: WorkflowStatus } | null>(null);
  const [policies, setPolicies] = useState<Record<WorkflowStatus, WorkflowPolicy>>(DEFAULT_WORKFLOW_POLICIES);

  useEffect(() => {
    let alive = true;
    fetchWorkflowPolicies()
      .then((p) => alive && setPolicies(p))
      .catch(() => undefined); // defaults are a safe fallback
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (refreshKey !== '') void refresh();
  }, [refreshKey, refresh]);

  const requestWorkflowStatus = useCallback((job: JobRef, status: WorkflowStatus) => setTarget({ job, status }), []);

  const submit = async (payload: HoldPayload): Promise<string | null> => {
    if (!target) return null;
    const res = await setJobWorkflowStatus(target.job.id, payload);
    if (!res.ok) return res.message ?? 'Could not update the job status.';
    toast(`Job set to ${WORKFLOW_STATUS_META[payload.status].label.toLowerCase()}`, 'success');
    onChanged(target.job.id, payload.status);
    setTarget(null);
    void refresh();
    return null;
  };

  const resumeJob = useCallback(
    async (job: JobRef, to: ResumeTarget) => {
      const res = await resumeJobFromWorkflow(job.id, to, null);
      if (res.ok) {
        toast('Job resumed', 'success');
        onChanged(job.id, to);
        void refresh();
      } else {
        toast(res.message ?? 'Could not resume the job', 'error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refresh, toast],
  );

  const holdDialog: ReactNode = (
    <JobHoldDialog
      open={target !== null}
      jobLabel={target?.job.customer_name ?? ''}
      initialStatus={target?.status ?? null}
      policies={policies}
      onSubmit={submit}
      onClose={() => setTarget(null)}
    />
  );

  return { byJob, now, summary, refresh, requestWorkflowStatus, resumeJob, holdDialog };
}
