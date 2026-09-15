import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  PhoneIncoming, Siren, CalendarCheck, DollarSign,
  TrendingUp, Activity, User, Clock, CheckCircle2, ArrowUpRight,
  LayoutGrid, PhoneCall, KanbanSquare, BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, viewport } from '@/lib/motion';

const EASE_ARR = [0.16, 1, 0.3, 1] as const;

// ============================================================
// MOCK DATA — same shape as the real dashboard, no live calls made.
// ============================================================

const STAT_CARDS = [
  { icon: PhoneIncoming, label: 'Calls Answered Today', value: '47', change: '+12%', tone: 'accent' as const },
  { icon: Siren, label: 'Emergencies Detected', value: '8', change: '+3', tone: 'danger' as const },
  { icon: CalendarCheck, label: 'Jobs Booked', value: '31', change: '+9', tone: 'success' as const },
  { icon: DollarSign, label: 'Revenue Recovered', value: '$14.2K', change: '+22%', tone: 'cta' as const },
];

const TONE_BG: Record<string, string> = {
  accent: 'bg-accent/10 text-accent',
  danger: 'bg-danger/10 text-danger',
  success: 'bg-success/10 text-success',
  cta: 'bg-cta/10 text-cta',
};

const RECENT_CALLS = [
  { name: 'Marcus R.', reason: 'Burst pipe — emergency', time: '2 min ago', duration: '3:41', status: 'Booked', tone: 'danger' as const },
  { name: 'Sarah L.', reason: 'Annual HVAC maintenance', time: '8 min ago', duration: '2:14', status: 'Booked', tone: 'success' as const },
  { name: 'David K.', reason: 'Estimate request — roofing', time: '14 min ago', duration: '4:02', status: 'Qualified', tone: 'accent' as const },
  { name: 'Lisa M.', reason: 'Electrical outlet sparking', time: '21 min ago', duration: '1:58', status: 'Dispatched', tone: 'danger' as const },
  { name: 'Tom H.', reason: 'Quote follow-up — fencing', time: '33 min ago', duration: '2:37', status: 'Booked', tone: 'success' as const },
  { name: 'Priya S.', reason: 'Water heater not heating', time: '47 min ago', duration: '3:10', status: 'Qualified', tone: 'accent' as const },
];

const STATUS_TONE: Record<string, string> = {
  Booked: 'text-success bg-success/10',
  Qualified: 'text-accent bg-accent/10',
  Dispatched: 'text-danger bg-danger/10',
};

const APPOINTMENTS = [
  { time: '2:30 PM', name: 'Marcus R.', job: 'Burst pipe repair', tech: 'Tech A', status: 'En route' },
  { time: '4:00 PM', name: 'Lisa M.', job: 'Outlet replacement', tech: 'Tech B', status: 'Confirmed' },
  { time: '6:00 PM', name: 'Sarah L.', job: 'HVAC tune-up', tech: 'Tech A', status: 'Confirmed' },
  { time: 'Tomorrow 9 AM', name: 'David K.', job: 'Roofing estimate', tech: 'Tech C', status: 'Scheduled' },
];

// Mirrors JobsPage.tsx's real board columns/colors exactly, so this reads
// as the actual product, not an approximation of it.
const BOARD_COLUMNS = [
  {
    key: 'scheduled', label: 'Scheduled', dot: 'bg-accent', border: 'border-t-accent',
    jobs: [
      { name: 'David K.', job: 'Roofing estimate', time: 'Tomorrow 9 AM', tech: 'Tech C' },
      { name: 'Priya S.', job: 'Water heater repair', time: 'Tomorrow 1 PM', tech: 'Tech A' },
    ],
  },
  {
    key: 'en_route', label: 'En Route', dot: 'bg-blue-500', border: 'border-t-blue-500',
    jobs: [{ name: 'Marcus R.', job: 'Burst pipe repair', time: '2:30 PM', tech: 'Tech A' }],
  },
  {
    key: 'in_progress', label: 'In Progress', dot: 'bg-warning-500', border: 'border-t-warning-500',
    jobs: [{ name: 'Tom H.', job: 'Fence installation', time: 'Started 1:15 PM', tech: 'Tech B' }],
  },
  {
    key: 'completed', label: 'Completed', dot: 'bg-success-500', border: 'border-t-success-500',
    jobs: [
      { name: 'Lisa M.', job: 'Outlet replacement', time: '11:40 AM', tech: 'Tech B' },
      { name: 'Sarah L.', job: 'HVAC tune-up', time: '9:20 AM', tech: 'Tech A' },
    ],
  },
];

