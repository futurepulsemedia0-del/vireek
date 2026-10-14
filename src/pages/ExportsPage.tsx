import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderDown,
  Loader2,
  Lock,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  EXPORT_DATASET_LIST,
  EXPORT_DATASETS,
  EXPORT_FORMATS,
  FILE_RETENTION_DAYS,
  FORMAT_LABEL,
  FORMAT_ROW_CAP,
  createExport,
  datasetLabel,
  deleteExport,
  describeFilters,
  downloadExport,
  effectiveStatus,
  expiresIn,
  isActiveJob,
  listExports,
  timeAgo,
  useCanExport,
  type ExportDatasetId,
  type ExportFormat,
  type ExportJob,
  type ExportJobStatus,
} from '@/lib/dataExports';
import { formatBytes } from '../../supabase/functions/_shared/exports/engine';

const PAGE_STEP = 25;
const POLL_MS = 4000;

const FORMAT_ICON: Record<ExportFormat, typeof FileText> = {
  csv: FileText,
  xlsx: FileSpreadsheet,
  pdf: FileType,
};

const STATUS_STYLE: Record<ExportJobStatus, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-bg-tertiary text-text-secondary' },
  processing: { label: 'Processing', cls: 'bg-accent/10 text-accent' },
  completed: { label: 'Ready', cls: 'bg-success-500/10 text-success-500' },
  failed: { label: 'Failed', cls: 'bg-danger/10 text-danger' },
  expired: { label: 'Expired', cls: 'bg-bg-tertiary text-text-secondary' },
};

