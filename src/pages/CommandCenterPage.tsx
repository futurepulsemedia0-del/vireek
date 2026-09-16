import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Phone,
  UserPlus,
  Wrench,
  TriangleAlert as AlertTriangle,
  Clock,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useRealtimeSubscription, type RealtimeStatus } from '@/lib/realtime';
import { supabase, Call, Lead, Job, TeamMember } from '@/lib/supabase';
import { EmptyState } from '@/components/EmptyState';

// ============================================================
// CONFIG — mirrors JobsPage's board stages exactly, for visual consistency
// ============================================================

const BOARD_STAGES: { key: Job['job_status']; label: string; dotColor: string }[] = [
  { key: 'scheduled', label: 'Scheduled', dotColor: 'bg-accent' },
  { key: 'en_route', label: 'En Route', dotColor: 'bg-blue-500' },
  { key: 'in_progress', label: 'In Progress', dotColor: 'bg-warning-500' },
  { key: 'completed', label: 'Completed', dotColor: 'bg-success-500' },
];

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================
// LIVE ACTIVITY FEED
// ============================================================

interface ActivityItem {
  id: string;
  type: 'call' | 'lead' | 'job_created' | 'job_status';
  timestamp: string;
  title: string;
  subtitle?: string;
  emergency?: boolean;
}

function ActivityIcon({ type, emergency }: { type: ActivityItem['type']; emergency?: boolean }) {
  if (emergency) return <AlertTriangle size={15} className="text-danger" />;
  if (type === 'call') return <Phone size={15} className="text-accent" />;
  if (type === 'lead') return <UserPlus size={15} className="text-success-500" />;
  return <Wrench size={15} className="text-warning-500" />;
}

// ============================================================
// STAT CARD
// ============================================================

function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof Phone;
  label: string;
  value: number;
  tone?: 'default' | 'danger' | 'warning';
}) {
  const toneColor = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon size={15} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className={`mt-2 text-2xl font-bold tracking-tight ${toneColor}`}>{value}</p>
    </div>
  );
}

// ============================================================
// MAIN COMMAND CENTER PAGE
// ============================================================

