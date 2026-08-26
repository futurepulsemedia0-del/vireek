import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Phone, Clock, TrendingUp, TriangleAlert as AlertTriangle, CircleCheck as CheckCircle2, DollarSign, Activity, ArrowRight, LogOut, Calendar, User, Settings, Lightbulb, Circle as XCircle, MapPin, Zap, Bell, Wrench, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase, Call, Job, Lead, AiInsight, Profile } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

// ============================================================
// SHARED UI PRIMITIVES
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Phone;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
        <Icon size={22} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{body}</p>
    </div>
  );
}

// ============================================================
// KPI CARD (primary, large)
// ============================================================

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  accentColor,
  delay,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  sub: string;
  accentColor: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
    >
      <div className="flex items-center justify-between">
        <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${accentColor}`}>
          <Icon size={22} />
        </span>
      </div>
      <p className="mt-5 text-4xl font-bold tracking-tight text-text-primary">{value}</p>
      <p className="mt-1 text-sm font-medium text-text-secondary">{label}</p>
      <p className="mt-0.5 text-xs text-text-secondary/70">{sub}</p>
    </motion.div>
  );
}

function KpiSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <SkeletonBlock className="h-11 w-11" />
      <SkeletonBlock className="mt-5 h-10 w-24" />
      <SkeletonBlock className="mt-2 h-4 w-32" />
      <SkeletonBlock className="mt-1 h-3 w-24" />
    </div>
  );
}

// ============================================================
// SECONDARY METRIC CARD (smaller)
// ============================================================

function MetricCard({
  icon: Icon,
  label,
  value,
  children,
  delay,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  children?: React.ReactNode;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center gap-2.5">
        <Icon size={18} className="text-text-secondary" />
        <span className="text-sm font-medium text-text-secondary">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight text-text-primary">{value}</p>
      {children}
    </motion.div>
  );
}

function MetricSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <SkeletonBlock className="h-5 w-28" />
      <SkeletonBlock className="mt-3 h-8 w-20" />
    </div>
  );
}

// ============================================================
// 14-DAY CALL VOLUME CHART (custom SVG, no chart library)
// ============================================================

function CallVolumeChart({ data }: { data: { date: string; count: number }[] }) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const chartHeight = 160;
  const barWidth = 100 / data.length;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Call Volume — Last 14 Days</h3>
        <span className="text-xs text-text-secondary">
          {data.reduce((sum, d) => sum + d.count, 0)} total calls
        </span>
      </div>
      <div className="mt-6 flex items-end gap-1" style={{ height: chartHeight }}>
        {data.map((d, i) => {
          const heightPercent = (d.count / maxCount) * 100;
          const isToday = i === data.length - 1;
          return (
            <div
              key={d.date}
              className="group relative flex flex-1 flex-col items-center justify-end"
              style={{ height: '100%' }}
            >
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-text-primary px-2 py-1 text-xs font-medium text-bg-primary opacity-0 transition-opacity group-hover:opacity-100">
                {d.count} {d.count === 1 ? 'call' : 'calls'}
              </div>
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: `${heightPercent}%` }}
                transition={{ duration: 0.5, delay: i * 0.03, ease: [0.16, 1, 0.3, 1] }}
                className={`w-full rounded-t-md ${
                  isToday
                    ? 'bg-cta'
                    : d.count > 0
                      ? 'bg-accent'
                      : 'bg-bg-tertiary'
                }`}
                style={{ minHeight: d.count > 0 ? 4 : 2 }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-text-secondary">
          {data[0]?.date && new Date(data[0].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
        <span className="text-xs text-text-secondary">
          {data[data.length - 1]?.date && new Date(data[data.length - 1].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <SkeletonBlock className="h-5 w-48" />
      <div className="mt-6 flex items-end gap-1" style={{ height: 160 }}>
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i} className="flex-1">
            <SkeletonBlock className="h-full w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// NEEDS YOUR ATTENTION SECTION
// ============================================================

interface AttentionItem {
  id: string;
  type: 'job' | 'call' | 'insight';
  priority: 'urgent' | 'warning' | 'info';
  title: string;
  description: string;
  icon: typeof Phone;
}

function NeedsAttention({ items, onInsightClick }: { items: AttentionItem[]; onInsightClick?: () => void }) {
  const priorityConfig = {
    urgent: { color: 'border-l-danger bg-danger/5', iconColor: 'text-danger', label: 'Urgent' },
    warning: { color: 'border-l-warning-500 bg-warning-500/5', iconColor: 'text-warning-500', label: 'Warning' },
    info: { color: 'border-l-accent bg-accent/5', iconColor: 'text-accent', label: 'Info' },
  };

  return (
    <div className="rounded-2xl border-2 border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
          <Bell size={20} />
        </span>
        <div>
          <h3 className="text-base font-bold text-text-primary">Needs Your Attention</h3>
          <p className="text-xs text-text-secondary">
            {items.length === 0 ? 'All clear — nothing needs your attention right now.' : `${items.length} item${items.length !== 1 ? 's' : ''} require action`}
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-dashed border-border bg-bg-tertiary/50 px-4 py-5">
          <CheckCircle2 size={20} className="text-success-500" />
          <p className="text-sm text-text-secondary">Everything is on track. No urgent items.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {items.map((item, i) => {
            const config = priorityConfig[item.priority];
            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => {
                  if (item.type === 'insight' && onInsightClick) onInsightClick();
                }}
                className={`flex items-start gap-3 rounded-xl border-l-4 ${config.color} px-4 py-3.5 ${item.type === 'insight' && onInsightClick ? 'cursor-pointer' : ''}`}
              >
                <item.icon size={20} className={`mt-0.5 shrink-0 ${config.iconColor}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-text-primary">{item.title}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${config.iconColor} bg-transparent`}>
                      {config.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm leading-relaxed text-text-secondary">{item.description}</p>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RECENT ACTIVITY FEED
// ============================================================

interface ActivityItem {
  id: string;
  type: 'call' | 'job' | 'lead';
  title: string;
  description: string;
  timestamp: string;
  icon: typeof Phone;
  statusColor: string;
}

function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <h3 className="text-base font-semibold text-text-primary">Recent Activity</h3>
      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Activity}
            title="No activity yet"
            body="Calls, jobs, and leads will appear here in chronological order as they come in."
          />
        </div>
      ) : (
        <div className="mt-4 space-y-1">
          {items.map((item, i) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-bg-tertiary/50"
            >
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${item.statusColor}`}>
                <item.icon size={18} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{item.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-text-secondary line-clamp-2">{item.description}</p>
              </div>
              <span className="shrink-0 text-xs text-text-secondary">
                {formatTimeAgo(item.timestamp)}
              </span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// HELPERS
// ============================================================

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);
  return mins > 0 ? `${mins}m ago` : 'just now';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return '$0';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ============================================================
// MAIN DASHBOARD
// ============================================================

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, signOut } = useAuth();
  const { toast } = useToast();

  const [calls, setCalls] = useState<Call[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [callsRes, jobsRes, leadsRes, insightsRes, allCallsRes, allJobsRes] = await Promise.all([
        supabase.from('calls').select('*').order('call_datetime', { ascending: false }).limit(20),
        supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(20),
        supabase.from('leads').select('*').order('created_at', { ascending: false }),
        supabase.from('ai_insights').select('*').eq('is_dismissed', false).order('created_at', { ascending: false }),
        supabase.from('calls').select('*').order('call_datetime', { ascending: false }),
        supabase.from('jobs').select('*').order('created_at', { ascending: false }),
      ]);

      if (callsRes.data) setCalls(callsRes.data as Call[]);
      if (jobsRes.data) setJobs(jobsRes.data as Job[]);
      if (leadsRes.data) setLeads(leadsRes.data as Lead[]);
      if (insightsRes.data) setInsights(insightsRes.data as AiInsight[]);
      if (allCallsRes.data) setAllCalls(allCallsRes.data as Call[]);
      if (allJobsRes.data) setAllJobs(allJobsRes.data as Job[]);
    } catch {
      // Data will show as empty states
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
  });

  const handleSignOut = async () => {
    await signOut();
    toast('Signed out successfully.', 'info');
    navigate('/login', { replace: true });
  };

  const handleDismissInsight = async (id: string) => {
    setInsights((prev) => prev.filter((i) => i.id !== id));
    try {
      await supabase.from('ai_insights').update({ is_dismissed: true }).eq('id', id);
      toast('Insight dismissed.', 'info');
    } catch {
      toast('Could not dismiss insight.', 'error');
    }
  };

  // ============================================================
  // COMPUTED METRICS
  // ============================================================

  const metrics = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const callsThisMonth = allCalls.filter((c) => new Date(c.call_datetime) >= monthStart);
    const emergencyCalls = callsThisMonth.filter((c) => c.is_emergency);
    const jobsCompletedThisMonth = allJobs.filter(
      (j) => j.job_status === 'completed' && new Date(j.created_at) >= monthStart
    );
    const revenueThisMonth = allJobs
      .filter((j) => j.invoice_status === 'paid' && new Date(j.created_at) >= monthStart)
      .reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0);

    const minutesUsed = profile?.minutes_used_this_month ?? 0;
    const minutesIncluded = profile?.minutes_included ?? 50;
    const minutesRemaining = Math.max(0, minutesIncluded - minutesUsed);
    const usagePercent = minutesIncluded > 0 ? Math.min(100, (minutesUsed / minutesIncluded) * 100) : 0;

    const sentimentCalls = allCalls.filter((c) => c.sentiment !== null);
    const positiveCount = sentimentCalls.filter((c) => c.sentiment === 'positive').length;
    const avgSentiment = sentimentCalls.length > 0
      ? `${Math.round((positiveCount / sentimentCalls.length) * 100)}% positive`
      : '—';

    const wonLeads = leads.filter((l) => l.stage === 'won').length;
    const conversionRate = leads.length > 0
      ? `${Math.round((wonLeads / leads.length) * 100)}%`
      : '—';

    const missedCalls = allCalls.filter((c) => c.status === 'missed').length;
    const missedCallRate = allCalls.length > 0
      ? `${Math.round((missedCalls / allCalls.length) * 100)}%`
      : '—';

    // 14-day chart data
    const chartData: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - i);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const count = allCalls.filter((c) => {
        const callDate = new Date(c.call_datetime);
        return callDate >= date && callDate < nextDate;
      }).length;
      chartData.push({ date: date.toISOString(), count });
    }

    // Needs Attention items
    const attentionItems: AttentionItem[] = [];

    // Overdue/unassigned jobs
    const overdueJobs = allJobs.filter(
      (j) =>
        (j.job_status === 'scheduled' || j.job_status === 'en_route') &&
        j.scheduled_datetime &&
        new Date(j.scheduled_datetime) < now
    );
    const unassignedJobs = allJobs.filter(
      (j) => (j.job_status === 'scheduled' || j.job_status === 'en_route') && !j.assigned_technician_id
    );

    overdueJobs.forEach((j) => {
      attentionItems.push({
        id: `overdue-${j.id}`,
        type: 'job',
        priority: 'urgent',
        title: `Overdue job: ${j.customer_name}`,
        description: `Scheduled for ${new Date(j.scheduled_datetime!).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} but still ${j.job_status.replace('_', ' ')}.`,
        icon: Calendar,
      });
    });

    unassignedJobs.forEach((j) => {
      if (!overdueJobs.includes(j)) {
        attentionItems.push({
          id: `unassigned-${j.id}`,
          type: 'job',
          priority: 'warning',
          title: `Unassigned job: ${j.customer_name}`,
          description: `${j.service_type || 'Service'} on ${j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'unscheduled'} has no technician assigned.`,
          icon: Wrench,
        });
      }
    });

    // Unresolved emergency calls
    const unresolvedEmergencies = calls.filter(
      (c) => c.is_emergency && c.status !== 'booked' && c.status !== 'spam'
    );
    unresolvedEmergencies.forEach((c) => {
      attentionItems.push({
        id: `emergency-${c.id}`,
        type: 'call',
        priority: 'urgent',
        title: `Emergency call from ${c.caller_name || 'unknown'}`,
        description: `Status: ${c.status.replace(/_/g, ' ')}. ${c.summary?.slice(0, 100) ?? ''}`,
        icon: AlertTriangle,
      });
    });

    // AI insight alerts
    insights.forEach((insight) => {
      attentionItems.push({
        id: `insight-${insight.id}`,
        type: 'insight',
        priority: insight.insight_type === 'alert' ? 'urgent' : insight.insight_type === 'suggestion' ? 'warning' : 'info',
        title: insight.title,
        description: insight.description,
        icon: Lightbulb,
      });
    });

    // Recent activity feed
    const activityItems: ActivityItem[] = [];

    calls.slice(0, 5).forEach((c) => {
      const statusColors: Record<string, string> = {
        new_lead: 'bg-accent/10 text-accent',
        booked: 'bg-success-500/10 text-success-500',
        missed: 'bg-danger/10 text-danger',
        callback_requested: 'bg-warning-500/10 text-warning-500',
        spam: 'bg-bg-tertiary text-text-secondary',
      };
      activityItems.push({
        id: `call-${c.id}`,
        type: 'call',
        title: `Call from ${c.caller_name || 'unknown'}`,
        description: c.summary?.slice(0, 120) ?? 'No summary available',
        timestamp: c.call_datetime,
        icon: Phone,
        statusColor: statusColors[c.status] || statusColors.new_lead,
      });
    });

    jobs.slice(0, 5).forEach((j) => {
      const statusColors: Record<string, string> = {
        scheduled: 'bg-accent/10 text-accent',
        en_route: 'bg-warning-500/10 text-warning-500',
        in_progress: 'bg-warning-500/10 text-warning-500',
        completed: 'bg-success-500/10 text-success-500',
        cancelled: 'bg-danger/10 text-danger',
      };
      activityItems.push({
        id: `job-${j.id}`,
        type: 'job',
        title: `Job: ${j.customer_name}`,
        description: `${j.service_type || 'Service'} · ${j.job_status.replace(/_/g, ' ')}`,
        timestamp: j.created_at,
        icon: Calendar,
        statusColor: statusColors[j.job_status] || statusColors.scheduled,
      });
    });

    leads.slice(0, 5).forEach((l) => {
      const stageColors: Record<string, string> = {
        new: 'bg-accent/10 text-accent',
        contacted: 'bg-warning-500/10 text-warning-500',
        quoted: 'bg-warning-500/10 text-warning-500',
        won: 'bg-success-500/10 text-success-500',
        lost: 'bg-danger/10 text-danger',
      };
      activityItems.push({
        id: `lead-${l.id}`,
        type: 'lead',
        title: `Lead: ${l.name}`,
        description: `${l.service_interested || 'Service'} · ${l.stage}`,
        timestamp: l.created_at,
        icon: User,
        statusColor: stageColors[l.stage] || stageColors.new,
      });
    });

    activityItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return {
      callsThisMonthCount: callsThisMonth.length,
      emergencyCallsCount: emergencyCalls.length,
      jobsCompletedCount: jobsCompletedThisMonth.length,
      revenueThisMonth,
      minutesUsed,
      minutesIncluded,
      minutesRemaining,
      usagePercent,
      avgSentiment,
      conversionRate,
      missedCallRate,
      chartData,
      attentionItems: attentionItems.slice(0, 8),
      activityItems: activityItems.slice(0, 10),
    };
  }, [allCalls, allJobs, calls, jobs, leads, insights, profile]);

  const todayDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const dailyDigest = insights.find((i) => i.insight_type === 'pattern');

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg-primary/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
            <span className="ml-2 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">
              Dashboard
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <button
              type="button"
              onClick={handleSignOut}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
              aria-label="Sign out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Welcome header */}
        <div className="mb-8">
          {profileLoading ? (
            <>
              <SkeletonBlock className="h-8 w-80" />
              <SkeletonBlock className="mt-2 h-5 w-60" />
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                Welcome back, {profile?.company_name || profile?.full_name?.split(' ')[0] || 'there'}
              </h1>
              <p className="mt-1.5 text-sm text-text-secondary">{todayDate}</p>
              {dailyDigest && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent/5 px-4 py-2.5">
                  <Lightbulb size={16} className="shrink-0 text-accent" />
                  <p className="text-sm text-text-primary">{dailyDigest.title}. {dailyDigest.description}</p>
                  <button
                    type="button"
                    onClick={() => handleDismissInsight(dailyDigest.id)}
                    className="focus-ring shrink-0 rounded text-text-secondary transition-colors hover:text-text-primary"
                    aria-label="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* PRIMARY KPI ROW */}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {profileLoading || dataLoading ? (
            <>
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
            </>
          ) : (
            <>
              <KpiCard
                icon={Phone}
                label="Calls This Month"
                value={String(metrics.callsThisMonthCount)}
                sub="Total inbound calls"
                accentColor="bg-accent/10 text-accent"
                delay={0}
              />
              <KpiCard
                icon={AlertTriangle}
                label="Emergency Calls"
                value={String(metrics.emergencyCallsCount)}
                sub={`${metrics.emergencyCallsCount === 1 ? 'Call' : 'Calls'} needing urgent response`}
                accentColor="bg-danger/10 text-danger"
                delay={0.05}
              />
              <KpiCard
                icon={CheckCircle2}
                label="Jobs Completed"
                value={String(metrics.jobsCompletedCount)}
                sub="This month"
                accentColor="bg-success-500/10 text-success-500"
                delay={0.1}
              />
              <KpiCard
                icon={DollarSign}
                label="Revenue This Month"
                value={formatCurrency(metrics.revenueThisMonth)}
                sub="From paid invoices"
                accentColor="bg-cta/10 text-cta"
                delay={0.15}
              />
            </>
          )}
        </div>

        {/* SECONDARY METRICS ROW */}
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {profileLoading || dataLoading ? (
            <>
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
            </>
          ) : (
            <>
              <MetricCard
                icon={Clock}
                label="Minutes Used"
                value={`${metrics.minutesUsed} / ${metrics.minutesIncluded}`}
                delay={0.2}
              >
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${metrics.usagePercent}%` }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    className={`h-full rounded-full ${
                      metrics.usagePercent > 80
                        ? 'bg-cta'
                        : metrics.usagePercent > 50
                          ? 'bg-accent'
                          : 'bg-success-500'
                    }`}
                  />
                </div>
                <p className="mt-1.5 text-xs text-text-secondary">
                  {metrics.minutesRemaining} minutes remaining
                  {metrics.usagePercent > 80 && (
                    <span className="ml-1 text-cta font-medium">· approaching limit</span>
                  )}
                </p>
              </MetricCard>

              <MetricCard
                icon={Activity}
                label="Avg Response Sentiment"
                value={metrics.avgSentiment}
                delay={0.25}
              />

              <MetricCard
                icon={TrendingUp}
                label="Conversion Rate"
                value={metrics.conversionRate}
                delay={0.3}
              >
                <p className="mt-1 text-xs text-text-secondary">
                  {leads.filter((l) => l.stage === 'won').length} won / {leads.length} total leads
                </p>
              </MetricCard>

              <MetricCard
                icon={XCircle}
                label="Missed Call Rate"
                value={metrics.missedCallRate}
                delay={0.35}
              />
            </>
          )}
        </div>

        {/* CHART + NEEDS ATTENTION */}
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {dataLoading ? <ChartSkeleton /> : <CallVolumeChart data={metrics.chartData} />}
          <NeedsAttention items={metrics.attentionItems} onInsightClick={() => navigate('/dashboard/insights')} />
        </div>

        {/* AI INSIGHTS (if any non-digest insights exist) */}
        {!dataLoading && insights.filter((i) => i.id !== dailyDigest?.id).length > 0 && (
          <div className="mt-5">
            <h2 className="text-lg font-semibold text-text-primary">AI Insights</h2>
            <div className="mt-4 grid gap-4">
              {insights
                .filter((i) => i.id !== dailyDigest?.id)
                .map((insight, i) => {
                  const Icon = insight.insight_type === 'pattern' ? TrendingUp : insight.insight_type === 'suggestion' ? Lightbulb : AlertTriangle;
                  const colorClass = insight.insight_type === 'pattern' ? 'bg-accent/10 text-accent' : insight.insight_type === 'suggestion' ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500';
                  return (
                    <motion.div
                      key={insight.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: i * 0.05 }}
                      className="flex items-start gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
                    >
                      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${colorClass}`}>
                        <Icon size={20} />
                      </span>
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold text-text-primary">{insight.title}</h3>
                        <p className="mt-1 text-sm leading-relaxed text-text-secondary">{insight.description}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDismissInsight(insight.id)}
                        className="focus-ring shrink-0 rounded text-text-secondary transition-colors hover:text-text-primary"
                        aria-label="Dismiss insight"
                      >
                        <XCircle size={18} />
                      </button>
                    </motion.div>
                  );
                })}
            </div>
          </div>
        )}

        {/* QUICK ACTIONS */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-text-primary">Quick Actions</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <button
              type="button"
              onClick={() => navigate('/dashboard/analytics')}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 text-left shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <TrendingUp size={20} />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-text-primary">Analytics</p>
                <p className="text-xs text-text-secondary">Deep dive into performance</p>
              </div>
              <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard/calls')}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 text-left shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Phone size={20} />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-text-primary">Call History</p>
                <p className="text-xs text-text-secondary">Review and manage calls</p>
              </div>
              <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard/leads')}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 text-left shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <User size={20} />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-text-primary">Leads</p>
                <p className="text-xs text-text-secondary">Kanban board & pipeline</p>
              </div>
              <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard/jobs')}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 text-left shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Wrench size={20} />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-text-primary">Jobs</p>
                <p className="text-xs text-text-secondary">Work orders & invoicing</p>
              </div>
              <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard/business-profile')}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 text-left shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Settings size={20} />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-text-primary">Business Profile</p>
                <p className="text-xs text-text-secondary">Services, hours & FAQs</p>
              </div>
              <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard/insights')}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 text-left shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Lightbulb size={20} />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-text-primary">Insights</p>
                <p className="text-xs text-text-secondary">AI smart suggestions</p>
              </div>
              <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>

        {/* RECENT ACTIVITY */}
        <div className="mt-8">
          <RecentActivity items={metrics.activityItems} />
        </div>
      </main>
    </div>
  );
}
