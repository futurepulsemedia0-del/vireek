import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Phone, Star, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { classify, scoreSentiment, type FeedbackRecord } from '@/lib/feedbackAnalytics';
import { fetchFeedbackJob, type FeedbackJob } from '@/lib/feedbackApi';

interface Props {
  record: FeedbackRecord | null;
  accountOwnerId: string;
  onClose: () => void;
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function FeedbackJobDrawer({ record, accountOwnerId, onClose }: Props) {
  const navigate = useNavigate();
  const open = record !== null;
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);

  const [job, setJob] = useState<FeedbackJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobId = record?.job_id ?? null;

  useEffect(() => {
    setJob(null);
    setError(null);
    if (!jobId) return;
    let cancelled = false;
    setLoading(true);
    fetchFeedbackJob(accountOwnerId, jobId)
      .then((j) => { if (!cancelled) setJob(j); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load this job.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, accountOwnerId]);

  if (!record) return null;
  const detractor = classify(record.rating) === 'detractor';
  const sentiment = scoreSentiment(record.comment, record.rating);
  const phone = job?.customer_phone;

  const rows: [string, string][] = job
    ? [
        ['Service', job.service_type ?? '—'], ['Address', job.address ?? '—'], ['Scheduled', fmtDate(job.scheduled_datetime)],
        ['Status', job.job_status.replace('_', ' ')], ['Invoice', job.invoice_amount === null ? '—' : `${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(job.invoice_amount)} · ${job.invoice_status.replace('_', ' ')}`],
        ['Technician', record.technician_name ?? '—'],
      ]
    : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="feedback-job-title" tabIndex={-1} className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-bg-primary p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="feedback-job-title" className="truncate text-lg font-semibold text-text-primary">{record.customer_name ?? 'Customer'}</h2>
            <p className="text-xs text-text-secondary">{record.source === 'review' ? 'Post-job survey' : 'Call rating'} · {fmtDate(record.responded_at)}</p>
          </div>
          <button onClick={onClose} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary" aria-label="Close"><X size={18} /></button>
        </div>

        <div className={`rounded-2xl border p-4 ${detractor ? 'border-danger/30 bg-danger/5' : 'border-border bg-bg-secondary'}`}>
          <p className="flex items-center gap-1 text-text-primary" aria-label={`${record.rating} out of 5 stars`}>
            {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={16} className={n <= record.rating ? 'fill-amber-400 text-amber-400' : 'text-border'} />)}
            <span className="ml-2 text-sm font-semibold">{record.rating}/5</span>
            <span className="ml-1 text-xs capitalize text-text-secondary">· {classify(record.rating)} · {sentiment.label}</span>
          </p>
          {record.comment ? <blockquote className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">“{record.comment}”</blockquote> : <p className="mt-3 text-sm text-text-secondary">No written comment.</p>}
          {detractor && <p className="mt-3 text-xs text-danger">Low score — a quick personal follow-up is the best chance to recover this customer.</p>}
        </div>

        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Job</h3>
          {!jobId ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">This feedback isn’t linked to a job — call ratings link to a job only when a booking came out of that call.</p>
          ) : loading ? (
            <div className="space-y-2" aria-busy="true"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-1/2" /></div>
          ) : error ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p>
          ) : !job ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">This job has been deleted or you don’t have access to it.</p>
          ) : (
            <dl className="divide-y divide-border rounded-xl border border-border text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-3 py-2"><dt className="text-text-secondary">{k}</dt><dd className="min-w-0 break-words text-right text-text-primary">{v}</dd></div>
              ))}
            </dl>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          {jobId && job && (
            <Button className="flex-1" onClick={() => navigate(`/dashboard/jobs?job=${job.id}`)}><ExternalLink size={16} /> Open job</Button>
          )}
          {phone && <a href={`tel:${phone}`} className="focus-ring inline-flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40"><Phone size={16} /> Call customer</a>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
