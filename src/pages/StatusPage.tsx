import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  PhoneCall,
  LayoutDashboard,
  Database,
  MessageSquare,
  Webhook,
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
  Mail,
  Clock,
  AlertTriangle,
  BellRing,
  Loader as Loader2,
  Wrench,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useLiveStatus } from '@/hooks/useLiveStatus';
import { supabase } from '@/lib/supabase';

// ============================================================
// CONTENT — edit this file directly to update the status page
// ============================================================
//
// This is a manually-maintained status page, not one wired up to an
// automated uptime monitor. That's an intentional, honest choice (see
// SecurityPage.tsx for the same philosophy): showing a fabricated "live"
// monitor with numbers nobody is actually measuring would be worse than a
// clearly-labeled page the team updates by hand.
//
// TO REPORT AN INCIDENT:
//   1. Change the affected system's `status` below to 'degraded' or 'outage'.
//   2. Add an entry to the top of INCIDENTS with today's date.
//   3. Once fixed, set the system back to 'operational' and add a
//      "Resolved" update to the same incident entry (see the shape below).
//   4. Optionally flip that day's entry in UPTIME_HISTORY (last item = today)
//      from 'operational' to 'incident' so the 90-day bar reflects it.
//
// TO LOG MAINTENANCE:
//   1. Before it starts, add an entry to the top of MAINTENANCE_LOG with
//      status 'scheduled' and the planned window.
//   2. Once it's done, flip that entry's status to 'completed'.
//
// If you later connect a real monitoring/status provider (Better Uptime,
// Instatus, Statuspage.io, etc.), replace the three constants below with
// data fetched from that provider instead of hand-editing them.

type SystemStatus = 'operational' | 'degraded' | 'outage' | 'maintenance';

interface SystemComponent {
  id: string;
  name: string;
  description: string;
  status: SystemStatus;
  icon: typeof PhoneCall;
}

const SYSTEMS: SystemComponent[] = [
  {
    id: 'voice-ai',
    name: 'Sarah — AI Voice Receptionist',
    description: 'Answering inbound calls, holding natural conversation, and capturing job details 24/7.',
    status: 'operational',
    icon: PhoneCall,
  },
  {
    id: 'call-routing',
    name: 'Call Routing & Escalation',
    description: 'Transferring urgent or emergency calls to your on-call number in real time.',
    status: 'operational',
    icon: ShieldCheck,
  },
  {
    id: 'dashboard',
    name: 'Web Dashboard',
    description: 'Login, Overview, Call History, Jobs board, Calendar, and account settings.',
    status: 'operational',
    icon: LayoutDashboard,
  },
  {
    id: 'crm-sync',
    name: 'Lead & Job Sync',
    description: 'Pushing new leads and jobs captured on calls into your connected CRM.',
    status: 'operational',
    icon: Database,
  },
  {
    id: 'notifications',
    name: 'SMS & Email Notifications',
    description: 'Booking confirmations, missed-call summaries, and emergency alerts.',
    status: 'operational',
    icon: MessageSquare,
  },
  {
    id: 'api',
    name: 'API & Webhooks',
    description: 'Outbound webhooks and API access for custom integrations.',
    status: 'operational',
    icon: Webhook,
  },
];

interface Incident {
  date: string; // e.g. 'Sep 3, 2026'
  title: string;
  impact: 'minor' | 'major';
  status: 'investigating' | 'monitoring' | 'resolved';
  summary: string;
}

// Empty by default — add the most recent incident to the top of this array.
const INCIDENTS: Incident[] = [];

interface MaintenanceEvent {
  date: string; // e.g. 'Sep 20, 2026'
  title: string;
  window: string; // e.g. '11:00 PM – 1:00 AM PT'
  systems: string; // which components were affected
  status: 'scheduled' | 'completed';
  summary: string;
}

// Empty by default — add the next scheduled maintenance to the top of this
// array in advance (status: 'scheduled'), then flip it to 'completed' once
// it's done. Never delete old entries — this is the permanent archive.
const MAINTENANCE_LOG: MaintenanceEvent[] = [];

const MAINTENANCE_STATUS_META: Record<MaintenanceEvent['status'], string> = {
  scheduled: 'text-accent border-accent/25 bg-accent/10',
  completed: 'text-success-500 border-success-500/25 bg-success-500/10',
};

