/**
 * Job detail — /dashboard/jobs/:id
 *
 * One job end to end: status timeline, customer & visit, technician, notes,
 * before/after photos, parts, costs & profit, invoice and a realtime activity
 * feed. Every query is scoped to the ACCOUNT OWNER's id (a team member's own
 * auth id is not the id business data is keyed by), billing data is fetched
 * only for people allowed to see it, and technicians without "view all jobs"
 * can open only jobs assigned to them.
 *
 * Decisions (access, status flow, feed merge, money maths, photo rules) live in
 * src/lib/jobDetail.ts and are unit-tested there; this file wires data,
 * realtime and mutations to the section components.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useRealtimeSubscription } from '@/lib/realtime';
import type { RealtimeStatus } from '@/lib/realtime';
import type { Job } from '@/lib/supabase';
import { createInvoiceFromQuote } from '@/lib/invoices';
import { isQualityGateError, parseQualityGateError } from '@/lib/jobQualityGate';
import { isEvidenceChainError, parseEvidenceChainError } from '@/lib/jobEvidenceChain';
import {
  STATUS_BADGE,
  STATUS_LABELS,
  addJobNote,
  attachJobPhoto,
  buildActivityFeed,
  fetchJob,
  fetchJobCostEntries,
  fetchJobEvents,
  fetchJobInvoices,
  fetchJobRequiredParts,
  fetchJobTechnician,
  fetchJobUsedParts,
  formatWhen,
  resolveJobAccess,
  saveJobNotes,
  updateJobStatusScoped,
} from '@/lib/jobDetail';
import type { JobNotesPatch, JobStatus, JobTechnician } from '@/lib/jobDetail';
import { JobStatusTimeline, JobCustomerCard, JobTechnicianCard, JobNotesCard } from '@/components/jobs/detail/JobOverviewCards';
import { JobPhotosCard, JobPartsCard } from '@/components/jobs/detail/JobWorkSections';
import { JobCostsCard, JobInvoiceCard } from '@/components/jobs/detail/JobMoneySections';
import { JobActivityFeed } from '@/components/jobs/detail/JobActivityFeed';
import { Pill } from '@/components/jobs/detail/JobSection';

// ============================================================
// SMALL HOOKS
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads one section independently. `refresh` re-fetches silently (keeps the
 * current data on screen and ignores a failed refresh); `reload` shows the
 * loading state again. Stale responses from an older key are discarded.
 */
function useSectionData<T>(fetcher: () => Promise<T>, key: string, enabled: boolean, initial: T) {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;
  const initialRef = useRef(initial);
  const requestRef = useRef(0);
  const [state, setState] = useState<{ data: T; loading: boolean; error: boolean; loadedKey: string | null }>({
    data: initial,
    loading: enabled,
    error: false,
    loadedKey: null,
  });

  const run = useCallback(async (silent: boolean) => {
    const request = ++requestRef.current;
    const requestKey = keyRef.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: false }));
    try {
      const data = await fetcherRef.current();
      if (request === requestRef.current) setState({ data, loading: false, error: false, loadedKey: requestKey });
    } catch {
      if (request !== requestRef.current) return;
      setState((s) => (silent ? s : { ...s, loading: false, error: true, loadedKey: requestKey }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // New scope (e.g. another job): never show the previous scope's data while loading.
    setState({ data: initialRef.current, loading: true, error: false, loadedKey: null });
    void run(false);
    return () => {
      requestRef.current += 1;
    };
  }, [key, enabled, run]);

  const reload = useCallback(() => void run(false), [run]);
  const refresh = useCallback(() => void run(true), [run]);
  // `enabled` can flip on a render before the effect starts the request; count that gap as loading too.
  const loading = state.loading || (enabled && state.loadedKey !== key);
  return { data: state.data, error: state.error, loading, reload, refresh };
}

/** Collapses bursts of realtime events into one refetch. */
function useDebounced(fn: () => void, ms: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => fnRef.current(), ms);
  }, [ms]);
}

