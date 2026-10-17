import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ClipboardCheck, Eye, FileText, Loader2, Lock, Plus, Search, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList } from '@/components/Skeleton';
import { InspectionReportDetail } from '@/components/inspection/InspectionReportDetail';
import { ResultPill, StatusPill } from '@/components/inspection/pills';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  canManageInspectionReports,
  createReport,
  formatDate,
  listJobOptions,
  listReports,
  type JobOption,
  type ReportListRow,
  type ReportStatus,
} from '@/lib/inspectionReports';

type Filter = 'all' | ReportStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'published', label: 'Shared' },
  { key: 'signed', label: 'Signed' },
  { key: 'voided', label: 'Voided' },
];

function JobPicker({ onClose, onPick }: { onClose: () => void; onPick: (job: JobOption) => void }) {
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  const [q, setQ] = useState('');
  const [jobs, setJobs] = useState<JobOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (query: string) => {
    const mine = ++seq.current;
    setJobs(null);
    setError(null);
    try {
      const rows = await listJobOptions(query);
      if (mine === seq.current) setJobs(rows);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load jobs.');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-picker-title"
        className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div>
            <h2 id="job-picker-title" className="text-lg font-bold text-text-primary">New inspection report</h2>
            <p className="mt-1 text-sm text-text-secondary">Pick the job. The checklist, photos and notes are pulled in automatically.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 pb-3">
          <Input aria-label="Search jobs by customer" icon={Search} placeholder="Search by customer name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="min-h-[160px] flex-1 overflow-y-auto px-5 pb-5">
          {error ? (
            <EmptyStateError icon={FileText} title="Couldn't load jobs" description={error} onRetry={() => void load(q)} />
          ) : jobs === null ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading jobs">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState icon={ClipboardCheck} title="No eligible jobs" description="Only completed or in-progress jobs can have an inspection report." />
          ) : (
            <ul className="space-y-2">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button
                    type="button"
                    onClick={() => onPick(j)}
                    className="focus-ring flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-left transition-colors hover:border-accent/40"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-text-primary">{j.customer_name}</span>
                      <span className="block truncate text-xs text-text-secondary">
                        {j.service_type || 'Service'} · {formatDate(j.scheduled_datetime)}{j.address ? ` · ${j.address}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-accent">{j.report_id ? 'Open report' : 'Create'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function InspectionReportsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const allowed = canManageInspectionReports(isOwner, permissions);

  const [rows, setRows] = useState<ReportListRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setRows(await listReports());
      setStatus('ready');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : undefined);
      setStatus('error');
    }
  }, []);

  // Reload whenever we land on the list (also refreshes after edits in the detail view).
  useEffect(() => {
    if (allowed && !id) void load();
  }, [allowed, id, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === 'all' || r.status === filter) &&
        (!needle || [r.title, r.customer_name, r.report_number, r.address ?? ''].some((v) => v.toLowerCase().includes(needle))),
    );
  }, [rows, filter, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const handlePick = async (job: JobOption) => {
    if (job.report_id) {
      setPicker(false);
      navigate(`/dashboard/inspection-reports/${job.report_id}`);
      return;
    }
    setCreating(true);
    try {
      const d = await createReport(job.id);
      setPicker(false);
      if (d.existing) toast('A report already exists for this job — opened it.', 'info');
      navigate(`/dashboard/inspection-reports/${d.report.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the report.', 'error');
    } finally {
      setCreating(false);
    }
  };

  if (authLoading || profileLoading) {
    return (
      <DashboardLayout activeLabel="Inspection Reports">
        <SkeletonCardList count={3} />
      </DashboardLayout>
    );
  }

  if (!allowed) {
    return (
      <DashboardLayout activeLabel="Inspection Reports">
        <EmptyState
          icon={Lock}
          title="You don't have access to inspection reports"
          description="Ask the account owner to give you access to all jobs."
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Inspection Reports">
      <div className="mx-auto max-w-4xl pb-28">
        {id ? (
          <InspectionReportDetail
            key={id}
            reportId={id}
            onBack={() => navigate('/dashboard/inspection-reports')}
            onDeleted={() => navigate('/dashboard/inspection-reports', { replace: true })}
          />
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
                  <ClipboardCheck size={22} aria-hidden="true" /> Inspection reports
                </h1>
                <p className="mt-1 text-sm text-text-secondary">
                  Branded PDF reports built from each job's checklist and photos — shareable with customers, with e-signature.
                </p>
              </div>
              <Button type="button" size="sm" onClick={() => setPicker(true)} disabled={creating}>
                {creating ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
                New report
              </Button>
            </div>

            {status === 'loading' && <SkeletonCardList count={4} />}

            {status === 'error' && <EmptyStateError icon={ClipboardCheck} title="Couldn't load reports" description={errorText} onRetry={load} />}

            {status === 'ready' && rows.length === 0 && (
              <EmptyState
                icon={ClipboardCheck}
                title="No inspection reports yet"
                description="Create one from a completed job — the checklist and photos are pulled in for you."
                action={{ label: 'Create your first report', onClick: () => setPicker(true) }}
              />
            )}

            {status === 'ready' && rows.length > 0 && (
              <>
                <div className="mb-4 space-y-3">
                  <Input aria-label="Search reports" icon={Search} placeholder="Search by title, customer, address or number" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filter by status">
                    {FILTERS.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        role="tab"
                        aria-selected={filter === f.key}
                        onClick={() => setFilter(f.key)}
                        className={`focus-ring shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                          filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {f.label} <span className="text-xs opacity-70">{counts[f.key] ?? 0}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {visible.length === 0 ? (
                  <EmptyState icon={Search} title="No reports match" description="Try a different search or filter." />
                ) : (
                  <ul className="space-y-3">
                    {visible.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => navigate(`/dashboard/inspection-reports/${r.id}`)}
                          className="focus-ring flex w-full flex-col gap-2 rounded-2xl border border-border bg-bg-secondary p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between sm:p-5"
                        >
                          <span className="min-w-0">
                            <span className="block break-words text-sm font-semibold text-text-primary">{r.title}</span>
                            <span className="mt-0.5 block text-xs text-text-secondary">
                              {r.report_number} · {r.customer_name} · {formatDate(r.inspected_at)}
                            </span>
                          </span>
                          <span className="flex flex-wrap items-center gap-2">
                            {r.status !== 'draft' && r.status !== 'voided' && (
                              <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                                <Eye size={13} aria-hidden="true" /> {r.view_count}
                              </span>
                            )}
                            <ResultPill result={r.overall_result} />
                            <StatusPill status={r.status} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </div>

      {picker && <JobPicker onClose={() => !creating && setPicker(false)} onPick={handlePick} />}
    </DashboardLayout>
  );
}