// Last 90 days, oldest first. Defaults to fully operational. Flip an entry
// to 'incident' for any day a real outage or degradation occurred.
const UPTIME_HISTORY: ('operational' | 'incident')[] = Array.from({ length: 90 }, () => 'operational');

// Update this whenever you hand-edit the systems above.
const LAST_UPDATED = 'September 6, 2026';

const STATUS_META: Record<SystemStatus, { label: string; dot: string; text: string; ring: string }> = {
  operational: { label: 'Operational', dot: 'bg-success-500', text: 'text-success-500', ring: 'border-success-500/25 bg-success-500/10' },
  degraded: { label: 'Degraded performance', dot: 'bg-warning-500', text: 'text-warning-500', ring: 'border-warning-500/25 bg-warning-500/10' },
  outage: { label: 'Outage', dot: 'bg-danger', text: 'text-danger', ring: 'border-danger/25 bg-danger/10' },
  maintenance: { label: 'Scheduled maintenance', dot: 'bg-accent', text: 'text-accent', ring: 'border-accent/25 bg-accent/10' },
};

const INCIDENT_IMPACT_META: Record<Incident['impact'], string> = {
  minor: 'text-warning-500 border-warning-500/25 bg-warning-500/10',
  major: 'text-danger border-danger/25 bg-danger/10',
};

const FAQ_ITEMS = [
  {
    q: 'What counts as an outage for Vireek?',
    a: 'An outage means one of the systems above is unavailable or failing for most users — for example, calls to your Vireek number aren\u2019t being answered, or the dashboard won\u2019t load. Slower-than-usual responses without a full failure are listed as degraded performance instead.',
  },
  {
    q: 'If Sarah goes down, what happens to my calls?',
    a: 'This page tells you when to expect that risk, but your call-forwarding configuration determines the outcome \u2014 most accounts have a fallback number configured under Business Profile so calls still ring through to a human if the AI receptionist is ever unavailable.',
  },
  {
    q: 'Does an incident here affect calls already in progress?',
    a: 'Usually not \u2014 most incidents affect new sessions (new calls, new dashboard logins, or new sync events) rather than conversations already underway. Any incident with broader impact will say so explicitly in its summary.',
  },
  {
    q: 'How do I report a problem that isn\u2019t listed here?',
    a: 'Email us directly and we\u2019ll investigate right away. This page reflects what our team has confirmed \u2014 if something looks wrong on your account before it\u2019s posted here, please still tell us.',
  },
];

const EMAIL = 'ali@vireek.com';

