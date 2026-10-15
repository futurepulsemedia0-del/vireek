import { useState } from 'react';
import { Download, History, RefreshCw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  SOURCE_LABELS, STATUS_LABELS, canRollBack, downloadTextFile, listImportRowErrors, rollbackImport, rowErrorsToCsv,
  type ImportJobRecord, type ImportJobStatus,
} from '@/lib/importWizard';

const TONE: Record<ImportJobStatus, string> = {
  pending: 'bg-bg-tertiary text-text-secondary',
  running: 'bg-accent/10 text-accent',
  completed: 'bg-success/10 text-success',
  completed_with_errors: 'bg-amber-500/10 text-amber-600',
  failed: 'bg-danger/10 text-danger',
  rolling_back: 'bg-accent/10 text-accent',
  rolled_back: 'bg-bg-tertiary text-text-secondary',
};

interface Props {
  accountOwnerId: string;
  jobs: ImportJobRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function ImportHistory({ accountOwnerId, jobs, loading, error, onRefresh }: Props) {
  const { toast } = useToast();
  const [target, setTarget] = useState<ImportJobRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const undo = async () => {
    if (!target) return;
    setBusyId(target.id);
    try {
      const r = await rollbackImport(target.id);
      toast(`Import undone: ${r.deleted} removed, ${r.restored} restored${r.kept_modified ? `, ${r.kept_modified} kept (edited since)` : ''}${r.blocked ? `, ${r.blocked} couldn’t be removed` : ''}.`, r.blocked ? 'info' : 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not undo this import.', 'error');
    } finally {
      setBusyId(null);
      setTarget(null);
      onRefresh();
    }
  };

  const download = async (job: ImportJobRecord) => {
    setBusyId(job.id);
    try {
      downloadTextFile(`vireek-import-errors-${job.id.slice(0, 8)}.csv`, rowErrorsToCsv(await listImportRowErrors(accountOwnerId, job.id)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not download the failed rows.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="Import history" className="rounded-2xl border border-border bg-bg-secondary p-5 md:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><History size={18} className="text-accent" /> Import history</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading} aria-label="Refresh history"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></Button>
      </div>

      {loading && jobs.length === 0 ? (
        <SkeletonCardList count={3} rows={2} />
      ) : error ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          {error}
          <Button size="sm" variant="secondary" onClick={onRefresh}>Try again</Button>
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState icon={History} title="No imports yet" description="Your imports will appear here, each one with a one-click undo." />
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${TONE[job.status]}`}>{STATUS_LABELS[job.status]}</span>
                <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{job.file_name ?? 'Untitled file'}</span>
                <span className="text-xs text-text-secondary">{SOURCE_LABELS[job.source] ?? job.source} · {job.import_type === 'customers' ? 'Customers' : 'Jobs'}</span>
              </div>
              <p className="mt-1 text-xs tabular-nums text-text-secondary">
                {new Date(job.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {job.created_count.toLocaleString()} added · {job.updated_count.toLocaleString()} updated · {job.skipped_count.toLocaleString()} skipped · {job.error_count.toLocaleString()} errors
              </p>
              {job.failure_reason && <p className="mt-1 text-xs text-danger">{job.failure_reason}</p>}
              {job.status === 'rolled_back' && job.rollback_summary && (
                <p className="mt-1 text-xs text-text-secondary">Undone: {job.rollback_summary.deleted} removed, {job.rollback_summary.restored} restored{job.rollback_summary.kept_modified ? `, ${job.rollback_summary.kept_modified} kept (edited since)` : ''}.</p>
              )}
              {(job.error_count > 0 || canRollBack(job)) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {job.error_count > 0 && <Button size="sm" variant="secondary" onClick={() => void download(job)} disabled={busyId === job.id}><Download size={14} /> Failed rows</Button>}
                  {canRollBack(job) && <Button size="sm" variant="ghost" onClick={() => setTarget(job)} disabled={busyId === job.id}><Undo2 size={14} /> Undo</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={target !== null}
        title="Undo this import?"
        description={`“${target?.file_name ?? 'This import'}” — records it added will be removed (unless you've edited them since) and records it updated will return to their previous values. Newer imports must be undone first.`}
        confirmPhrase="undo import"
        confirmLabel="Undo import"
        onConfirm={undo}
        onCancel={() => setTarget(null)}
      />
    </section>
  );
}
