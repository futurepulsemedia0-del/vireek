import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  PhoneCall,
  Users,
  CalendarClock,
  Siren,
  PhoneOutgoing,
  Truck,
  Sparkles,
  Zap,
  Clock,
  CheckCircle2,
  Circle,
  Activity,
  Wrench,
  DatabaseZap,
  ScanSearch,
  CalendarCheck,
  BellRing,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

/**
 * OperationsCommandCenter
 * ------------------------------------------------------------------
 * "AI Operations Command Center" — the most premium landing page
 * section on the site. Repositions Vireek from "AI receptionist" to
 * "AI operating system for home service businesses" by showing a
 * live, dark, enterprise-grade control room: calls in progress,
 * leads, the day's queue, technician status, emergency alerts, AI
 * recommendations, and a live event log — all in one screen.
 *
 * The panel is intentionally rendered in a fixed dark enterprise
 * palette (not the site's light/dark toggle) so it always reads as
 * "product screenshot of serious software," the way Linear, Stripe,
 * and Datadog present their own dashboards on marketing pages.
 *
 * Self-contained — owns its own copy, mock data, and animation.
 * Only a small client-side interval drives the "live" log highlight;
 * everything else follows the site's existing scroll-triggered
 * motion conventions.
 * ------------------------------------------------------------------
 */

type Tone = 'accent' | 'cta' | 'danger' | 'success';

const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  cta: 'text-cta',
  danger: 'text-danger',
  success: 'text-success',
};

const TONE_BG: Record<Tone, string> = {
  accent: 'bg-accent/15 text-accent',
  cta: 'bg-cta/15 text-cta',
  danger: 'bg-danger/15 text-danger',
  success: 'bg-success/15 text-success',
};

const TONE_DOT: Record<Tone, string> = {
  accent: 'bg-accent',
  cta: 'bg-cta',
  danger: 'bg-danger',
  success: 'bg-success',
};

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

interface StatPillData {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: Tone;
}

const STATS: StatPillData[] = [
  { icon: PhoneCall, label: 'Live Calls', value: '3', tone: 'accent' },
  { icon: Users, label: 'Active Leads', value: '12', tone: 'accent' },
  { icon: CalendarClock, label: 'Upcoming Jobs', value: '7', tone: 'success' },
  { icon: Siren, label: 'Emergency Alerts', value: '1', tone: 'danger' },
  { icon: PhoneOutgoing, label: 'Follow-ups Due', value: '4', tone: 'cta' },
  { icon: Truck, label: 'Technicians Online', value: '5/7', tone: 'success' },
];

interface LiveCall {
  name: string;
  reason: string;
  duration: string;
  tone: Tone;
}

const LIVE_CALLS: LiveCall[] = [
  { name: 'Ramirez Plumbing', reason: 'Emergency — burst pipe reported', duration: '00:42', tone: 'danger' },
  { name: 'Dana K.', reason: 'HVAC tune-up inquiry', duration: '01:15', tone: 'accent' },
];

interface QueueItemData {
  time: string;
  type: 'Job' | 'Follow-up';
  title: string;
  meta: string;
}

const QUEUE: QueueItemData[] = [
  { time: '2:30 PM', type: 'Job', title: 'Burst pipe repair — Ramirez', meta: 'Tech B assigned' },
  { time: '4:00 PM', type: 'Job', title: 'Outlet replacement — Lisa M.', meta: 'Tech A assigned' },
  { time: 'Now', type: 'Follow-up', title: '3 idle leads, 2+ hours', meta: 'Auto text queued' },
  { time: 'Tomorrow 9 AM', type: 'Job', title: 'Roofing estimate — David K.', meta: 'Tech C assigned' },
];

interface Recommendation {
  icon: LucideIcon;
  text: string;
  tag: string;
}

const RECOMMENDATIONS: Recommendation[] = [
  { icon: Zap, text: 'Dispatch toward Zone 12 — 3 emergency calls originated there this week.', tag: 'High priority' },
  { icon: Clock, text: '3 leads have gone idle for 2+ hours. Sarah can send a follow-up text now.', tag: 'Action ready' },
  { icon: CalendarClock, text: 'Weekend slots are filling fast — consider opening Sunday availability.', tag: 'Opportunity' },
];