const REVENUE_TREND = [
  { month: 'Apr', revenue: 9200 }, { month: 'May', revenue: 10800 }, { month: 'Jun', revenue: 11500 },
  { month: 'Jul', revenue: 12100 }, { month: 'Aug', revenue: 13400 }, { month: 'Sep', revenue: 14200 },
];

const ANALYTICS_STATS = [
  { label: 'Avg. call duration', value: '2m 54s' },
  { label: 'Call → job conversion', value: '38%' },
  { label: 'After-hours calls answered', value: '100%' },
];

// ============================================================
// SHARED PIECES
// ============================================================

function StatCard({ icon: Icon, label, value, change, tone, delay }: {
  icon: LucideIcon; label: string; value: string; change: string; tone: string; delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, delay, ease: EASE_ARR }}
      className="group relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover dark:shadow-card-dark sm:p-6"
    >
      <div className="flex items-start justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${TONE_BG[tone]} sm:h-11 sm:w-11`}>
          <Icon size={18} className="sm:size-5" />
        </span>
        <span className="flex items-center gap-0.5 text-xs font-semibold text-success">
          <ArrowUpRight size={13} />
          {change}
        </span>
      </div>
      <p className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">{value}</p>
      <p className="mt-1 text-xs font-medium text-text-secondary sm:text-sm">{label}</p>
    </motion.div>
  );
}

// ============================================================
// TAB 1 — DASHBOARD
// ============================================================

