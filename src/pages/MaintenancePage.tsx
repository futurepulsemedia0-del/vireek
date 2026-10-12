import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Wrench,
  CalendarPlus,
  Activity,
  PhoneCall,
  LayoutDashboard,
  BellRing,
  CheckCircle2,
  Clock,
  ArrowRight,
  Mail,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useConnectivityOptional } from '@/contexts/ConnectivityContext';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass } from '@/lib/motion';
import {
  buildIcs,
  fetchRemoteWindow,
  formatDuration,
  getCountdown,
  getPhase,
  readEnvWindow,
  safeStatusUrl,
  type MaintenancePhase,
  type MaintenanceWindow,
} from '@/lib/maintenanceWindow';

const REMOTE_POLL_MS = 60_000;

const PHASE_META: Record<MaintenancePhase, { label: string; chip: string; dot: string }> = {
  none: {
    label: 'No maintenance scheduled',
    chip: 'border-success-500/25 bg-success-500/10 text-success-500',
    dot: 'bg-success-500',
  },
  upcoming: {
    label: 'Upcoming maintenance',
    chip: 'border-accent/25 bg-accent/10 text-accent',
    dot: 'bg-accent',
  },
  in_progress: {
    label: 'Maintenance in progress',
    chip: 'border-accent/25 bg-accent/10 text-accent',
    dot: 'bg-accent animate-pulse motion-reduce:animate-none',
  },
  completed: {
    label: 'Maintenance complete',
    chip: 'border-success-500/25 bg-success-500/10 text-success-500',
    dot: 'bg-success-500',
  },
};

const EXPECT = [
  {
    icon: PhoneCall,
    title: 'Calls keep being answered',
    body: 'Sarah is designed to keep answering inbound calls while the dashboard is updated, as long as the voice layer is healthy.',
  },
  {
    icon: LayoutDashboard,
    title: 'Dashboard may pause briefly',
    body: 'Sign-in and the web dashboard can be unavailable for part of the window. Anything you were doing can be resumed afterwards.',
  },
  {
    icon: Activity,
    title: 'Live updates on the status page',
    body: 'Component health and any change to the schedule are published on the status page as soon as we know.',
  },
];

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, intervalMs);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs]);
  return now;
}

function formatLocal(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function formatUtc(ms: number): string {
  return `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(ms))} UTC`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function CountdownTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center rounded-2xl border border-border/80 bg-bg-secondary px-2 py-4 shadow-card sm:px-4 sm:py-6">
      <span className="font-display text-3xl font-semibold tabular-nums leading-none text-text-primary sm:text-5xl">
        {value}
      </span>
      <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-secondary sm:text-xs">
        {label}
      </span>
    </div>
  );
}