function SEO() {
  useEffect(() => {
    const title = 'System Status | Vireek';
    const description =
      'Live status for Vireek\u2019s AI voice receptionist platform: call answering, dashboard, CRM sync, notifications, and API \u2014 plus uptime history, incident reports, and a maintenance archive.';
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

function overallStatus(systems: SystemComponent[]): SystemStatus {
  if (systems.some((s) => s.status === 'outage')) return 'outage';
  if (systems.some((s) => s.status === 'degraded')) return 'degraded';
  if (systems.some((s) => s.status === 'maintenance')) return 'maintenance';
  return 'operational';
}

const OVERALL_BANNER_COPY: Record<SystemStatus, string> = {
  operational: 'All Systems Operational',
  degraded: 'Some Systems Experiencing Degraded Performance',
  outage: 'Active Outage \u2014 Our Team Is On It',
  maintenance: 'Scheduled Maintenance In Progress',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SubscribeForm() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [wantsSms, setWantsSms] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setStatus('error');
      setErrorMessage('Enter a valid email address.');
      return;
    }

    setStatus('loading');
    setErrorMessage('');
    const { error } = await supabase.from('status_subscribers').insert({
      email: trimmedEmail,
      phone: phone.trim() || null,
      notify_sms: wantsSms && !!phone.trim(),
    });

    if (error) {
      if (error.code === '23505') {
        setStatus('success');
      } else {
        setStatus('error');
        setErrorMessage('Could not subscribe right now. Please try again.');
      }
      return;
    }
    setStatus('success');
  };

  if (status === 'success') {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-success-500/25 bg-success-500/10 px-6 py-5">
        <CheckCircle2 className="h-6 w-6 shrink-0 text-success-500" />
        <p className="text-sm font-medium text-text-primary">
          You&rsquo;re subscribed — we&rsquo;ll email you the moment something changes.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Email address"
          className="focus-ring w-full flex-1 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary/60"
        />
        <Button type="submit" variant="primary" disabled={status === 'loading'} className="shrink-0 gap-2">
          {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}
          Subscribe
        </Button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (optional — for SMS, coming soon)"
          aria-label="Phone number, optional"
          className="focus-ring w-full flex-1 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60"
        />
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={wantsSms}
            onChange={(e) => setWantsSms(e.target.checked)}
            className="h-4 w-4 rounded border-border text-accent focus-ring"
          />
          Text me when SMS launches
        </label>
      </div>
      {status === 'error' && <p className="text-xs font-medium text-danger">{errorMessage}</p>}
      <p className="text-xs text-text-secondary/60">
        Email alerts are live today. Unsubscribe any time from a link in every email.
      </p>
    </form>
  );
}

export function StatusPage() {
  const live = useLiveStatus();

  const effectiveSystems = useMemo(
    () =>
      SYSTEMS.map((s) => ({
        ...s,
        status: live.isLive && live.componentStatus[s.name] ? live.componentStatus[s.name] : s.status,
      })),
    [live.isLive, live.componentStatus]
  );

  const overall = useMemo(() => overallStatus(effectiveSystems), [effectiveSystems]);
  const overallMeta = STATUS_META[overall];

  const uptimePercent = useMemo(() => {
    if (live.isLive && live.uptimePercent !== null) return live.uptimePercent.toFixed(2);
    const operationalDays = UPTIME_HISTORY.filter((d) => d === 'operational').length;
    return ((operationalDays / UPTIME_HISTORY.length) * 100).toFixed(2);
  }, [live.isLive, live.uptimePercent]);

  const effectiveIncidents = live.isLive && live.incidents.length > 0 ? live.incidents : INCIDENTS;
  const effectiveLastUpdated = live.isLive && live.lastUpdated ? live.lastUpdated : LAST_UPDATED;

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <ShieldCheck className="h-4 w-4 text-accent" />
                Vireek Status
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Vireek System Status
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                Real-time status and uptime history for Sarah, your AI voice receptionist, and every
                system your business relies on.
              </p>
            </motion.div>

            {/* Overall status banner */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className={`mx-auto mt-10 flex max-w-xl items-center justify-center gap-3 rounded-2xl border px-6 py-5 shadow-card ${overallMeta.ring}`}
            >
              <span className="relative flex h-3 w-3">
                {overall === 'operational' && (
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${overallMeta.dot}`} />
                )}
                <span className={`relative inline-flex h-3 w-3 rounded-full ${overallMeta.dot}`} />
              </span>
              <span className={`text-base font-bold sm:text-lg ${overallMeta.text}`}>
                {OVERALL_BANNER_COPY[overall]}
              </span>
            </motion.div>
            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-text-secondary/70">
              <Clock className="h-3.5 w-3.5" />
              Last updated {effectiveLastUpdated}
            </p>
          </div>
        </section>

        {/* Subscribe to updates */}
        <section className="px-6 pb-4">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto max-w-2xl rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark sm:p-8"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <BellRing size={18} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-text-primary">Subscribe to updates</h2>
                <p className="mt-0.5 text-sm text-text-secondary">
                  Get an email the moment we post an incident here — no need to keep refreshing.
                </p>
              </div>
            </div>
            <div className="mt-5">
              <SubscribeForm />
            </div>
          </motion.div>
        </section>

        {/* System components */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <p className={`${eyebrowClass()} text-center`}>Component Status</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Every part of the platform, at a glance</h2>
            <div className="mt-12 grid gap-6 sm:grid-cols-2">
              {effectiveSystems.map(({ id, name, description, status, icon: Icon }, i) => {
                const meta = STATUS_META[status];
                return (
                  <motion.div
                    key={id}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.06, 0.24) }}
                  >
                    <Card className="flex h-full items-start gap-4">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                        <Icon size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-base font-semibold text-text-primary">{name}</h3>
                          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${meta.ring} ${meta.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-text-secondary">{description}</p>
                      </div>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Uptime history */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Uptime</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Last 90 days</h2>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mt-10 rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-text-primary">Overall platform uptime</span>
                <span className="text-2xl font-extrabold tracking-tight text-success-500">{uptimePercent}%</span>
              </div>
              <div className="mt-5 flex h-10 items-end gap-[3px]" role="img" aria-label={`Uptime history for the last ${UPTIME_HISTORY.length} days`}>
                {UPTIME_HISTORY.map((day, i) => (
                  <span
                    key={i}
                    title={day === 'operational' ? 'Operational' : 'Incident reported'}
                    className={`h-full flex-1 rounded-sm ${day === 'operational' ? 'bg-success-500/70' : 'bg-danger'}`}
                  />
                ))}
              </div>
              <div className="mt-3 flex justify-between text-xs text-text-secondary/70">
                <span>90 days ago</span>
                <span>Today</span>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Incident history */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Incident History</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Past incidents & maintenance</h2>

            {effectiveIncidents.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="mt-10 flex flex-col items-center gap-3 rounded-2xl border border-success-500/25 bg-success-500/10 px-6 py-10 text-center"
              >
                <CheckCircle2 className="h-8 w-8 text-success-500" />
                <p className="text-base font-semibold text-text-primary">
                  No incidents reported in the last 90 days.
                </p>
                <p className="max-w-md text-sm leading-relaxed text-text-secondary">
                  When something does go wrong, we\u2019ll post it here with a plain-language summary
                  and what we did to fix it \u2014 not just a green checkmark.
                </p>
              </motion.div>
            ) : (
              <div className="mt-10 space-y-4">
                {effectiveIncidents.map((incident, i) => (
                  <motion.div
                    key={`${incident.date}-${i}`}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.06, 0.24) }}
                    className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className={`h-4 w-4 ${INCIDENT_IMPACT_META[incident.impact].split(' ')[0]}`} />
                        <h3 className="text-base font-semibold text-text-primary">{incident.title}</h3>
                      </div>
                      <span className="text-xs font-medium text-text-secondary/70">{incident.date}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${INCIDENT_IMPACT_META[incident.impact]}`}>
                        {incident.impact === 'major' ? 'Major impact' : 'Minor impact'}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium capitalize text-text-secondary">
                        {incident.status}
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{incident.summary}</p>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Maintenance Archive */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Maintenance</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Scheduled maintenance archive</h2>

            {MAINTENANCE_LOG.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="mt-10 flex flex-col items-center gap-3 rounded-2xl border border-border bg-bg-secondary/50 px-6 py-10 text-center"
              >
                <Wrench className="h-8 w-8 text-text-secondary" />
                <p className="text-base font-semibold text-text-primary">
                  No maintenance windows scheduled or completed yet.
                </p>
                <p className="max-w-md text-sm leading-relaxed text-text-secondary">
                  When we schedule planned maintenance, it&rsquo;ll be listed here in advance with
                  the exact window and affected systems, then marked complete once it&rsquo;s done.
                </p>
              </motion.div>
            ) : (
              <div className="mt-10 space-y-4">
                {MAINTENANCE_LOG.map((m, i) => (
                  <motion.div
                    key={`${m.date}-${i}`}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.06, 0.24) }}
                    className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Wrench className="h-4 w-4 text-accent" />
                        <h3 className="text-base font-semibold text-text-primary">{m.title}</h3>
                      </div>
                      <span className="text-xs font-medium text-text-secondary/70">{m.date}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${MAINTENANCE_STATUS_META[m.status]}`}
                      >
                        {m.status}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-text-secondary">
                        <Clock className="h-3 w-3" /> {m.window}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-text-secondary">
                        {m.systems}
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{m.summary}</p>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </section>
        {/* FAQ */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Common Questions</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Status page FAQ</h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {FAQ_ITEMS.map(({ q, a }, i) => (
                <motion.div
                  key={q}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.06, 0.24) }}
                  className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark"
                >
                  <h3 className="text-sm font-semibold text-text-primary">{q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{a}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Something look wrong?</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Tell us before it costs you a call.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              If your account is behaving differently than what\u2019s posted here, reach out and
              we\u2019ll take a look right away.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a href={`mailto:${EMAIL}`}>
                <Button variant="primary" size="lg">
                  <Mail className="h-4 w-4" /> Email Support
                </Button>
              </a>
              <Link to="/contact">
                <Button variant="secondary" size="lg">
                  Contact Us <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