function DashboardTab() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {STAT_CARDS.map((stat, i) => (
          <StatCard key={stat.label} {...stat} delay={0.05 + i * 0.05} />
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5 sm:px-5">
            <Activity size={16} className="text-accent" />
            <h3 className="text-sm font-semibold text-text-primary">Recent Call Activity</h3>
            <span className="ml-auto text-xs font-medium text-text-secondary">Last 30 min</span>
          </div>
          <div className="divide-y divide-border/60">
            {RECENT_CALLS.slice(0, 4).map((call) => (
              <div key={call.name} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-tertiary/50 sm:px-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                  <User size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{call.name}</p>
                  <p className="truncate text-xs text-text-secondary">{call.reason}</p>
                </div>
                <div className="hidden text-right sm:block">
                  <p className="text-xs text-text-secondary">{call.time}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.65rem] font-semibold ${STATUS_TONE[call.status]}`}>
                  {call.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5 sm:px-5">
            <CalendarCheck size={16} className="text-accent" />
            <h3 className="text-sm font-semibold text-text-primary">Appointment Timeline</h3>
            <span className="ml-auto text-xs font-medium text-text-secondary">Today</span>
          </div>
          <div className="p-4 sm:p-5">
            <div className="relative">
              <div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />
              {APPOINTMENTS.map((apt) => (
                <div key={apt.name} className="relative flex items-start gap-3 pb-5 last:pb-0">
                  <span className="relative z-10 mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-bg-secondary">
                    <span className="h-1 w-1 rounded-full bg-accent" />
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-text-primary">{apt.name}</p>
                      <span className="shrink-0 text-xs font-medium text-accent">{apt.time}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-text-secondary">{apt.job}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="flex items-center gap-1 text-[0.65rem] text-text-secondary">
                        <User size={11} />
                        {apt.tech}
                      </span>
                      <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[0.6rem] font-semibold text-success">
                        <CheckCircle2 size={10} />
                        {apt.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-accent/20 bg-accent/5 p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <TrendingUp size={18} />
          </span>
          <span className="text-sm font-semibold text-text-primary">AI Summary</span>
        </div>
        <p className="flex-1 text-xs leading-relaxed text-text-secondary sm:text-sm">
          Sarah answered 47 calls today, flagged 8 emergencies, and booked 31 jobs.
          Revenue recovered: $14,200 — a 22% improvement over last week.
        </p>
        <span className="flex items-center gap-1 text-xs font-semibold text-success">
          <Clock size={13} />
          Updated 2 min ago
        </span>
      </div>
    </>
  );
}

// ============================================================
// TAB 2 — CALL MANAGEMENT
// ============================================================

function CallsTab() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5 sm:px-5">
        <PhoneCall size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-text-primary">Call Management</h3>
        <span className="ml-auto text-xs font-medium text-text-secondary">6 calls · today</span>
      </div>
      <div className="divide-y divide-border/60">
        {RECENT_CALLS.map((call) => (
          <div key={call.name} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-bg-tertiary/50 sm:px-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
              <User size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-text-primary">{call.name}</p>
                <span className="shrink-0 text-[0.65rem] text-text-secondary/70">{call.duration}</span>
              </div>
              <p className="truncate text-xs text-text-secondary">{call.reason}</p>
            </div>
            <div className="hidden text-right sm:block">
              <p className="text-xs text-text-secondary">{call.time}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.65rem] font-semibold ${STATUS_TONE[call.status]}`}>
              {call.status}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-2.5 sm:px-5">
        <span className="text-xs text-text-secondary">Every call transcribed &amp; summarized automatically</span>
        <span className="flex items-center gap-1 text-xs font-semibold text-success">
          <CheckCircle2 size={12} />
          100% answered
        </span>
      </div>
    </div>
  );
}

// ============================================================
// TAB 3 — JOBS BOARD
// ============================================================

function JobsTab() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {BOARD_COLUMNS.map((col) => (
        <div key={col.key} className={`rounded-2xl border border-t-2 border-border bg-bg-secondary ${col.border}`}>
          <div className="flex items-center gap-2 px-3.5 py-3">
            <span className={`h-2 w-2 rounded-full ${col.dot}`} />
            <span className="text-xs font-semibold text-text-primary">{col.label}</span>
            <span className="ml-auto text-[0.65rem] font-medium text-text-secondary">{col.jobs.length}</span>
          </div>
          <div className="space-y-2 px-2.5 pb-2.5">
            {col.jobs.map((job) => (
              <div key={job.name} className="rounded-xl border border-border/70 bg-bg-primary p-3">
                <p className="text-xs font-semibold text-text-primary">{job.name}</p>
                <p className="mt-0.5 text-[0.7rem] text-text-secondary">{job.job}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[0.65rem] text-text-secondary">
                    <User size={10} />
                    {job.tech}
                  </span>
                  <span className="text-[0.65rem] font-medium text-accent">{job.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// TAB 4 — ANALYTICS
// ============================================================

function AnalyticsTab() {
  const maxVal = Math.max(...REVENUE_TREND.map((d) => d.revenue));
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <BarChart3 size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-text-primary">Revenue Recovered — Last 6 Months</h3>
      </div>
      <div className="mt-5 flex items-end gap-2" style={{ height: 140 }}>
        {REVENUE_TREND.map((d) => (
          <div key={d.month} className="flex flex-1 flex-col items-center justify-end" style={{ height: '100%' }}>
            <div
              className="w-full rounded-t-md bg-cta"
              style={{ height: `${(d.revenue / maxVal) * 100}%`, minHeight: 4 }}
            />
            <span className="mt-2 text-[0.65rem] text-text-secondary">{d.month}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-3">
        {ANALYTICS_STATS.map((s) => (
          <div key={s.label}>
            <p className="text-lg font-bold text-text-primary">{s.value}</p>
            <p className="text-xs text-text-secondary">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// TAB SWITCHER + WRAPPER
// ============================================================

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { key: 'calls', label: 'Call Management', icon: PhoneCall },
  { key: 'jobs', label: 'Jobs Board', icon: KanbanSquare },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function DashboardPreview() {
  const [tab, setTab] = useState<TabKey>('dashboard');

  return (
    <section id="dashboard-preview" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 30%, rgb(var(--accent-primary) / 0.07), transparent 50%), radial-gradient(circle at 80% 70%, rgb(var(--accent-secondary) / 0.05), transparent 50%)',
        }}
      />
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>{'Product Preview'}</p>
          <h2 className="mt-3 text-2xl font-bold leading-[1.2] tracking-tight text-text-primary sm:text-3xl md:text-5xl">
            Your AI Operations Command Center
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:mt-5 sm:text-base md:text-lg">
            Every call, every emergency, every booked job — visible in real time. This is what
            your dashboard looks like on day one.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.7, delay: 0.15, ease: EASE_ARR }}
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-14 sm:rounded-3xl"
        >
          {/* Browser chrome */}
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-3 sm:px-5">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/40" />
            <span className="h-2.5 w-2.5 rounded-full bg-warning-500/40" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/40" />
            <div className="ml-3 hidden items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-3 py-1 sm:flex">
              <span className="text-[0.65rem] text-text-secondary/60">app.vireek.com/dashboard</span>
            </div>
            <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-success">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Live
            </span>
          </div>

          {/* Tab strip */}
          <div className="flex gap-1 overflow-x-auto border-b border-border bg-bg-secondary px-3 py-2 sm:px-4">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  tab === key
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          {/* Tab body */}
          <div className="bg-bg-tertiary/40 p-4 sm:p-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25, ease: EASE_ARR }}
              >
                {tab === 'dashboard' && <DashboardTab />}
                {tab === 'calls' && <CallsTab />}
                {tab === 'jobs' && <JobsTab />}
                {tab === 'analytics' && <AnalyticsTab />}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