export function MaintenancePage() {
  useSEO({
    title: 'Scheduled Maintenance | Vireek',
    description:
      'Planned maintenance windows for Vireek, with a live countdown, what to expect, and a link to real-time system status.',
    canonical: 'https://vireek.com/maintenance',
  });

  const connectivity = useConnectivityOptional();
  const gateActive = connectivity?.mode === 'maintenance';
  const gateEta = connectivity?.maintenance.eta ?? null;

  const [win, setWin] = useState<MaintenanceWindow>(readEnvWindow);
  const now = useNow(1000);

  // Remote override: initial load + gentle polling. Failures keep env data.
  useEffect(() => {
    const controller = new AbortController();
    const base = readEnvWindow();
    const load = async () => {
      const remote = await fetchRemoteWindow(base, controller.signal);
      if (remote && !controller.signal.aborted) setWin(remote);
    };
    void load();
    const id = window.setInterval(() => void load(), REMOTE_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(id);
    };
  }, []);

  const effective = useMemo<MaintenanceWindow>(() => {
    if (gateActive && win.endsAt === null && gateEta) {
      const t = Date.parse(gateEta);
      if (Number.isFinite(t)) return { ...win, endsAt: t };
    }
    return win;
  }, [win, gateActive, gateEta]);

  const phase = getPhase(effective, now, gateActive);
  const meta = PHASE_META[phase];

  const target =
    phase === 'upcoming'
      ? effective.startsAt
      : phase === 'in_progress'
        ? effective.endsAt
        : null;
  const countdown = target !== null ? getCountdown(target, now) : null;
  const duration =
    effective.startsAt !== null && effective.endsAt !== null
      ? formatDuration(effective.endsAt - effective.startsAt)
      : null;

  const statusUrl = safeStatusUrl(effective.statusUrl);
  const statusIsInternal = statusUrl.startsWith('/');
  const canAddToCalendar =
    (phase === 'upcoming' || phase === 'in_progress') &&
    effective.startsAt !== null &&
    effective.endsAt !== null;

  const downloadIcs = useCallback(() => {
    const ics = buildIcs(effective, window.location.origin);
    if (!ics) return;
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vireek-maintenance.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [effective]);

  // Screen readers get one calm update per minute instead of every second.
  const cdDays = countdown?.days ?? 0;
  const cdHours = countdown?.hours ?? 0;
  const cdMinutes = countdown?.minutes ?? 0;
  const hasCountdown = countdown !== null;
  const srSummary = useMemo(() => {
    if (!hasCountdown) return '';
    const parts = [
      cdDays ? `${cdDays} days` : '',
      cdHours ? `${cdHours} hours` : '',
      `${cdMinutes} minutes`,
    ].filter(Boolean);
    return `${phase === 'upcoming' ? 'Maintenance starts in' : 'Expected back in about'} ${parts.join(' ')}.`;
  }, [hasCountdown, cdDays, cdHours, cdMinutes, phase]);

  const statusButton = (
    <Button variant="secondary" size="lg" className="w-full sm:w-auto">
      <Activity className="h-4 w-4" aria-hidden="true" />
      View system status
    </Button>
  );

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
            >
              <div
                className={`mx-auto mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm ${meta.chip}`}
              >
                <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden="true" />
                {meta.label}
              </div>

              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <Wrench size={28} aria-hidden="true" />
              </span>

              <h1 className="mt-5 text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                {phase === 'none'
                  ? 'No maintenance is scheduled'
                  : phase === 'completed'
                    ? 'Maintenance is complete'
                    : effective.title}
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8">
                {phase === 'none'
                  ? 'Everything is running normally. When we plan an update that could affect you, the schedule and a live countdown appear here first.'
                  : phase === 'completed'
                    ? 'Thanks for your patience. Vireek is back to normal. If something still looks off, the status page shows live component health.'
                    : effective.message}
              </p>

              {countdown && (
                <div className="mt-10">
                  <p className="mb-4 text-sm font-semibold text-text-secondary">
                    {phase === 'upcoming' ? 'Starts in' : 'Expected back in'}
                  </p>
                  <div
                    role="timer"
                    aria-live="off"
                    aria-label={srSummary}
                    className="mx-auto grid max-w-xl grid-cols-4 gap-2 sm:gap-4"
                  >
                    <CountdownTile value={pad(countdown.days)} label="Days" />
                    <CountdownTile value={pad(countdown.hours)} label="Hours" />
                    <CountdownTile value={pad(countdown.minutes)} label="Min" />
                    <CountdownTile value={pad(countdown.seconds)} label="Sec" />
                  </div>
                  <p className="sr-only" role="status" aria-live="polite">
                    {srSummary}
                  </p>
                </div>
              )}

              <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
                {statusIsInternal ? (
                  <Link to={statusUrl} className="w-full sm:w-auto">
                    {statusButton}
                  </Link>
                ) : (
                  <a
                    href={statusUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full sm:w-auto"
                  >
                    {statusButton}
                  </a>
                )}
                {canAddToCalendar && (
                  <Button
                    variant="ghost"
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={downloadIcs}
                  >
                    <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                    Add to calendar
                  </Button>
                )}
                {phase === 'completed' && (
                  <Link to="/dashboard" className="w-full sm:w-auto">
                    <Button variant="primary" size="lg" className="w-full sm:w-auto">
                      Go to dashboard
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </Link>
                )}
              </div>
            </motion.div>
          </div>
        </section>

        {/* Window details */}
        {(effective.startsAt !== null || effective.endsAt !== null) && phase !== 'none' && (
          <section className="px-5 py-12 sm:px-6 sm:py-16">
            <div className="mx-auto max-w-4xl">
              <div className="text-center">
                <p className={eyebrowClass()}>Maintenance window</p>
                <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>
                  When it happens
                </h2>
                <p className="mt-3 text-sm text-text-secondary">
                  Shown in your local time, with UTC for reference.
                </p>
              </div>
              <div className="mt-8 grid gap-5 sm:grid-cols-2">
                {effective.startsAt !== null && (
                  <Card>
                    <div className="flex items-center gap-2 text-sm font-semibold text-accent">
                      <Clock className="h-4 w-4" aria-hidden="true" /> Starts
                    </div>
                    <p className="mt-3 text-base font-semibold text-text-primary">
                      {formatLocal(effective.startsAt)}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">{formatUtc(effective.startsAt)}</p>
                  </Card>
                )}
                {effective.endsAt !== null && (
                  <Card>
                    <div className="flex items-center gap-2 text-sm font-semibold text-accent">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Expected back
                    </div>
                    <p className="mt-3 text-base font-semibold text-text-primary">
                      {formatLocal(effective.endsAt)}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">{formatUtc(effective.endsAt)}</p>
                  </Card>
                )}
              </div>
              {duration && (
                <p className="mt-5 text-center text-sm text-text-secondary">
                  Planned duration: <span className="font-semibold text-text-primary">{duration}</span>
                </p>
              )}
            </div>
          </section>
        )}

        {/* What to expect */}
        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className="mx-auto max-w-6xl">
            <div className="text-center">
              <p className={eyebrowClass()}>What to expect</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>
                Built so your business keeps running
              </h2>
            </div>
            <div className="mt-8 grid gap-5 sm:mt-12 md:grid-cols-3">
              {EXPECT.map(({ icon: Icon, title, body }) => (
                <Card key={title} className="h-full">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold text-text-primary">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* Stay informed */}
        <section className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className="mx-auto max-w-4xl">
            <Card className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <BellRing size={20} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-text-primary">Stay informed</h3>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                    Subscribe to updates on the status page, or reach us directly at{' '}
                    <a
                      href="mailto:ali@vireek.com"
                      className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                    >
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      ali@vireek.com
                    </a>
                    .
                  </p>
                </div>
              </div>
              {statusIsInternal ? (
                <Link to={statusUrl} className="w-full sm:w-auto">
                  <Button variant="secondary" size="md" className="w-full sm:w-auto">
                    Status &amp; subscribe
                  </Button>
                </Link>
              ) : (
                <a href={statusUrl} target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto">
                  <Button variant="secondary" size="md" className="w-full sm:w-auto">
                    Status &amp; subscribe
                  </Button>
                </a>
              )}
            </Card>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
