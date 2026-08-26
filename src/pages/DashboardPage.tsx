import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Phone, Clock, TrendingUp, Settings, LogOut, ArrowRight, ArrowLeft, Calendar, User, CircleAlert as AlertCircle, Lightbulb, CircleCheck as CheckCircle2, Circle as XCircle, MapPin, DollarSign } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase, Call, Job, Lead, AiInsight } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

function StatSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-bg-tertiary" />
        <div className="h-4 w-24 animate-pulse rounded bg-bg-tertiary" />
      </div>
      <div className="mt-5 h-8 w-20 animate-pulse rounded bg-bg-tertiary" />
      <div className="mt-2 h-3 w-32 animate-pulse rounded bg-bg-tertiary" />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Icon size={20} />
        </span>
        <span className="text-sm font-medium text-text-secondary">{label}</span>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-tight text-text-primary">{value}</p>
      <p className="mt-1 text-sm text-text-secondary">{sub}</p>
    </motion.div>
  );
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
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
        <Icon size={24} />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-text-primary">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">{body}</p>
    </div>
  );
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  new_lead: { label: 'New Lead', color: 'bg-accent/10 text-accent', icon: AlertCircle },
  booked: { label: 'Booked', color: 'bg-success-500/10 text-success-500', icon: CheckCircle2 },
  missed: { label: 'Missed', color: 'bg-danger/10 text-danger', icon: XCircle },
  callback_requested: { label: 'Callback Requested', color: 'bg-warning-500/10 text-warning-500', icon: Phone },
  spam: { label: 'Spam', color: 'bg-bg-tertiary text-text-secondary', icon: XCircle },
};

const jobStatusConfig: Record<string, { label: string; color: string }> = {
  scheduled: { label: 'Scheduled', color: 'bg-accent/10 text-accent' },
  en_route: { label: 'En Route', color: 'bg-warning-500/10 text-warning-500' },
  in_progress: { label: 'In Progress', color: 'bg-warning-500/10 text-warning-500' },
  completed: { label: 'Completed', color: 'bg-success-500/10 text-success-500' },
  cancelled: { label: 'Cancelled', color: 'bg-danger/10 text-danger' },
};

const insightIconMap: Record<string, typeof Lightbulb> = {
  pattern: TrendingUp,
  suggestion: Lightbulb,
  alert: AlertCircle,
};

