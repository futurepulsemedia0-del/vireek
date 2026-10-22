// "Customer summary" card for the job detail page: generate, review, send.
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { JobSummaryEditor } from '@/components/jobs/JobSummaryEditor';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import type { JobSummary } from '@/lib/jobSummaries';
import { fetchSummaryForJob, generateSummary } from '@/lib/jobSummariesApi';

export function JobSummaryPanel({ jobId, ownerId, jobStatus }: { jobId: string; ownerId: string; jobStatus: string }) {
  const { toast } = useToast();
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchSummaryForJob(jobId, ownerId));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [jobId, ownerId]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  useRealtimeSubscription({
    channelName: `job-summary-${jobId}`,
    table: 'job_summaries',
    event: '*',
    filter: `job_id=eq.${jobId}`,
    onChange: () => void load(),
  });

  async function generate() {
    setGenerating(true);
    const r = await generateSummary(jobId);
    setGenerating(false);
    if (!r.ok) return void toast(r.error, 'error');
    setSummary(r.data.summary);
    setOpen(true);
  }

  if (state === 'error') return null; // no access or table not deployed: stay out of the way

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Customer summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ClipboardCheck size={16} className="text-accent" aria-hidden="true" /> Customer summary
        </h2>
        {summary && (
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Review'}</Button>
        )}
      </div>

      {state === 'loading' && <p className="mt-3 text-sm text-text-secondary">Loading…</p>}

      {state === 'ready' && !summary && (
        <div className="mt-3">
          <p className="text-sm text-text-secondary">
            {jobStatus === 'completed'
              ? 'Create a friendly “what we did” recap with photos, parts, warranty and next-service date. You can edit it before it is sent.'
              : 'Available once the job is completed.'}
          </p>
          {jobStatus === 'completed' && (
            <Button className="mt-3" size="sm" onClick={() => void generate()} disabled={generating}>
              {generating && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Generate summary
            </Button>
          )}
        </div>
      )}

      {summary && !open && (
        <p className="mt-3 text-sm text-text-secondary">
          {summary.sent_at ? 'Sent to the customer.' : summary.status === 'scheduled' ? 'Scheduled to send automatically.' : 'Draft ready for your review.'}
        </p>
      )}
      {summary && open && (
        <div className="mt-4">
          <JobSummaryEditor summary={summary} ownerId={ownerId} onChange={setSummary} />
        </div>
      )}
    </section>
  );
}
