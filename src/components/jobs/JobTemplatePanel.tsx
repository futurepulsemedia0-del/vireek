import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, LayoutTemplate, RefreshCw } from 'lucide-react';
import type { Job } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/priceBook';
import {
  JobChecklistItem,
  JobTemplateSnapshot,
  checklistProgress,
  describeTemplateError,
  fetchJobChecklist,
  formatDuration,
  servicesTotalCents,
  setChecklistItemDone,
} from '@/lib/jobTemplates';

/**
 * Shows the template a job was created from (an immutable snapshot, so later
 * edits or deletion of the template never change history) and the job's
 * checklist, which the crew can tick off. Renders nothing for jobs that were
 * not created from a template.
 */
export function JobTemplatePanel({ job }: { job: Job }) {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canSeePrices = isOwner || permissions.can_view_billing;

  const templateId = (job.job_template_id as string | null | undefined) ?? null;
  const snapshot = (job.job_template_snapshot as JobTemplateSnapshot | null | undefined) ?? null;

  const [items, setItems] = useState<JobChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const jobIdRef = useRef(job.id);
  jobIdRef.current = job.id;

  const load = useCallback(async () => {
    if (!templateId) return;
    const requestedFor = job.id;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchJobChecklist(requestedFor);
      if (jobIdRef.current === requestedFor) setItems(rows);
    } catch (err) {
      if (jobIdRef.current === requestedFor) setError(describeTemplateError(err, 'Could not load the checklist.'));
    } finally {
      if (jobIdRef.current === requestedFor) setLoading(false);
    }
  }, [job.id, templateId]);

  useEffect(() => {
    setItems([]);
    void load();
  }, [load]);

  const toggle = async (item: JobChecklistItem) => {
    if (pending.has(item.id)) return;
    const nextDone = !item.completed_at;
    const optimistic: JobChecklistItem = { ...item, completed_at: nextDone ? new Date().toISOString() : null };

    setPending((p) => new Set(p).add(item.id));
    setItems((prev) => prev.map((i) => (i.id === item.id ? optimistic : i)));
    try {
      const saved = await setChecklistItemDone(item.id, nextDone);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...saved } : i)));
    } catch (err) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      toast(describeTemplateError(err, 'Could not update the checklist.'), 'error');
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Not created from a template (and nothing was ever snapshotted).
  if (!templateId && !snapshot) return null;

  const progress = checklistProgress(items);
  const services = snapshot?.services ?? [];
  const quotedCents = snapshot?.price_cents ?? (job.quoted_price_cents as number | null | undefined) ?? 0;

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <LayoutTemplate size={14} className="text-accent" />
        {snapshot?.name ?? 'Job template'}
      </h4>

      {snapshot && (
        <p className="mt-1 text-xs text-text-secondary">
          {formatDuration(snapshot.duration_minutes)}
          {canSeePrices && quotedCents > 0 && ` · Quoted ${formatCents(quotedCents)}`}
        </p>
      )}

      {services.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {services.map((s, i) => (
            <li key={`${s.service_name}-${i}`} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-text-primary">
                {s.quantity !== 1 && <span className="text-text-secondary">{s.quantity} × </span>}
                {s.service_name}
              </span>
              {canSeePrices && (
                <span className="shrink-0 text-xs text-text-secondary">
                  {formatCents(servicesTotalCents([s]))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Checklist */}
      <div className="mt-4 border-t border-border pt-3">
        {loading ? (
          <div className="space-y-2" role="status" aria-label="Loading checklist">
            <div className="h-4 w-1/2 animate-pulse rounded bg-bg-tertiary" />
            <div className="h-9 animate-pulse rounded-lg bg-bg-tertiary" />
            <div className="h-9 animate-pulse rounded-lg bg-bg-tertiary" />
          </div>
        ) : error ? (
          <div role="alert" className="flex items-center justify-between gap-3 text-xs text-text-secondary">
            <span className="flex items-center gap-1.5">
              <AlertCircle size={13} className="text-danger" /> {error}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-accent hover:bg-accent/10"
            >
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-text-secondary">This template has no checklist items.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium text-text-primary">Checklist</span>
              <span className="text-text-secondary">
                {progress.done}/{progress.total} done
              </span>
            </div>
            <div
              className="mb-3 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.pct}
              aria-label="Checklist progress"
            >
              <div className="h-full rounded-full bg-success transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
            <ul className="space-y-1.5">
              {items.map((item) => {
                const done = !!item.completed_at;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={done}
                      disabled={pending.has(item.id)}
                      onClick={() => void toggle(item)}
                      className="focus-ring flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-left text-sm transition-colors hover:border-accent/40 disabled:opacity-60"
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                          done ? 'border-success bg-success text-white' : 'border-border bg-bg-primary'
                        }`}
                      >
                        {done && <Check size={13} />}
                      </span>
                      <span className={done ? 'text-text-secondary line-through' : 'text-text-primary'}>{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