type Core = { kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; job: Job };

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6 sm:py-8" aria-busy="true" aria-label="Loading job">
      <Skeleton className="h-8 w-64 rounded-lg" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 w-full rounded-2xl lg:col-span-2" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();

  // Business rows are keyed by the OWNER's id — for team members that is not their own id.
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const validId = !!id && UUID_RE.test(id);
  const layoutLabel = isOwner || permissions.can_view_all_jobs ? 'Jobs' : 'My Jobs';

  // ---------- the job itself ----------

  const [core, setCore] = useState<Core>({ kind: 'loading' });
  const coreRequest = useRef(0);

  const loadCore = useCallback(async () => {
    if (!ownerId) return;
    if (!id || !UUID_RE.test(id)) {
      setCore({ kind: 'missing' });
      return;
    }
    const request = ++coreRequest.current;
    setCore({ kind: 'loading' });
    try {
      const job = await fetchJob(id, ownerId);
      if (request === coreRequest.current) setCore(job ? { kind: 'ready', job } : { kind: 'missing' });
    } catch {
      if (request === coreRequest.current) setCore({ kind: 'error' });
    }
  }, [id, ownerId]);

  useEffect(() => {
    void loadCore();
    return () => {
      coreRequest.current += 1;
    };
  }, [loadCore]);

  const job = core.kind === 'ready' ? core.job : null;
  const access = useMemo(
    () =>
      job
        ? resolveJobAccess({
            isOwner,
            permissions: { can_view_all_jobs: permissions.can_view_all_jobs, can_view_billing: permissions.can_view_billing },
            teamMemberId: teamMember?.id ?? null,
            job,
          })
        : null,
    [job, isOwner, permissions.can_view_all_jobs, permissions.can_view_billing, teamMember?.id],
  );

  const enabled = !!job && !!ownerId && !!access?.canView;
  const billing = enabled && !!access?.canSeeBilling;
  const technicianId = job?.assigned_technician_id ?? null;
  const scope = `${id}:${ownerId}`;

  /** Re-reads the job and merges it in (used after our own writes). */
  const syncJob = useCallback(async () => {
    if (!id || !ownerId) return;
    try {
      const fresh = await fetchJob(id, ownerId);
      if (fresh) setCore({ kind: 'ready', job: fresh });
    } catch {
      /* realtime / next load will catch up */
    }
  }, [id, ownerId]);

  // ---------- independently-loaded sections ----------

  const technician = useSectionData<JobTechnician | null>(
    () => fetchJobTechnician(technicianId as string, ownerId as string),
    `${scope}:${technicianId}`,
    enabled && !!technicianId,
    null,
  );
  const required = useSectionData(() => fetchJobRequiredParts(id as string, ownerId as string), scope, enabled, []);
  const used = useSectionData(() => fetchJobUsedParts(id as string, ownerId as string), scope, enabled, []);
  const events = useSectionData(() => fetchJobEvents(id as string), scope, enabled, []);
  const costs = useSectionData(() => fetchJobCostEntries(id as string, ownerId as string), scope, billing, []);
  const invoices = useSectionData(() => fetchJobInvoices(id as string, ownerId as string), scope, billing, []);

  // ---------- realtime ----------

  const refreshRequired = useDebounced(required.refresh, 400);
  const refreshUsed = useDebounced(used.refresh, 400);
  const refreshEvents = useDebounced(events.refresh, 400);
  const refreshCosts = useDebounced(costs.refresh, 400);
  const refreshInvoices = useDebounced(invoices.refresh, 400);

  const liveJob = useRealtimeSubscription<Job>({
    channelName: `job-detail-${id}`,
    table: 'jobs',
    event: '*',
    filter: validId ? `id=eq.${id}` : undefined,
    enabled: enabled && validId,
    onChange: (payload) => {
      if (payload.eventType === 'DELETE') {
        setCore({ kind: 'missing' });
        return;
      }
      const row = payload.new as Job;
      if (row.user_id !== ownerId) return;
      // Merge: Postgres omits unchanged TOASTed columns (e.g. the signature image) from update payloads.
      setCore((prev) => (prev.kind === 'ready' ? { kind: 'ready', job: { ...prev.job, ...row } } : prev));
    },
  });
  const liveEvents = useRealtimeSubscription({
    channelName: `job-events-${id}`,
    table: 'business_activity_events',
    event: 'INSERT',
    filter: validId ? `aggregate_id=eq.${id}` : undefined,
    enabled: enabled && validId,
    onChange: () => refreshEvents(),
  });
  const liveParts = useRealtimeSubscription({
    channelName: `job-parts-${id}`,
    table: 'job_parts_required',
    event: '*',
    filter: validId ? `job_id=eq.${id}` : undefined,
    enabled: enabled && validId,
    onChange: () => refreshRequired(),
  });
  const liveUsage = useRealtimeSubscription({
    channelName: `job-usage-${id}`,
    table: 'inventory_transactions',
    event: 'INSERT',
    filter: validId ? `job_id=eq.${id}` : undefined,
    enabled: enabled && validId,
    onChange: () => refreshUsed(),
  });
  const liveCosts = useRealtimeSubscription({
    channelName: `job-costs-${id}`,
    table: 'job_cost_entries',
    event: '*',
    filter: validId ? `job_id=eq.${id}` : undefined,
    enabled: billing && validId,
    onChange: () => refreshCosts(),
  });
  const liveInvoices = useRealtimeSubscription({
    channelName: `job-invoices-${id}`,
    table: 'invoices',
    event: '*',
    filter: validId ? `job_id=eq.${id}` : undefined,
    enabled: billing && validId,
    onChange: () => refreshInvoices(),
  });

  const channelStatuses: RealtimeStatus[] = [liveJob, liveEvents, liveParts, liveUsage, ...(billing ? [liveCosts, liveInvoices] : [])];
  const live: RealtimeStatus = channelStatuses.includes('reconnecting')
    ? 'reconnecting'
    : channelStatuses.every((s) => s === 'live')
      ? 'live'
      : 'connecting';

  // ---------- mutations ----------

  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'cancelled' | 'no_show' | null>(null);
  const [uploading, setUploading] = useState<'before' | 'after' | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  const changeStatus = async (status: JobStatus) => {
    if (!job || !ownerId || busy) return;
    setBusy(true);
    setBlockers([]);
    try {
      const result = await updateJobStatusScoped(job.id, ownerId, status, (message) =>
        isQualityGateError(message) ? parseQualityGateError(message) : isEvidenceChainError(message) ? parseEvidenceChainError(message) : null,
      );
      if (result.ok) {
        setCore((prev) => (prev.kind === 'ready' ? { kind: 'ready', job: { ...prev.job, job_status: status } } : prev));
        toast(`Job moved to ${STATUS_LABELS[status].toLowerCase()}`, 'success');
        void syncJob();
      } else if (result.blockedBy) {
        setBlockers(result.blockedBy);
        toast(`Can't move to ${STATUS_LABELS[status].toLowerCase()} yet`, 'error');
      } else {
        toast('Could not update the job status', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async (patch: JobNotesPatch): Promise<boolean> => {
    if (!job || !ownerId) return false;
    try {
      await saveJobNotes(job.id, ownerId, patch);
      await syncJob();
      toast('Notes saved', 'success');
      return true;
    } catch {
      toast('Could not save the notes', 'error');
      return false;
    }
  };

  const addNote = async (text: string): Promise<boolean> => {
    if (!job) return false;
    try {
      await addJobNote(job.id, text, teamMember?.member_name || profile?.full_name || profile?.email || null);
      events.refresh();
      toast('Note added', 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error && e.message.length < 90 && !/[{}]/.test(e.message) ? e.message : 'Could not add the note', 'error');
      return false;
    }
  };

  const uploadPhotos = async (slot: 'before' | 'after', files: File[]) => {
    if (!job || !user || !ownerId || uploading) return;
    setUploading(slot);
    let added = 0;
    let firstError: string | null = null;
    let current: Job = job;
    // One at a time: each upload appends to the job's photo list, so the next must start from the fresh row.
    for (const file of files) {
      try {
        await attachJobPhoto({ authUserId: user.id, job: current, slot, file });
        added += 1;
      } catch (e) {
        firstError ??= e instanceof Error && e.message.length < 90 ? e.message : 'A photo could not be uploaded';
        continue;
      }
      try {
        const fresh = await fetchJob(job.id, ownerId);
        if (fresh) {
          current = fresh;
          setCore({ kind: 'ready', job: fresh });
        }
      } catch {
        firstError ??= 'Photos were added, but the page could not refresh. Reload to see them all.';
        break;
      }
    }
    setUploading(null);
    if (added > 0) toast(`${added} photo${added === 1 ? '' : 's'} added`, 'success');
    if (firstError) toast(firstError, 'error');
  };

  const createInvoice = async () => {
    if (!job?.quote_id || creatingInvoice) return;
    setCreatingInvoice(true);
    try {
      await createInvoiceFromQuote(job.quote_id);
      invoices.refresh();
      toast('Invoice created', 'success');
    } catch {
      toast('Could not create the invoice', 'error');
    } finally {
      setCreatingInvoice(false);
    }
  };

  const feed = useMemo(
    () => (job ? buildActivityFeed({ job, invoices: invoices.data, events: events.data }) : []),
    [job, invoices.data, events.data],
  );

  // ---------- render ----------

  const shell = (children: ReactNode) => <DashboardLayout activeLabel={layoutLabel}>{children}</DashboardLayout>;
  const centered = (children: ReactNode) => <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">{children}</div>;

  if (authLoading || profileLoading) return shell(<PageSkeleton />);
  if (!ownerId) {
    return shell(
      centered(
        <EmptyState
          icon={TriangleAlert}
          title="Could not load your account"
          description="Sign in again, or reload the page."
          action={{ label: 'Back to jobs', onClick: () => navigate('/dashboard/jobs') }}
        />,
      ),
    );
  }
  if (core.kind === 'loading') return shell(<PageSkeleton />);
  if (core.kind === 'error') {
    return shell(
      centered(
        <EmptyState
          icon={TriangleAlert}
          title="Could not load this job"
          description="Check your connection and try again."
          action={{ label: 'Try again', onClick: () => void loadCore() }}
        />,
      ),
    );
  }
  if (core.kind === 'missing') {
    return shell(
      centered(
        <EmptyState
          icon={Briefcase}
          title="Job not found"
          description="It may have been deleted, or the link is out of date."
          action={{ label: 'Back to jobs', onClick: () => navigate('/dashboard/jobs') }}
        />,
      ),
    );
  }
  if (!access?.canView) {
    return shell(
      centered(
        <EmptyState
          icon={ShieldAlert}
          title="You don't have access to this job"
          description="Technicians can open jobs assigned to them. Ask an admin if you need to see this one."
          action={{ label: 'Back to jobs', onClick: () => navigate('/dashboard/jobs') }}
        />,
      ),
    );
  }

  const j = core.job;
  const subtitle = [j.service_type, formatWhen(j.scheduled_datetime)].filter((p) => p && p !== '—').join(' · ');

  return shell(
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <Link to="/dashboard/jobs" className="focus-ring mb-2 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary">
          <ArrowLeft size={13} aria-hidden="true" /> All jobs
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold text-text-primary">{j.customer_name}</h1>
            {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill className={STATUS_BADGE[j.job_status]}>{STATUS_LABELS[j.job_status]}</Pill>
            {j.quality_check_passed === true && <Pill className="bg-success-500/10 text-success-500">Quality check passed</Pill>}
            {j.quality_check_passed === false && <Pill className="bg-warning-500/10 text-warning-500">Quality check failed</Pill>}
            <span className="text-xs text-text-secondary" title={j.id}>
              #{j.id.slice(0, 8)}
            </span>
          </div>
        </div>
      </div>

      <JobStatusTimeline
        job={j}
        canEdit={access.canEdit}
        canManage={access.canManage}
        busy={busy}
        blockers={blockers}
        onAdvance={(s) => void changeStatus(s)}
        onTerminate={(s) => setConfirm(s)}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <JobCustomerCard job={j} />
        <JobTechnicianCard job={j} technician={technician.data} loading={technician.loading} error={technician.error} onRetry={technician.reload} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <JobNotesCard job={j} canEdit={access.canEdit} onSave={saveNotes} />
          <JobPhotosCard job={j} canEdit={access.canEdit} uploading={uploading} onUpload={(slot, files) => void uploadPhotos(slot, files)} />
          <JobPartsCard required={required} used={used} />
          {access.canSeeBilling && <JobCostsCard job={j} costs={costs} invoices={invoices} />}
          {access.canSeeBilling && (
            <JobInvoiceCard job={j} invoices={invoices} canEdit={access.canEdit} creating={creatingInvoice} onCreateFromQuote={() => void createInvoice()} />
          )}
        </div>
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-4">
            <JobActivityFeed
              items={feed}
              loading={events.loading}
              error={events.error}
              live={live}
              canEdit={access.canEdit}
              onRetry={events.reload}
              onAddNote={addNote}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'no_show' ? 'Mark this job as a no-show?' : 'Cancel this job?'}
        description={
          confirm === 'no_show'
            ? 'Use this when the customer was not available at the scheduled time. The job leaves the active board.'
            : 'The job leaves the active board and the technician is released. You can still view it here afterwards.'
        }
        confirmLabel={confirm === 'no_show' ? 'Mark no-show' : 'Cancel job'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const target = confirm;
          setConfirm(null);
          if (target) await changeStatus(target);
        }}
      />
    </div>,
  );
}