export function CommandCenterPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, isOwner, teamMember } = useAuth();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [calls, setCalls] = useState<Call[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [now, setNow] = useState(new Date());

  const seenIds = useRef<Set<string>>(new Set());

  // Live wall clock — reinforces that this page is genuinely "real-time".
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const techById = useMemo(() => new Map(technicians.map((t) => [t.id, t])), [technicians]);

  const pushActivity = useCallback((item: ActivityItem) => {
    if (seenIds.current.has(item.id)) return;
    seenIds.current.add(item.id);
    setActivity((prev) => [item, ...prev].slice(0, 25));
  }, []);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const todayStartIso = startOfToday().toISOString();
      const todayEndIso = endOfToday().toISOString();

      const [callsRes, jobsRes, techRes] = await Promise.all([
        supabase.from('calls').select('*').gte('call_datetime', todayStartIso).order('call_datetime', { ascending: false }),
        supabase
          .from('jobs')
          .select('*')
          .gte('scheduled_datetime', todayStartIso)
          .lte('scheduled_datetime', todayEndIso)
          .order('scheduled_datetime', { ascending: true }),
        supabase.from('team_members').select('*').eq('role', 'technician'),
      ]);

      if (callsRes.data) setCalls(callsRes.data as Call[]);
      if (jobsRes.data) setJobs(jobsRes.data as Job[]);
      if (techRes.data) setTechnicians(techRes.data as TeamMember[]);

      // Seed the feed with today's most recent items so it isn't empty on load.
      const seeded: ActivityItem[] = [
        ...((callsRes.data ?? []) as Call[]).slice(0, 10).map((c) => ({
          id: `call-${c.id}`,
          type: 'call' as const,
          timestamp: c.call_datetime,
          title: c.caller_name ?? c.caller_phone ?? 'Unknown caller',
          subtitle: c.is_emergency ? 'Emergency call' : c.summary ?? undefined,
          emergency: c.is_emergency,
        })),
        ...((jobsRes.data ?? []) as Job[]).slice(0, 10).map((j) => ({
          id: `job-${j.id}`,
          type: 'job_created' as const,
          timestamp: j.created_at,
          title: j.customer_name,
          subtitle: j.service_type ?? 'Job scheduled',
        })),
      ]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 25);

      seeded.forEach((item) => seenIds.current.add(item.id));
      setActivity(seeded);
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  // ---------------------------------------------------------
  // Realtime subscriptions — new calls, new leads, job changes
  // ---------------------------------------------------------

  const callsLiveStatus = useRealtimeSubscription<Call>({
    channelName: `command-center-calls-${accountOwnerId ?? 'anon'}`,
    table: 'calls',
    event: 'INSERT',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      const row = payload.new as Call;
      setCalls((prev) => [row, ...prev]);
      pushActivity({
        id: `call-${row.id}`,
        type: 'call',
        timestamp: row.call_datetime,
        title: row.caller_name ?? row.caller_phone ?? 'Unknown caller',
        subtitle: row.is_emergency ? 'Emergency call' : row.summary ?? undefined,
        emergency: row.is_emergency,
      });
    },
  });

  const leadsLiveStatus = useRealtimeSubscription<Lead>({
    channelName: `command-center-leads-${accountOwnerId ?? 'anon'}`,
    table: 'leads',
    event: 'INSERT',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      const row = payload.new as Lead;
      pushActivity({
        id: `lead-${row.id}`,
        type: 'lead',
        timestamp: row.created_at,
        title: row.name,
        subtitle: row.service_interested ?? 'New lead',
      });
    },
  });

  const jobsLiveStatus = useRealtimeSubscription<Job>({
    channelName: `command-center-jobs-${accountOwnerId ?? 'anon'}`,
    table: 'jobs',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      const row = payload.new as Job;
      if (!row?.id) return;
      setJobs((prev) => {
        const exists = prev.some((j) => j.id === row.id);
        if (exists) return prev.map((j) => (j.id === row.id ? row : j));
        // Only add to today's board if it's actually scheduled for today.
        const scheduled = row.scheduled_datetime ? new Date(row.scheduled_datetime) : null;
        const isToday = scheduled && scheduled >= startOfToday() && scheduled <= endOfToday();
        return isToday ? [...prev, row] : prev;
      });
      if (payload.eventType === 'UPDATE') {
        pushActivity({
          id: `job-status-${row.id}-${row.job_status}-${Date.now()}`,
          type: 'job_status',
          timestamp: new Date().toISOString(),
          title: row.customer_name,
          subtitle: `Moved to ${BOARD_STAGES.find((s) => s.key === row.job_status)?.label ?? row.job_status}`,
        });
      } else {
        pushActivity({
          id: `job-${row.id}`,
          type: 'job_created',
          timestamp: row.created_at,
          title: row.customer_name,
          subtitle: row.service_type ?? 'Job scheduled',
        });
      }
    },
  });

  const overallStatus: RealtimeStatus =
    callsLiveStatus === 'live' && leadsLiveStatus === 'live' && jobsLiveStatus === 'live'
      ? 'live'
      : callsLiveStatus === 'connecting' && leadsLiveStatus === 'connecting' && jobsLiveStatus === 'connecting'
        ? 'connecting'
        : 'reconnecting';

  // ---------------------------------------------------------
  // Derived stats
  // ---------------------------------------------------------

  const emergencyQueue = useMemo(
    () =>
      calls
        .filter((c) => c.is_emergency && !c.escalated_at)
        .sort((a, b) => new Date(b.call_datetime).getTime() - new Date(a.call_datetime).getTime()),
    [calls]
  );

  const jobsByStage = useMemo(() => {
    const map: Record<Job['job_status'], Job[]> = {
      scheduled: [],
      en_route: [],
      in_progress: [],
      completed: [],
      cancelled: [],
    };
    jobs.forEach((j) => {
      if (map[j.job_status]) map[j.job_status].push(j);
    });
    return map;
  }, [jobs]);

  const inProgressCount = jobsByStage.in_progress.length + jobsByStage.en_route.length;
  const remainingToday = jobsByStage.scheduled.length;

  return (
    <DashboardLayout activeLabel="Command Center">
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Command Center</h1>
            <LiveIndicator status={overallStatus} />
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} ·{' '}
            {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
          </p>
        </div>
      </div>

      {/* Emergency queue — only shown when something actually needs attention */}
      {emergencyQueue.length > 0 && (
        <div className="mb-5 space-y-2.5">
          {emergencyQueue.map((call) => (
            <motion.div
              key={call.id}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4"
            >
              <AlertTriangle size={18} className="shrink-0 text-danger" />
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">
                  Emergency call from {call.caller_name ?? call.caller_phone ?? 'unknown caller'}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">{timeAgo(call.call_datetime)} · not yet acknowledged</p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/dashboard/calls')}
                className="focus-ring flex shrink-0 items-center gap-1 rounded-lg bg-danger/15 px-3 py-1.5 text-xs font-semibold text-danger transition-opacity hover:opacity-80"
              >
                Respond <ArrowRight size={13} />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {/* Stat strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Phone} label="Calls today" value={calls.length} />
        <StatCard
          icon={AlertTriangle}
          label="Needs response"
          value={emergencyQueue.length}
          tone={emergencyQueue.length > 0 ? 'danger' : 'default'}
        />
        <StatCard icon={Wrench} label="Jobs in progress" value={inProgressCount} tone={inProgressCount > 0 ? 'warning' : 'default'} />
        <StatCard icon={Clock} label="Remaining today" value={remainingToday} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Today's job board (cancelled omitted — this is a live ops view, not the full pipeline) */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark lg:col-span-2">
          <h3 className="text-sm font-semibold text-text-primary">Today's jobs</h3>
          {dataLoading ? (
            <div className="mt-5 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-bg-tertiary" />
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <div className="mt-5">
              <EmptyState
                icon={Wrench}
                title="No jobs scheduled today"
                description="Jobs scheduled for today will appear here live as they're created or updated."
              />
            </div>
          ) : (
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {BOARD_STAGES.map((stage) => (
                <div key={stage.key}>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                    <span className={`h-1.5 w-1.5 rounded-full ${stage.dotColor}`} />
                    {stage.label}
                    <span className="text-text-secondary/60">({jobsByStage[stage.key].length})</span>
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence>
                      {jobsByStage[stage.key].map((job) => {
                        const tech = job.assigned_technician_id ? techById.get(job.assigned_technician_id) : null;
                        return (
                          <motion.button
                            key={job.id}
                            type="button"
                            layout
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            onClick={() => navigate('/dashboard/jobs')}
                            className="focus-ring block w-full rounded-xl border border-border bg-bg-primary p-3 text-left transition-colors hover:border-accent/40"
                          >
                            <p className="truncate text-sm font-medium text-text-primary">{job.customer_name}</p>
                            <p className="mt-0.5 truncate text-xs text-text-secondary">{job.service_type ?? 'Service'}</p>
                            <div className="mt-1.5 flex items-center justify-between text-xs text-text-secondary/80">
                              <span>{formatTime(job.scheduled_datetime)}</span>
                              {tech && <span className="truncate">{tech.member_name ?? tech.member_email}</span>}
                            </div>
                          </motion.button>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Live activity feed */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
          <h3 className="text-sm font-semibold text-text-primary">Live activity</h3>
          <div className="mt-5 max-h-[520px] space-y-1 overflow-y-auto">
            {activity.length === 0 ? (
              <p className="text-sm text-text-secondary">
                Nothing yet today — new calls, leads, and job updates will show up here instantly.
              </p>
            ) : (
              <AnimatePresence initial={false}>
                {activity.map((item) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-start gap-2.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-bg-tertiary/60"
                  >
                    <span className="mt-0.5 shrink-0">
                      <ActivityIcon type={item.type} emergency={item.emergency} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{item.title}</p>
                      {item.subtitle && <p className="truncate text-xs text-text-secondary">{item.subtitle}</p>}
                    </div>
                    <span className="shrink-0 text-xs text-text-secondary/60">{timeAgo(item.timestamp)}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
