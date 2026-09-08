import { motion } from 'framer-motion';
import {
  PhoneIncoming, Siren, CalendarCheck, DollarSign,
  TrendingUp, Activity, User, Clock, CheckCircle2, ArrowUpRight,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, viewport } from '@/lib/motion';

const EASE_ARR = [0.16, 1, 0.3, 1] as const;

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
  { name: 'Marcus R.', reason: 'Burst pipe — emergency', time: '2 min ago', status: 'Booked', tone: 'danger' as const },
  { name: 'Sarah L.', reason: 'Annual HVAC maintenance', time: '8 min ago', status: 'Booked', tone: 'success' as const },
  { name: 'David K.', reason: 'Estimate request — roofing', time: '14 min ago', status: 'Qualified', tone: 'accent' as const },
  { name: 'Lisa M.', reason: 'Electrical outlet sparking', time: '21 min ago', status: 'Dispatched', tone: 'danger' as const },
];

const APPOINTMENTS = [
  { time: '2:30 PM', name: 'Marcus R.', job: 'Burst pipe repair', tech: 'Tech A', status: 'En route' },
  { time: '4:00 PM', name: 'Lisa M.', job: 'Outlet replacement', tech: 'Tech B', status: 'Confirmed' },
  { time: '6:00 PM', name: 'Sarah L.', job: 'HVAC tune-up', tech: 'Tech A', status: 'Confirmed' },
  { time: 'Tomorrow 9 AM', name: 'David K.', job: 'Roofing estimate', tech: 'Tech C', status: 'Scheduled' },
];

const STATUS_TONE: Record<string, string> = {
  Booked: 'text-success bg-success/10',
  Qualified: 'text-accent bg-accent/10',
  Dispatched: 'text-danger bg-danger/10',
};

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

export function DashboardPreview() {
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

          {/* Dashboard body */}
          <div className="bg-bg-tertiary/40 p-4 sm:p-6">
            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {STAT_CARDS.map((stat, i) => (
                <StatCard key={stat.label} {...stat} delay={0.2 + i * 0.05} />
              ))}
            </div>

            {/* Two-column: Recent calls + Appointments */}
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {/* Recent Calls */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, delay: 0.45, ease: EASE_ARR }}
                className="overflow-hidden rounded-2xl border border-border bg-bg-secondary"
              >
                <div className="flex items-center gap-2 border-b border-border px-4 py-3.5 sm:px-5">
                  <Activity size={16} className="text-accent" />
                  <h3 className="text-sm font-semibold text-text-primary">Recent Call Activity</h3>
                  <span className="ml-auto text-xs font-medium text-text-secondary">Last 30 min</span>
                </div>
                <div className="divide-y divide-border/60">
                  {RECENT_CALLS.map((call, i) => (
                    <motion.div
                      key={call.name}
                      initial={{ opacity: 0, x: -8 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={viewport}
                      transition={{ duration: 0.35, delay: 0.5 + i * 0.08, ease: EASE_ARR }}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-tertiary/50 sm:px-5"
                    >
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
                    </motion.div>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-border px-4 py-2.5 sm:px-5">
                  <span className="text-xs text-text-secondary">Auto-synced to CRM</span>
                  <span className="flex items-center gap-1 text-xs font-semibold text-success">
                    <CheckCircle2 size={12} />
                    All calls logged
                  </span>
                </div>
              </motion.div>

              {/* Appointment Timeline */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, delay: 0.55, ease: EASE_ARR }}
                className="overflow-hidden rounded-2xl border border-border bg-bg-secondary"
              >
                <div className="flex items-center gap-2 border-b border-border px-4 py-3.5 sm:px-5">
                  <CalendarCheck size={16} className="text-accent" />
                  <h3 className="text-sm font-semibold text-text-primary">Appointment Timeline</h3>
                  <span className="ml-auto text-xs font-medium text-text-secondary">Today</span>
                </div>
                <div className="p-4 sm:p-5">
                  <div className="relative">
                    <div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />
                    {APPOINTMENTS.map((apt, i) => (
                      <motion.div
                        key={apt.name}
                        initial={{ opacity: 0, x: -8 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={viewport}
                        transition={{ duration: 0.35, delay: 0.6 + i * 0.08, ease: EASE_ARR }}
                        className="relative flex items-start gap-3 pb-5 last:pb-0"
                      >
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
                      </motion.div>
                    ))}
                  </div>
                </div>
              </motion.div>
            </div>

            {/* AI Summary bar */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.7, ease: EASE_ARR }}
              className="mt-4 flex flex-col gap-3 rounded-2xl border border-accent/20 bg-accent/5 p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                  <TrendingUp size={18} />
                </span>
                <span className="text-sm font-semibold text-text-primary">AI Summary</span>
              </div>
              <p className="flex-1 text-xs leading-relaxed text-text-secondary sm:text-sm">
                Sarah answered 47 calls today, flagged 8 emergencies, and booked 31 jobs.
                Revenue recovered: $14,200 — a 22% improvement over last week. CRM sync
                completed for all calls.
              </p>
              <span className="flex items-center gap-1 text-xs font-semibold text-success">
                <Clock size={13} />
                Updated 2 min ago
              </span>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
