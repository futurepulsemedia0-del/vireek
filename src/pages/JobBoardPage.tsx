import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, Lock, Plus, TriangleAlert as AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { PostJobForm } from '@/components/jobboard/PostJobForm';
import { JobBoardPostCard } from '@/components/jobboard/JobBoardPostCard';
import { JobBoardRulesPanel } from '@/components/jobboard/JobBoardRulesPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { jobBoardApi, type PostableJob } from '@/lib/jobBoardApi';
import {
  DEFAULT_SETTINGS,
  describeJobBoardError,
  needsAttention,
  sortBids,
  type BoardTab,
  type FairnessRow,
  type JobBoardBid,
  type JobBoardPost,
  type JobBoardRecipient,
  type JobBoardSettings,
  type JobBoardSummary,
  type JobBoardVendor,
} from '@/lib/jobBoard';

const isTab = (v: string | null): v is BoardTab => v === 'board' || v === 'history' || v === 'rules';
const WEEK_MS = 7 * 24 * 3_600_000;

export function JobBoardPage() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: BoardTab = isTab(tabParam) ? tabParam : 'board';
  const setTab = (t: BoardTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next, { replace: true });
  };

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [posts, setPosts] = useState<JobBoardPost[]>([]);
  const [recipients, setRecipients] = useState<JobBoardRecipient[]>([]);
  const [bids, setBids] = useState<JobBoardBid[]>([]);
  const [summary, setSummary] = useState<JobBoardSummary | null>(null);

  const [jobs, setJobs] = useState<PostableJob[]>([]);
  const [areas, setAreas] = useState<Array<{ id: string; name: string }>>([]);
  const [technicians, setTechnicians] = useState<Array<{ id: string; name: string }>>([]);
  const [settings, setSettings] = useState<JobBoardSettings>(DEFAULT_SETTINGS);
  const [vendors, setVendors] = useState<JobBoardVendor[]>([]);
  const [fairness, setFairness] = useState<FairnessRow[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<JobBoardPost | null>(null);
  const refreshTimer = useRef<number>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadSupport = useCallback(async () => {
    const [j, a, t, s, v, f] = await Promise.all([
      jobBoardApi.listPostableJobs(),
      jobBoardApi.listAreas(),
      jobBoardApi.listTechnicians(),
      jobBoardApi.settings(),
      jobBoardApi.vendors(),
      jobBoardApi.fairness(),
    ]);
    if (!mounted.current) return;
    setJobs(j);
    setAreas(a);
    setTechnicians(t);
    setSettings({ ...DEFAULT_SETTINGS, ...s });
    setVendors(v);
    setFairness(f);
  }, []);

  const refresh = useCallback(async () => {
    try {
      await jobBoardApi.expire().catch(() => 0); // best-effort sweep; failures must not hide the board
      const [p, sum] = await Promise.all([jobBoardApi.listPosts(), jobBoardApi.summary()]);
      const ids = p.map((x) => x.id);
      const [r, b] = await Promise.all([jobBoardApi.listRecipients(ids), jobBoardApi.listBids(ids)]);
      if (!mounted.current) return;
      setPosts(p);
      setRecipients(r);
      setBids(b);
      setSummary(sum);
      setLoadFailed(false);
      setForbidden(false);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof Error && e.message.includes('FORBIDDEN')) setForbidden(true);
      else setLoadFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadSupport().catch(() => undefined);
  }, [refresh, loadSupport]);

  // Countdowns stay fresh; a periodic re-sync covers rows realtime cannot signal (expiry has no row event).
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    const sync = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 60_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(sync);
      window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 400);
  }, [refresh]);

  const liveStatus = useRealtimeSubscription({
    channelName: 'job-board-posts',
    table: 'job_board_posts',
    event: '*',
    onChange: scheduleRefresh,
    enabled: !forbidden,
  });
  useRealtimeSubscription({
    channelName: 'job-board-bids',
    table: 'job_board_bids',
    event: '*',
    onChange: scheduleRefresh,
    enabled: !forbidden,
  });

  const run = useCallback(
    async (id: string, fn: () => Promise<unknown>, success: string): Promise<boolean> => {
      setBusyId(id);
      let ok = false;
      try {
        await fn();
        toast(success, 'success');
        ok = true;
      } catch (e) {
        toast(describeJobBoardError(e), 'error');
      } finally {
        await refresh(); // also clears stale state (e.g. someone else got there first)
        void loadSupport().catch(() => undefined);
        if (mounted.current) setBusyId(null);
      }
      return ok;
    },
    [refresh, loadSupport, toast],
  );

  const recipientsByPost = useMemo(() => groupBy(recipients, (r) => r.post_id), [recipients]);
  const bidsByPost = useMemo(() => groupBy(bids, (b) => b.post_id), [bids]);

  const { board, history } = useMemo(() => {
    const activeBidCount = (id: string) => sortBids(bidsByPost[id] ?? []).length;
    const isBoard = (p: JobBoardPost) =>
      p.status === 'open' ||
      p.status === 'escalated' ||
      (p.status === 'expired' && now - new Date(p.updated_at).getTime() < WEEK_MS);
    const boardRows = posts.filter(isBoard).sort((a, b) => {
      const aa = needsAttention(a, activeBidCount(a.id)) ? 0 : 1;
      const bb = needsAttention(b, activeBidCount(b.id)) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
      return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
    });
    return { board: boardRows, history: posts.filter((p) => !isBoard(p)) };
  }, [posts, bidsByPost, now]);

  const initialJobId = searchParams.get('job');
  useEffect(() => {
    if (initialJobId) setShowForm(true);
  }, [initialJobId]);

  const list = tab === 'history' ? history : board;
  const stats: Array<{ label: string; value: string }> = summary
    ? [
        { label: 'Open', value: String(summary.open_posts) },
        { label: 'Awaiting award', value: String(summary.awaiting_award) },
        { label: 'With network', value: String(summary.escalated) },
        { label: 'Awarded (7d)', value: String(summary.awarded_7d) },
        { label: 'Avg time to fill', value: summary.avg_minutes_to_award === null ? '—' : `${summary.avg_minutes_to_award}m` },
      ]
    : [];

  const tabs: Array<{ id: BoardTab; label: string; count?: number }> = [
    { id: 'board', label: 'Live board', count: board.length },
    { id: 'history', label: 'History', count: history.length },
    { id: 'rules', label: 'Rules & subcontractors' },
  ];

  return (
    <DashboardLayout activeLabel="Open Job Board">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ClipboardList size={20} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl font-semibold text-text-primary">Open Job Board</h1>
                {!forbidden && <LiveIndicator status={liveStatus} />}
              </div>
              <p className="text-sm text-text-secondary">
                Broadcast unassigned and overflow jobs to qualified technicians and approved subcontractors — fairly.
              </p>
            </div>
          </div>
          {!forbidden && !showForm && !loading && !loadFailed && (
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus size={16} />
              Post a job
            </Button>
          )}
        </header>

        {loading ? (
          <SkeletonCardList count={3} />
        ) : forbidden ? (
          <EmptyState
            icon={Lock}
            title="Only dispatchers can manage the job board"
            description="Owners, admins and team managers can post and award shifts. Technicians claim shifts from the technician app."
          />
        ) : loadFailed ? (
          <EmptyStateError
            icon={AlertTriangle}
            title="Couldn’t load the job board"
            description="Check your connection and try again. If this keeps happening, the Open Job Board migration may not be applied yet."
            onRetry={() => {
              setLoading(true);
              void refresh();
            }}
          />
        ) : (
          <>
            {stats.length > 0 && (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {stats.map((s) => (
                  <div key={s.label} className="rounded-xl border border-border bg-bg-secondary px-3 py-2.5">
                    <dt className="text-xs text-text-secondary">{s.label}</dt>
                    <dd className="text-lg font-semibold text-text-primary">{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {showForm && (
              <PostJobForm
                key={initialJobId ?? 'blank'}
                jobs={jobs}
                areas={areas}
                initialJobId={initialJobId}
                defaultExpiryMinutes={settings.default_expiry_minutes}
                allowSubcontractors={settings.allow_subcontractors}
                onCancel={() => setShowForm(false)}
                onPosted={() => {
                  setShowForm(false);
                  setTab('board');
                  void refresh();
                  void loadSupport().catch(() => undefined);
                }}
              />
            )}

            <div role="tablist" aria-label="Job board views" className="flex flex-wrap gap-2">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`focus-ring rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    tab === t.id ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t.label}
                  {t.count !== undefined && (
                    <span className={`ml-2 text-xs ${tab === t.id ? 'text-white/80' : 'text-text-secondary'}`}>{t.count}</span>
                  )}
                </button>
              ))}
            </div>

            {tab === 'rules' ? (
              <JobBoardRulesPanel
                key={JSON.stringify(settings)}
                settings={settings}
                vendors={vendors}
                areas={areas}
                fairness={fairness}
                onSaved={async () => {
                  await loadSupport().catch(() => undefined);
                }}
              />
            ) : list.length === 0 ? (
              tab === 'board' ? (
                <EmptyState
                  icon={ClipboardList}
                  title="Nothing on the board"
                  description="Post an unassigned or overflow job and Vireek offers it to the qualified technicians and subcontractors — with a fair rotation."
                  action={{ label: 'Post a job', onClick: () => setShowForm(true) }}
                />
              ) : (
                <EmptyState
                  icon={ClipboardList}
                  title="No history yet"
                  description="Awarded, cancelled and older expired posts appear here."
                />
              )
            ) : (
              <div className="space-y-3">
                {list.map((p) => (
                  <JobBoardPostCard
                    key={p.id}
                    post={p}
                    recipients={recipientsByPost[p.id] ?? []}
                    bids={bidsByPost[p.id] ?? []}
                    technicians={technicians}
                    vendors={vendors}
                    company={profile?.company_name?.trim() || 'Our team'}
                    now={now}
                    busy={busyId === p.id}
                    run={run}
                    onCancel={() => setCancelTarget(p)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!cancelTarget}
        title="Cancel this post?"
        description="It is removed from the board for everyone. Pending requests and bids are withdrawn, and a linked network handoff is cancelled if nobody has accepted it."
        confirmLabel="Cancel post"
        onConfirm={async () => {
          const t = cancelTarget;
          setCancelTarget(null);
          if (t) await run(t.id, () => jobBoardApi.cancel(t.id), 'Post cancelled');
        }}
        onCancel={() => setCancelTarget(null)}
      />
    </DashboardLayout>
  );
}

function groupBy<T>(rows: T[], key: (r: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[key(r)] ??= []).push(r);
  return out;
}