const insightColorMap: Record<string, string> = {
  pattern: 'bg-accent/10 text-accent',
  suggestion: 'bg-success-500/10 text-success-500',
  alert: 'bg-warning-500/10 text-warning-500',
};

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

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, signOut } = useAuth();
  const { toast } = useToast();

  const [calls, setCalls] = useState<Call[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [callsRes, jobsRes, leadsRes, insightsRes] = await Promise.all([
        supabase.from('calls').select('*').order('call_datetime', { ascending: false }).limit(5),
        supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(4),
        supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(5),
        supabase.from('ai_insights').select('*').eq('is_dismissed', false).order('created_at', { ascending: false }),
      ]);

      if (callsRes.data) setCalls(callsRes.data as Call[]);
      if (jobsRes.data) setJobs(jobsRes.data as Job[]);
      if (leadsRes.data) setLeads(leadsRes.data as Lead[]);
      if (insightsRes.data) setInsights(insightsRes.data as AiInsight[]);
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

  const minutesUsed = profile?.minutes_used_this_month ?? 0;
  const minutesIncluded = profile?.minutes_included ?? 50;
  const minutesRemaining = Math.max(0, minutesIncluded - minutesUsed);
  const usagePercent = minutesIncluded > 0 ? Math.min(100, (minutesUsed / minutesIncluded) * 100) : 0;

  const newLeadsCount = leads.filter((l) => l.stage === 'new').length;
  const activeJobsCount = jobs.filter((j) => j.job_status === 'scheduled' || j.job_status === 'in_progress').length;
  const totalCalls = calls.length;

  return (
    <div className="min-h-screen bg-bg-primary">
      <header className="sticky top-0 z-40 border-b border-border bg-bg-primary/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
                <Phone size={16} strokeWidth={2.5} />
              </span>
              <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
              <span className="ml-2 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">
                Dashboard
              </span>
            </div>
            <Link to="/" className="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary">
              <ArrowLeft size={16} />
              Back
            </Link>
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

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
            {profileLoading
              ? 'Loading…'
              : profile?.full_name
                ? `Welcome back, ${profile.full_name.split(' ')[0]}`
                : 'Welcome to Vireek'}
          </h1>
          <p className="mt-1.5 text-sm text-text-secondary">
            {profile?.company_name
              ? `${profile.company_name} · ${profile.plan === 'professional' ? 'Professional' : 'Starter'} plan`
              : 'Your AI receptionist dashboard'}
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {profileLoading || dataLoading ? (
            <>
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </>
          ) : (
            <>
              <StatCard
                icon={Clock}
                label="Minutes Used This Month"
                value={`${minutesUsed} / ${minutesIncluded}`}
                sub={`${minutesRemaining} minutes remaining`}
              />
              <StatCard
                icon={Phone}
                label="Recent Calls"
                value={String(totalCalls)}
                sub={`${newLeadsCount} new lead${newLeadsCount !== 1 ? 's' : ''} from recent calls`}
              />
              <StatCard
                icon={TrendingUp}
                label="Plan"
                value={profile?.plan === 'professional' ? 'Pro' : 'Starter'}
                sub={profile?.plan === 'professional' ? '$297/month · 1,500 min' : 'Free trial · 50 min'}
              />
            </>
          )}
        </div>

        {/* Usage bar */}
        {!profileLoading && !dataLoading && (
          <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">Monthly Usage</h3>
              <span className="text-sm text-text-secondary">{usagePercent.toFixed(0)}%</span>
            </div>
            <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${usagePercent}%` }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className={`h-full rounded-full ${
                  usagePercent > 80 ? 'bg-cta' : 'bg-accent'
                }`}
              />
            </div>
          </div>
        )}

        {/* AI Insights */}
        {!dataLoading && insights.length > 0 && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-text-primary">AI Insights</h2>
            <div className="mt-4 grid gap-4">
              {insights.map((insight) => {
                const Icon = insightIconMap[insight.insight_type] || Lightbulb;
                return (
                  <motion.div
                    key={insight.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-start gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
                  >
                    <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${insightColorMap[insight.insight_type]}`}>
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

        {/* Quick actions */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-text-primary">Quick Actions</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Link to="/dashboard/settings">
              <div className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Settings size={20} />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-primary">Account Settings</p>
                  <p className="text-xs text-text-secondary">Manage your profile and plan</p>
                </div>
                <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
            <Link to="/dashboard/calls">
              <div className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Calendar size={20} />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-primary">Call History</p>
                  <p className="text-xs text-text-secondary">Review calls Sarah has handled</p>
                </div>
                <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
            <Link to="/dashboard/profile">
              <div className="group flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover dark:shadow-card-dark">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <User size={20} />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-primary">Business Profile</p>
                  <p className="text-xs text-text-secondary">Tell Sarah about your business</p>
                </div>
                <ArrowRight size={18} className="text-text-secondary transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          </div>
        </div>

        {/* Recent calls */}
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-text-primary">Recent Calls</h2>
            {calls.length > 0 && (
              <Link to="/dashboard/calls" className="text-sm font-medium text-accent hover:underline">
                View all
              </Link>
            )}
          </div>
          <div className="mt-4">
            {dataLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 animate-pulse rounded-xl bg-bg-tertiary" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-32 animate-pulse rounded bg-bg-tertiary" />
                        <div className="h-3 w-48 animate-pulse rounded bg-bg-tertiary" />
                      </div>
                      <div className="h-6 w-20 animate-pulse rounded-full bg-bg-tertiary" />
                    </div>
                  </div>
                ))}
              </div>
            ) : calls.length === 0 ? (
              <EmptyState
                icon={Phone}
                title="No calls yet"
                body="Once Sarah starts answering your calls, they'll appear here with summaries, caller details, and booking status. Forward your phone number to Sarah to get started."
              />
            ) : (
              <div className="space-y-3">
                {calls.map((call, i) => {
                  const status = statusConfig[call.status] || statusConfig.new_lead;
                  const StatusIcon = status.icon;
                  return (
                    <motion.div
                      key={call.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                      className="flex items-start gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 ease-out hover:border-accent/30 dark:shadow-card-dark"
                    >
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${status.color}`}>
                        <StatusIcon size={20} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-text-primary truncate">
                            {call.caller_name || 'Unknown caller'}
                          </p>
                          {call.is_emergency && (
                            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                              Emergency
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-text-secondary line-clamp-2">
                          {call.summary || 'No summary available'}
                        </p>
                        <div className="mt-2 flex items-center gap-4 text-xs text-text-secondary">
                          <span>{formatTimeAgo(call.call_datetime)}</span>
                          <span>{formatDuration(call.duration_seconds)}</span>
                          {call.caller_phone && <span>{call.caller_phone}</span>}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${status.color}`}>
                        {status.label}
                      </span>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Upcoming jobs */}
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-text-primary">Upcoming Jobs</h2>
            {jobs.length > 0 && (
              <Link to="/dashboard/jobs" className="text-sm font-medium text-accent hover:underline">
                View all
              </Link>
            )}
          </div>
          <div className="mt-4">
            {dataLoading ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                    <div className="h-4 w-32 animate-pulse rounded bg-bg-tertiary" />
                    <div className="mt-3 h-3 w-48 animate-pulse rounded bg-bg-tertiary" />
                    <div className="mt-3 h-3 w-24 animate-pulse rounded bg-bg-tertiary" />
                  </div>
                ))}
              </div>
            ) : jobs.length === 0 ? (
              <EmptyState
                icon={Calendar}
                title="No jobs scheduled"
                body="When Sarah books appointments for you, they'll appear here with customer details, service type, and scheduled time. Calls with booking intent automatically create jobs."
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {jobs.map((job, i) => {
                  const status = jobStatusConfig[job.job_status] || jobStatusConfig.scheduled;
                  return (
                    <motion.div
                      key={job.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 ease-out hover:border-accent/30 dark:shadow-card-dark"
                    >
                      <div className="flex items-start justify-between">
                        <p className="text-sm font-semibold text-text-primary">{job.customer_name}</p>
                        <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.color}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-text-secondary">{job.service_type || 'Service'}</p>
                      {job.address && (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
                          <MapPin size={14} />
                          <span>{job.address}</span>
                        </div>
                      )}
                      <div className="mt-3 flex items-center justify-between">
                        <span className="text-xs text-text-secondary">
                          {job.scheduled_datetime
                            ? new Date(job.scheduled_datetime).toLocaleDateString('en-US', {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })
                            : 'Unscheduled'}
                        </span>
                        {job.invoice_amount && (
                          <span className="flex items-center gap-1 text-xs font-medium text-text-primary">
                            <DollarSign size={14} />
                            {job.invoice_amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
