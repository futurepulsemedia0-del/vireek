import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ChevronRight, Clock, CloudOff, MapPin, MessageSquare, MoreHorizontal,
  Navigation, Share2, Truck, UserRound, Wallet,
} from 'lucide-react';
import { fetchTodayJobs, formatTime, STATUS_LABELS, type TechnicianJob } from '@/lib/technicianOS';
import { fetchUnreadTotal } from '@/lib/jobMessages';
import { useRealtimeSubscription } from '@/lib/realtime';
import { syncAppBadge } from '@/lib/native/badge';
import { navigateToAddress, shareContent } from '@/lib/native/nativeActions';
import { useLongPress } from '@/hooks/useLongPress';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { PullToRefresh } from '@/components/mobile/PullToRefresh';
import { SwipeActionRow, type SwipeAction } from '@/components/mobile/SwipeActionRow';
import { ReplayTourMenu } from '@/components/tour/ReplayTourMenu';
import { ContextualTip } from '@/components/tour/ContextualTip';

const STATUS_DOT: Record<string, string> = {
  scheduled: 'bg-accent',
  en_route: 'bg-blue-500',
  in_progress: 'bg-warning-500',
  completed: 'bg-success-500',
};

function NavPill({ to, icon, label, badge = 0 }: { to: string; icon: ReactNode; label: string; badge?: number }) {
  return (
    <Link
      to={to}
      aria-label={badge > 0 ? `${label}, ${badge} unread` : undefined}
      className="focus-ring flex min-h-[44px] flex-shrink-0 items-center gap-2 rounded-full border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary active:bg-bg-tertiary"
    >
      {icon}
      {label}
      {badge > 0 && (
        <span aria-hidden="true" className="min-w-[1.25rem] rounded-full bg-accent px-1.5 text-center text-xs font-semibold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}

function JobRow({ job, onOpen, onMore }: { job: TechnicianJob; onOpen: (id: string) => void; onMore: (job: TechnicianJob) => void }) {
  const { handlers, consumeLongPress } = useLongPress(() => onMore(job));
  const navigateAction = useMemo<SwipeAction | undefined>(
    () =>
      job.address
        ? {
            label: 'Navigate',
            a11yLabel: `Navigate to ${job.customer_name}`,
            icon: <Navigation className="h-4 w-4" aria-hidden="true" />,
            className: 'bg-accent text-white',
            onCommit: () => {
              navigateToAddress(job.address);
            },
          }
        : undefined,
    [job.address, job.customer_name],
  );

  return (
    <SwipeActionRow left={navigateAction}>
      <div className="flex items-stretch rounded-xl border border-border bg-bg-secondary">
        <button
          type="button"
          {...handlers}
          onClick={() => {
            if (consumeLongPress()) return;
            onOpen(job.id);
          }}
          className="flex min-h-[48px] min-w-0 flex-1 select-none items-center gap-3 rounded-l-xl p-4 text-left [-webkit-touch-callout:none] active:bg-bg-tertiary motion-safe:active:scale-[0.99]"
        >
          <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${STATUS_DOT[job.job_status] ?? 'bg-border'}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <span className="font-medium text-text-primary">{formatTime(job.scheduled_datetime)}</span>
              {job.safety_flag && <AlertTriangle className="h-4 w-4 text-danger" aria-label="Safety flag" />}
            </div>
            <p className="truncate text-sm text-text-primary">{job.customer_name}</p>
            <p className="truncate text-xs text-text-secondary">{job.service_type || '—'}</p>
            {job.address && (
              <p className="mt-1 flex items-center gap-1 truncate text-xs text-text-secondary">
                <MapPin className="h-3 w-3 flex-shrink-0" aria-hidden="true" /> {job.address}
              </p>
            )}
            <span className="mt-1 inline-block text-xs font-medium text-accent">{STATUS_LABELS[job.job_status]}</span>
          </div>
          <ChevronRight className="h-5 w-5 flex-shrink-0 text-text-secondary" aria-hidden="true" />
        </button>
        {/* Visible twin of the long-press menu: touch, switch-control and screen-reader users all get it. */}
        <button
          type="button"
          aria-label={`More actions for ${job.customer_name}`}
          onClick={() => onMore(job)}
          className="flex w-12 flex-shrink-0 items-center justify-center rounded-r-xl text-text-secondary active:bg-bg-tertiary"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </SwipeActionRow>
  );
}

const SHEET_BUTTON =
  'flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 text-left text-base text-text-primary active:bg-bg-tertiary disabled:opacity-40';

export function TechnicianTodayPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<TechnicianJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [unread, setUnread] = useState(0);
  const [sheetJob, setSheetJob] = useState<TechnicianJob | null>(null);

  const refreshUnread = useCallback(() => {
    fetchUnreadTotal()
      .then((n) => {
        setUnread(n);
        void syncAppBadge(n);
      })
      .catch(() => undefined);
  }, []);
  useEffect(refreshUnread, [refreshUnread]);
  useRealtimeSubscription({ channelName: 'tech-today-unread', table: 'job_messages', event: 'INSERT', onChange: refreshUnread });

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await fetchTodayJobs());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const refreshAll = useCallback(async () => {
    refreshUnread();
    await loadJobs();
  }, [loadJobs, refreshUnread]);

  const openJob = useCallback((id: string) => navigate(`/tech/job/${id}`), [navigate]);

  return (
    <div className="min-h-screen bg-bg-primary">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 pt-3 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-2 md:max-w-3xl">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-text-primary">Today</h1>
          <ReplayTourMenu align="end" />
        </div>
        <nav aria-label="Technician shortcuts" className="mx-auto mt-2 flex max-w-lg gap-2 overflow-x-auto pb-3 md:max-w-3xl">
          <NavPill to="/tech/messages" icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />} label="Messages" badge={unread} />
          <ContextualTip id="tech.timesheet">
            <NavPill to="/tech/timesheet" icon={<Clock className="h-4 w-4" aria-hidden="true" />} label="Timesheet" />
          </ContextualTip>
          <NavPill to="/tech/pay" icon={<Wallet className="h-4 w-4" aria-hidden="true" />} label="Pay" />
          <NavPill to="/tech/truck-stock" icon={<Truck className="h-4 w-4" aria-hidden="true" />} label="Truck" />
          <NavPill to="/tech/profile" icon={<UserRound className="h-4 w-4" aria-hidden="true" />} label="Profile" />
        </nav>
      </header>

      <PullToRefresh onRefresh={refreshAll}>
        <main className="mx-auto max-w-lg px-4 py-4 md:max-w-3xl">
          {failed && (
            <div role="alert" className="mb-3 flex items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
              <CloudOff className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="flex-1">{jobs.length > 0 ? "Couldn't refresh. Showing the jobs loaded earlier." : "Couldn't load today's jobs."}</span>
              <button type="button" onClick={() => void loadJobs()} className="focus-ring min-h-[44px] rounded-lg px-3 font-medium text-accent">
                Retry
              </button>
            </div>
          )}

          {loading && (
            <div role="status" aria-label="Loading jobs" className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-28 rounded-xl border border-border bg-bg-secondary motion-safe:animate-pulse" />
              ))}
            </div>
          )}

          {!loading && !failed && jobs.length === 0 && (
            <p className="py-10 text-center text-text-secondary">No jobs scheduled for today.</p>
          )}

          <ul className="grid gap-3 md:grid-cols-2">
            {jobs.map((job) => (
              <li key={job.id}>
                <JobRow job={job} onOpen={openJob} onMore={setSheetJob} />
              </li>
            ))}
          </ul>
        </main>
      </PullToRefresh>

      <BottomSheet open={sheetJob !== null} onClose={() => setSheetJob(null)} title={sheetJob?.customer_name ?? 'Job'} snapPoints={[0.4]}>
        {sheetJob && (
          <div className="space-y-1">
            <p className="mb-2 text-sm text-text-secondary">
              {formatTime(sheetJob.scheduled_datetime)} · {sheetJob.service_type || '—'}
            </p>
            <button
              type="button"
              className={SHEET_BUTTON}
              onClick={() => {
                const id = sheetJob.id;
                setSheetJob(null);
                openJob(id);
              }}
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" /> Open job
            </button>
            <button
              type="button"
              className={SHEET_BUTTON}
              disabled={!sheetJob.address}
              onClick={() => {
                navigateToAddress(sheetJob.address);
                setSheetJob(null);
              }}
            >
              <Navigation className="h-5 w-5" aria-hidden="true" /> Navigate
            </button>
            <button
              type="button"
              className={SHEET_BUTTON}
              onClick={() => {
                const text = [formatTime(sheetJob.scheduled_datetime), sheetJob.customer_name, sheetJob.address].filter(Boolean).join(' · ');
                void shareContent({ title: `Job: ${sheetJob.customer_name}`, text }).finally(() => setSheetJob(null));
              }}
            >
              <Share2 className="h-5 w-5" aria-hidden="true" /> Share job
            </button>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