interface Technician {
  name: string;
  status: 'On Job' | 'En Route' | 'Available' | 'Offline';
  job: string;
}

const TECHNICIANS: Technician[] = [
  { name: 'Mike — Tech A', status: 'On Job', job: 'HVAC tune-up, 6th St' },
  { name: 'Elena — Tech B', status: 'En Route', job: 'Burst pipe, Ramirez residence' },
  { name: 'Jordan — Tech C', status: 'Available', job: 'Standing by' },
  { name: 'Sam — Tech D', status: 'Offline', job: 'Shift ends 6 PM' },
];

const TECH_STATUS_TONE: Record<Technician['status'], Tone> = {
  'On Job': 'accent',
  'En Route': 'cta',
  Available: 'success',
  Offline: 'danger',
};

interface AlertData {
  title: string;
  detail: string;
  time: string;
}

const ALERTS: AlertData[] = [
  { title: 'Gas smell reported', detail: 'Marcus R. — dispatch confirmed, ETA 12 min', time: '2 min ago' },
];

interface FeedEvent {
  icon: LucideIcon;
  text: string;
  meta: string;
}

const FEED: FeedEvent[] = [
  { icon: PhoneCall, text: 'Sarah answered emergency plumbing call', meta: 'Ramirez Plumbing · 09:41:02' },
  { icon: ScanSearch, text: 'Customer qualified — burst pipe, hallway ceiling', meta: '09:41:18' },
  { icon: BellRing, text: 'Technician notified — Elena dispatched', meta: '09:41:35' },
  { icon: CalendarCheck, text: 'Appointment booked — today, 2:30 PM', meta: '09:42:04' },
  { icon: DatabaseZap, text: 'CRM updated — job and customer record synced', meta: '09:42:10' },
  { icon: PhoneCall, text: 'Sarah answered call — HVAC tune-up inquiry', meta: 'Dana K. · 09:47:33' },
  { icon: CheckCircle2, text: 'Follow-up scheduled — quote sent by SMS', meta: '09:48:02' },
  { icon: Users, text: '3 idle leads flagged for re-engagement', meta: '09:51:47' },
];

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function PanelHeader({ icon: Icon, title, badge }: { icon: LucideIcon; title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-3">
      <Icon size={14} className="text-accent" />
      <h3 className="text-xs font-semibold text-slate-100 sm:text-sm">{title}</h3>
      {badge && (
        <span className="ml-auto rounded-full bg-slate-800/80 px-2 py-0.5 text-[0.6rem] font-medium text-slate-400">
          {badge}
        </span>
      )}
    </div>
  );
}