function StatusBadge({ status }: { status: ExportJobStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.cls}`}>
      {(status === 'queued' || status === 'processing') && <Loader2 size={11} className="animate-spin" />}
      {status === 'completed' && <CheckCircle2 size={11} />}
      {status === 'failed' && <AlertTriangle size={11} />}
      {s.label}
    </span>
  );
}

function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Exports">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">Export access required</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Exports contain customer data, so they're limited to people the account owner has granted the “export data”
          permission. Ask your account owner to enable it for you.
        </p>
      </div>
    </DashboardLayout>
  );
}

export function ExportsPage() {
  const canExport = useCanExport();
  const { isOwner, profile, teamMember } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [limit, setLimit] = useState(PAGE_STEP);

  const [dataset, setDataset] = useState<ExportDatasetId>('calls');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [creating, setCreating] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ExportJob | null>(null);

  const def = EXPORT_DATASETS[dataset];
  const dateError = dateFrom && dateTo && dateFrom > dateTo ? '“From” must be on or before “To”.' : null;

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setJobs(await listExports(limit));
        setLoadError(false);
      } catch {
        if (!silent) setLoadError(true);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [limit],
  );

  useEffect(() => {
    if (canExport) void load();
  }, [canExport, load]);

  // Realtime: status flips (queued -> processing -> ready) appear instantly.
  const liveStatus = useRealtimeSubscription<ExportJob>({
    channelName: `exports-page-${accountOwnerId ?? 'anon'}`,
    table: 'export_jobs',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: canExport && !!accountOwnerId,
    onChange: () => void load(true),
  });

  // Safety net: poll while something is running (covers a dropped socket).
  const hasActive = useMemo(() => jobs.some(isActiveJob), [jobs]);
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const onDatasetChange = (id: ExportDatasetId) => {
    setDataset(id);
    setStatus('all');
  };

  const handleCreate = async () => {
    if (dateError || creating) return;
    setCreating(true);
    try {
      await createExport({
        dataset,
        format,
        filters: {
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          status: status === 'all' ? undefined : status,
          search: search.trim() || undefined,
        },
      });
      toast('Export started. It will appear below as soon as it is ready.', 'success');
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the export.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (job: ExportJob) => {
    setBusyId(job.id);
    try {
      await downloadExport(job.id);
      void load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not download this export.', 'error');
      void load(true);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const job = confirmDelete;
    setConfirmDelete(null);
    setBusyId(job.id);
    try {
      await deleteExport(job.id);
      toast('Export file deleted.', 'success');
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete this export.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (!canExport) return <NoAccess />;

  const rowActions = (job: ExportJob) => {
    const st = effectiveStatus(job);
    const busy = busyId === job.id;
    return (
      <div className="flex items-center justify-end gap-2">
        {st === 'completed' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleDownload(job)}
            className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download
          </button>
        )}
        {(st === 'completed' || st === 'failed') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(job)}
            aria-label="Delete export"
            className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary transition-colors hover:text-danger disabled:opacity-60"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    );
  };

  const detailLine = (job: ExportJob) => {
    const st = effectiveStatus(job);
    if (st === 'failed') return job.error_message ?? 'This export failed.';
    if (st === 'completed') {
      const rows = `${(job.row_count ?? 0).toLocaleString('en-US')} rows`;
      return `${rows} · ${formatBytes(job.file_size_bytes)} · ${expiresIn(job.expires_at)}${job.truncated ? ' · truncated' : ''}`;
    }
    if (st === 'expired') return 'File removed. Create a new export if you still need it.';
    return 'Preparing your file…';
  };

  return (
    <DashboardLayout activeLabel="Exports">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FolderDown size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Exports</h1>
              <LiveIndicator status={liveStatus} />
            </div>
            <p className="text-sm text-text-secondary">
              Export your data as CSV, Excel or PDF. Files are private and are deleted after {FILE_RETENTION_DAYS} days.
            </p>
          </div>
        </div>

        {/* Create */}
        <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6">
          <h2 className="text-base font-semibold text-text-primary">New export</h2>

          <fieldset className="mt-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Data</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {EXPORT_DATASET_LIST.map((d) => (
                <label
                  key={d.id}
                  className={`focus-within:ring-2 focus-within:ring-accent/40 flex cursor-pointer flex-col rounded-xl border p-3 transition-colors ${
                    dataset === d.id ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-tertiary'
                  }`}
                >
                  <input
                    type="radio"
                    name="export-dataset"
                    className="sr-only"
                    checked={dataset === d.id}
                    onChange={() => onDatasetChange(d.id)}
                  />
                  <span className="text-sm font-semibold text-text-primary">{d.label}</span>
                  <span className="mt-0.5 text-xs leading-snug text-text-secondary">{d.description}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
              >
                <option value="all">All statuses</option>
                {def.statusValues.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {def.dateLabel} from
              </span>
              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)}
                className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {def.dateLabel} to
              </span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Search</span>
              <input
                type="search"
                value={search}
                maxLength={100}
                placeholder="Name, phone, email…"
                onChange={(e) => setSearch(e.target.value)}
                className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60"
              />
            </label>
          </div>
          {dateError && (
            <p role="alert" className="mt-2 text-xs font-medium text-danger">
              {dateError}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Format</span>
              <div role="radiogroup" aria-label="Format" className="mt-1.5 inline-flex rounded-xl border border-border bg-bg-primary p-1">
                {EXPORT_FORMATS.map((f) => {
                  const Icon = FORMAT_ICON[f];
                  const active = format === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setFormat(f)}
                      className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                        active ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      <Icon size={14} /> {FORMAT_LABEL[f]}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              disabled={creating || !!dateError}
              onClick={handleCreate}
              className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50 sm:w-auto"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {creating ? 'Starting…' : 'Create export'}
            </button>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-text-secondary">
            Up to {FORMAT_ROW_CAP[format].toLocaleString('en-US')} rows per {FORMAT_LABEL[format]} file, newest first.
            {format === 'pdf' && ' PDFs support Latin characters only. Use CSV or Excel for Arabic, Farsi, Chinese, Hindi or Japanese text.'}
            {' '}Times are in UTC.
          </p>
        </section>

        {/* History */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">Export history</h2>
            <button
              type="button"
              onClick={() => void load()}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {loading ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading exports">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="mt-3 h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : loadError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Couldn't load your exports"
              description="Check your connection and try again."
              action={{ label: 'Try again', onClick: () => void load() }}
            />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={FolderDown}
              title="No exports yet"
              description="Create your first export above. You can also use the Export button on Calls, Leads, Customers, Jobs and Invoices."
            />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-hidden rounded-2xl border border-border bg-bg-secondary md:block">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-bg-tertiary/50 text-xs uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-semibold">Export</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Details</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Requested</th>
                      <th scope="col" className="px-4 py-3 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {jobs.map((job) => {
                      const st = effectiveStatus(job);
                      const Icon = FORMAT_ICON[job.format];
                      const def2 = EXPORT_DATASETS[job.dataset as ExportDatasetId];
                      return (
                        <tr key={job.id} className={st === 'expired' ? 'opacity-60' : undefined}>
                          <td className="px-4 py-3 align-top">
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
                                <Icon size={15} />
                              </span>
                              <div className="min-w-0">
                                <p className="font-medium text-text-primary">
                                  {datasetLabel(job.dataset)} · {FORMAT_LABEL[job.format]}
                                </p>
                                <p className="max-w-xs truncate text-xs text-text-secondary">
                                  {def2 ? describeFilters(def2, job.filters ?? {}) : '—'}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top"><StatusBadge status={st} /></td>
                          <td className="max-w-xs px-4 py-3 align-top text-xs text-text-secondary">{detailLine(job)}</td>
                          <td className="px-4 py-3 align-top text-xs text-text-secondary">
                            <p>{timeAgo(job.created_at)}</p>
                            <p className="max-w-[10rem] truncate">{job.requested_by_email ?? ''}</p>
                          </td>
                          <td className="px-4 py-3 align-top">{rowActions(job)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="space-y-3 md:hidden">
                {jobs.map((job) => {
                  const st = effectiveStatus(job);
                  const Icon = FORMAT_ICON[job.format];
                  return (
                    <li
                      key={job.id}
                      className={`rounded-2xl border border-border bg-bg-secondary p-4 ${st === 'expired' ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
                            <Icon size={16} />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-text-primary">
                              {datasetLabel(job.dataset)} · {FORMAT_LABEL[job.format]}
                            </p>
                            <p className="flex items-center gap-1 text-xs text-text-secondary">
                              <Clock size={11} /> {timeAgo(job.created_at)}
                            </p>
                          </div>
                        </div>
                        <StatusBadge status={st} />
                      </div>
                      <p className="mt-3 text-xs text-text-secondary">{detailLine(job)}</p>
                      <div className="mt-3">{rowActions(job)}</div>
                    </li>
                  );
                })}
              </ul>

              {jobs.length >= limit && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setLimit((l) => l + PAGE_STEP)}
                    className="focus-ring rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    Show more
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this export?"
        description="The file is removed immediately and any download link stops working. This can't be undone, but you can always create a new export."
        confirmLabel="Delete export"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </DashboardLayout>
  );
}
