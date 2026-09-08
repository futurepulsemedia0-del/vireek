import { motion } from 'framer-motion';
import {
  PhoneIncoming,
  Siren,
  CalendarCheck,
  RotateCcw,
  DollarSign,
  Percent,
  Clock,
  Zap,
  CalendarClock,
  ArrowUpRight,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { CountUp } from '@/components/ui/CountUp';

/**
 * RevenueIntelligence
 * ------------------------------------------------------------------
 * "Vireek Revenue Intelligence" — premium landing page section.
 *
 * Reframes Vireek from "call analytics" to a financial system: every
 * metric here ties back to a dollar figure, so the visitor's takeaway
 * is "this directly increases my revenue," not "this is a nice log."
 *
 * Self-contained — owns its own copy, mock dashboard data, custom
 * lightweight charts (no external chart library required), and
 * animation. Built entirely on the site's existing design tokens and
 * shared motion helpers.
 * ------------------------------------------------------------------
 */

const EASE_ARR = EASE;

interface RevenueStat {
  icon: LucideIcon;
  label: string;
  value: string;
  change: string;
  tone: 'accent' | 'danger' | 'success' | 'cta';
}

const STATS: RevenueStat[] = [
  { icon: PhoneIncoming, label: 'Calls Answered', value: '247', change: '+12%', tone: 'accent' },
  { icon: Siren, label: 'Emergency Calls Detected', value: '18', change: '+5', tone: 'danger' },
  { icon: CalendarCheck, label: 'Appointments Booked', value: '42', change: '+9', tone: 'success' },
  { icon: RotateCcw, label: 'Recovered Opportunities', value: '9', change: 'new', tone: 'cta' },
  { icon: DollarSign, label: 'Revenue Protected', value: '$28,400', change: '+22%', tone: 'cta' },
  { icon: Percent, label: 'Conversion Rate', value: '68%', change: '+7pts', tone: 'success' },
];

const TONE_BG: Record<RevenueStat['tone'], string> = {
  accent: 'bg-accent/10 text-accent',
  danger: 'bg-danger/10 text-danger',
  success: 'bg-success/10 text-success',
  cta: 'bg-cta/10 text-cta',
};

interface RevenueDay {
  label: string;
  amount: number;
}

const WEEK: RevenueDay[] = [
  { label: 'Mon', amount: 3200 },
  { label: 'Tue', amount: 2900 },
  { label: 'Wed', amount: 4100 },
  { label: 'Thu', amount: 3600 },
  { label: 'Fri', amount: 5200 },
  { label: 'Sat', amount: 4800 },
  { label: 'Sun', amount: 4600 },
];

const WEEK_TOTAL = WEEK.reduce((sum, day) => sum + day.amount, 0);
const WEEK_MAX = Math.max(...WEEK.map((d) => d.amount));

interface Insight {
  icon: LucideIcon;
  title: string;
  body: string;
  metric: string;
}

const INSIGHTS: Insight[] = [
  {
    icon: Clock,
    title: 'Peak Missed-Call Window',
    body: 'Your busiest missed-call window is 6PM\u20139PM \u2014 exactly when most receptionists have gone home.',
    metric: '+34% calls captured after hours',
  },
  {
    icon: Zap,
    title: 'Emergency Calls Convert Faster',
    body: 'Emergency customers book almost immediately \u2014 they need someone now, not a callback tomorrow.',
    metric: '89% emergency-to-booking rate',
  },
  {
    icon: CalendarClock,
    title: 'Weekend Availability Pays Off',
    body: 'Opening weekend booking windows surfaces revenue your competitors are letting go to voicemail.',
    metric: '$6,200 booked outside business hours',
  },
];

function StatCard({ icon: Icon, label, value, change, tone, delay }: {
  icon: LucideIcon;
  label: string;
  value: string;
  change: string;
  tone: RevenueStat['tone'];
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, delay, ease: EASE_ARR }}
      className="group relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-4 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover dark:shadow-card-dark sm:p-5"
    >
      <div className="flex items-start justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl sm:h-10 sm:w-10 ${TONE_BG[tone]}`}>
          <Icon size={17} className="sm:size-[18px]" />
        </span>
        <span className="flex items-center gap-0.5 text-[0.65rem] font-semibold text-success sm:text-xs">
          <ArrowUpRight size={12} />
          {change}
        </span>
      </div>
      <p className="mt-3.5 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
        <CountUp value={value} />
      </p>
      <p className="mt-1 text-[0.7rem] font-medium leading-tight text-text-secondary sm:text-xs">{label}</p>
    </motion.div>
  );
}