function Waveform({ tone }: { tone: Tone }) {
  const bars = [6, 12, 8, 16, 10];
  return (
    <div className="flex h-4 items-center gap-[3px]">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className={`w-[3px] rounded-full ${TONE_DOT[tone]}`}
          animate={{ height: [h * 0.4, h, h * 0.4] }}
          transition={{ duration: 0.9 + i * 0.1, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                             */
/* ------------------------------------------------------------------ */

export function OperationsCommandCenter() {
  const [activeFeed, setActiveFeed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveFeed((prev) => (prev + 1) % FEED.length);
    }, 2400);
    return () => clearInterval(id);
  }, []);

  return (
    <section id="operations-command-center" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 0%, rgb(var(--accent-secondary) / 0.10), transparent 50%), radial-gradient(circle at 0% 100%, rgb(var(--accent-primary) / 0.06), transparent 45%)',
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
          <p className={eyebrowClass()}>{'AI Operations Command Center'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            {"This Isn\u2019t a Receptionist. It\u2019s an Operating System."}
          </h2>
          <p className={`${bodyClass()} mx-auto max-w-2xl text-sm sm:text-base md:text-lg`}>
            {'Every call, lead, job, and technician \u2014 orchestrated in real time by Sarah. This is what running your business on autopilot actually looks like.'}
          </p>
        </motion.div>

        {/* Dark command center panel */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="relative mt-10 overflow-hidden rounded-2xl border border-slate-800 bg-[#0a0b10] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.65)] sm:mt-14 sm:rounded-3xl"
        >
          {/* Ambient glow inside the panel */}
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                'radial-gradient(circle at 15% 0%, rgb(var(--accent-primary) / 0.14), transparent 40%), radial-gradient(circle at 100% 100%, rgb(var(--accent-secondary) / 0.10), transparent 40%)',
            }}
          />

          {/* Top bar */}
          <div className="relative flex items-center gap-2 border-b border-slate-800/80 bg-slate-950/60 px-4 py-3.5 sm:px-6">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/50" />
            <span className="h-2.5 w-2.5 rounded-full bg-warning-500/50" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/50" />
            <div className="ml-3 hidden items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-1 sm:flex">
              <span className="text-[0.65rem] text-slate-500">command.vireek.ai</span>
            </div>
            <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-success">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Live
            </span>
          </div>

          <div className="relative p-4 sm:p-6">
            {/* Stat strip */}
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6 sm:gap-3">
              {STATS.map((stat, i) => {
                const Icon = stat.icon;
                return (
                  <motion.div
                    key={stat.label}
                    initial={{ opacity: 0, y: 12 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.4, delay: 0.15 + i * 0.05, ease: EASE }}
                    className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                  >
                    <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${TONE_BG[stat.tone]}`}>
                      <Icon size={13} />
                    </span>
                    <p className="mt-2 text-lg font-bold tracking-tight text-slate-100 sm:text-xl">{stat.value}</p>
                    <p className="text-[0.6rem] font-medium leading-tight text-slate-500 sm:text-[0.65rem]">
                      {stat.label}
                    </p>
                  </motion.div>
                );
              })}
            </div>

            {/* Main grid */}
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {/* Left / wide column */}
              <div className="flex flex-col gap-3 lg:col-span-2">
                {/* Live Calls */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: 0.35, ease: EASE }}
                  className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50"
                >
                  <PanelHeader icon={PhoneCall} title="Live Calls" badge={`${LIVE_CALLS.length} active`} />
                  <div className="divide-y divide-slate-800/60">
                    {LIVE_CALLS.map((call) => (
                      <div key={call.name} className="flex items-center gap-3 px-4 py-3">
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TONE_BG[call.tone]}`}
                        >
                          <PhoneCall size={13} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-slate-100 sm:text-sm">{call.name}</p>
                          <p className="truncate text-[0.7rem] text-slate-500">{call.reason}</p>
                        </div>
                        <Waveform tone={call.tone} />
                        <span className="w-11 shrink-0 text-right text-[0.7rem] font-medium tabular-nums text-slate-500">
                          {call.duration}
                        </span>
                      </div>
                    ))}
                  </div>
                </motion.div>

                {/* Today's Queue */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: 0.45, ease: EASE }}
                  className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50"
                >
                  <PanelHeader icon={CalendarClock} title="Today's Queue" badge="Jobs & follow-ups" />
                  <div className="divide-y divide-slate-800/60">
                    {QUEUE.map((item) => (
                      <div key={item.title} className="flex items-center gap-3 px-4 py-3">
                        <span className="w-20 shrink-0 text-[0.7rem] font-medium text-slate-500">{item.time}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6rem] font-semibold ${
                            item.type === 'Job' ? 'bg-accent/15 text-accent' : 'bg-cta/15 text-cta'
                          }`}
                        >
                          {item.type}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-slate-200 sm:text-sm">{item.title}</p>
                        </div>
                        <span className="hidden shrink-0 text-[0.7rem] text-slate-500 sm:block">{item.meta}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>

                {/* Live activity log */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: 0.55, ease: EASE }}
                  className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50"
                >
                  <PanelHeader icon={Activity} title="Live Activity Feed" badge="Auto-refreshing" />
                  <div className="max-h-64 divide-y divide-slate-800/60 overflow-hidden">
                    {FEED.map((event, i) => {
                      const Icon = event.icon;
                      const isActive = i === activeFeed;
                      return (
                        <div
                          key={`${event.text}-${i}`}
                          className={`flex items-center gap-3 px-4 py-2.5 transition-colors duration-500 ${
                            isActive ? 'bg-accent/[0.06]' : ''
                          }`}
                        >
                          <span
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-500 ${
                              isActive ? 'bg-accent text-white' : 'bg-slate-800 text-slate-500'
                            }`}
                          >
                            <Icon size={11} />
                          </span>
                          <p
                            className={`min-w-0 flex-1 truncate text-[0.75rem] transition-colors duration-500 ${
                              isActive ? 'font-medium text-slate-100' : 'text-slate-500'
                            }`}
                          >
                            {event.text}
                          </p>
                          <span className="hidden shrink-0 text-[0.65rem] text-slate-600 sm:block">
                            {event.meta}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              </div>

              {/* Right / narrow column */}
              <div className="flex flex-col gap-3">
                {/* AI Recommendations */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: 0.4, ease: EASE }}
                  className="overflow-hidden rounded-2xl border border-accent/25 bg-gradient-to-b from-accent/[0.07] to-transparent"
                >
                  <div className="flex items-center gap-2 border-b border-accent/20 px-4 py-3">
                    <Sparkles size={14} className="text-accent" />
                    <h3 className="text-xs font-semibold text-slate-100 sm:text-sm">AI Recommendations</h3>
                  </div>
                  <div className="flex flex-col gap-2.5 p-3">
                    {RECOMMENDATIONS.map((rec) => {
                      const Icon = rec.icon;
                      return (
                        <div key={rec.text} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                              <Icon size={12} />
                            </span>
                            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[0.6rem] font-medium text-slate-400">
                              {rec.tag}
                            </span>
                          </div>
                          <p className="mt-2 text-[0.75rem] leading-relaxed text-slate-300">{rec.text}</p>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>

                {/* Technician Status */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: 0.5, ease: EASE }}
                  className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50"
                >
                  <PanelHeader icon={Wrench} title="Technician Status" />
                  <div className="divide-y divide-slate-800/60">
                    {TECHNICIANS.map((tech) => {
                      const tone = TECH_STATUS_TONE[tech.status];
                      return (
                        <div key={tech.name} className="flex items-center gap-2.5 px-4 py-2.5">
                          <Circle size={7} className={`shrink-0 fill-current ${TONE_TEXT[tone]}`} strokeWidth={0} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[0.75rem] font-medium text-slate-200">{tech.name}</p>
                            <p className="truncate text-[0.65rem] text-slate-500">{tech.job}</p>
                          </div>
                          <span className={`shrink-0 text-[0.65rem] font-semibold ${TONE_TEXT[tone]}`}>
                            {tech.status}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>

                {/* Emergency Alerts */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: 0.6, ease: EASE }}
                  className="overflow-hidden rounded-2xl border border-danger/25 bg-danger/[0.06]"
                >
                  <div className="flex items-center gap-2 border-b border-danger/20 px-4 py-3">
                    <Siren size={14} className="text-danger" />
                    <h3 className="text-xs font-semibold text-slate-100 sm:text-sm">Emergency Alerts</h3>
                  </div>
                  <div className="p-3">
                    {ALERTS.map((alert) => (
                      <div key={alert.title} className="rounded-xl border border-danger/20 bg-slate-900/60 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[0.75rem] font-semibold text-slate-100">{alert.title}</p>
                          <span className="shrink-0 text-[0.65rem] text-slate-500">{alert.time}</span>
                        </div>
                        <p className="mt-1 text-[0.7rem] leading-relaxed text-slate-400">{alert.detail}</p>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Closing statement */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mx-auto mt-8 max-w-2xl rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/5 via-bg-secondary to-cta/5 p-5 text-center shadow-card dark:shadow-card-dark sm:mt-12 sm:p-6"
        >
          <p className="text-sm font-medium leading-relaxed text-text-primary sm:text-base">
            {'Other tools give you a dashboard. '}
            <span className="text-accent">{'Vireek runs the operation'}</span>
            {' \u2014 calls, leads, jobs, and technicians, all in one place.'}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