function RevenueBarChart() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, delay: 0.3, ease: EASE_ARR }}
      className="flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary sm:text-base">Revenue Protected \u2014 Last 7 Days</h3>
          <p className="mt-0.5 text-xs text-text-secondary">Calls Sarah caught that would have been lost</p>
        </div>
        <span className="shrink-0 rounded-full bg-cta/10 px-3 py-1 text-xs font-semibold text-cta">
          ${WEEK_TOTAL.toLocaleString()} total
        </span>
      </div>

      <div className="mt-6 flex h-40 items-end gap-2.5 sm:h-48 sm:gap-3.5">
        {WEEK.map((day, i) => {
          const heightPct = Math.max((day.amount / WEEK_MAX) * 100, 6);
          const isPeak = day.amount === WEEK_MAX;
          return (
            <div key={day.label} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
              <span className="text-[0.6rem] font-semibold text-text-secondary sm:text-[0.65rem]">
                ${Math.round(day.amount / 100) / 10}K
              </span>
              <div className="flex w-full flex-1 items-end overflow-hidden rounded-t-lg bg-bg-tertiary/60">
                <motion.div
                  initial={{ height: 0 }}
                  whileInView={{ height: `${heightPct}%` }}
                  viewport={viewport}
                  transition={{ duration: 0.7, delay: 0.4 + i * 0.06, ease: EASE_ARR }}
                  className={`w-full rounded-t-lg ${
                    isPeak
                      ? 'bg-gradient-to-t from-accent to-cta'
                      : 'bg-gradient-to-t from-accent/60 to-cta/60'
                  }`}
                />
              </div>
              <span className="text-[0.65rem] font-medium text-text-secondary sm:text-xs">{day.label}</span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function ConversionRing() {
  const percent = 68;
  const radius = 46;
  const circumference = 2 * Math.PI * radius;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, delay: 0.4, ease: EASE_ARR }}
      className="flex h-full flex-col items-center justify-center rounded-2xl border border-border bg-bg-secondary p-5 text-center shadow-card dark:shadow-card-dark sm:p-6"
    >
      <h3 className="self-start text-sm font-semibold text-text-primary sm:text-base">Conversion Rate</h3>
      <p className="mt-0.5 self-start text-xs text-text-secondary">Calls that turned into booked jobs</p>

      <div className="relative mt-4 flex h-32 w-32 items-center justify-center sm:h-36 sm:w-36">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="rgb(var(--border-default))" strokeWidth="8" />
          <motion.circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="rgb(var(--accent-secondary))"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            whileInView={{ strokeDashoffset: circumference * (1 - percent / 100) }}
            viewport={viewport}
            transition={{ duration: 1, delay: 0.5, ease: EASE_ARR }}
          />
        </svg>
        <div className="absolute flex flex-col items-center">
          <span className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
            <CountUp value={`${percent}%`} />
          </span>
          <span className="text-[0.65rem] font-medium text-success">+7pts vs last month</span>
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-text-secondary">
        Nearly 7 in 10 calls end in a booked job \u2014 well above the industry average.
      </p>
    </motion.div>
  );
}

export function RevenueIntelligence() {
  return (
    <section id="revenue-intelligence" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 85% 10%, rgb(var(--accent-secondary) / 0.08), transparent 50%), radial-gradient(circle at 15% 90%, rgb(var(--accent-primary) / 0.07), transparent 45%)',
        }}
      />

      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>{'Revenue Intelligence'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            {'The Financial Brain of Your Home Service Business'}
          </h2>
          <p className={`${bodyClass()} mx-auto max-w-2xl text-sm sm:text-base md:text-lg`}>
            {"Vireek doesn\u2019t just log calls \u2014 it quantifies exactly how much revenue Sarah protects for your business, every single week."}
          </p>
        </motion.div>

        {/* Dashboard panel */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE_ARR }}
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-14 sm:rounded-3xl"
        >
          {/* Panel header */}
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-3.5 sm:px-6">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cta/15 text-cta">
              <DollarSign size={14} />
            </span>
            <span className="text-xs font-semibold text-text-primary sm:text-sm">Revenue Intelligence Dashboard</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-success">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Live
            </span>
          </div>

          <div className="bg-bg-tertiary/40 p-4 sm:p-6">
            {/* Stat grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
              {STATS.map((stat, i) => (
                <StatCard key={stat.label} {...stat} delay={0.15 + i * 0.05} />
              ))}
            </div>

            {/* Chart row */}
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <RevenueBarChart />
              </div>
              <ConversionRing />
            </div>

            {/* AI Insights */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.5, ease: EASE_ARR }}
              className="mt-4"
            >
              <div className="flex items-center gap-2 px-1">
                <Sparkles size={15} className="text-accent" />
                <h3 className="text-sm font-semibold text-text-primary sm:text-base">AI Insights</h3>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {INSIGHTS.map((insight, i) => {
                  const Icon = insight.icon;
                  return (
                    <motion.div
                      key={insight.title}
                      initial={{ opacity: 0, y: 12 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={viewport}
                      transition={{ duration: 0.4, delay: 0.55 + i * 0.08, ease: EASE_ARR }}
                      className="rounded-2xl border border-accent/20 bg-accent/5 p-4"
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
                        <Icon size={16} />
                      </span>
                      <h4 className="mt-3 text-sm font-semibold text-text-primary">{insight.title}</h4>
                      <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">{insight.body}</p>
                      <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-bg-secondary px-2.5 py-1 text-[11px] font-medium text-accent">
                        {insight.metric}
                      </p>
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>
          </div>
        </motion.div>

        {/* Closing statement */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mx-auto mt-8 max-w-2xl rounded-2xl border border-cta/20 bg-gradient-to-br from-cta/5 via-bg-secondary to-accent/5 p-5 text-center shadow-card dark:shadow-card-dark sm:mt-12 sm:p-6"
        >
          <p className="text-sm font-medium leading-relaxed text-text-primary sm:text-base">
            {"This isn\u2019t a call log. It\u2019s "}
            <span className="text-cta">{'the exact dollar amount'}</span>
            {' Sarah puts back in your business every week.'}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
