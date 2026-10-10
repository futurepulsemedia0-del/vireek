import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Download,
  Mail,
  MapPin,
  PlayCircle,
  RefreshCw,
  Users,
  Video,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { BackButton } from '@/components/ui/BackButton';
import { Skeleton } from '@/components/Skeleton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import {
  EVENT_KIND_LABELS,
  REGISTER_FAILURE_MESSAGES,
  buildEventIcs,
  buildEventsJsonLd,
  buildGoogleCalendarUrl,
  eventLocationLabel,
  fetchPublicEvents,
  filterByKind,
  formatEventWhen,
  getEventDayBadge,
  getEventPageUrl,
  groupEventsByMonth,
  registerForEvent,
  spotsLabel,
  splitEvents,
  subscribeToEventUpdates,
  validateRegistration,
  type EventKind,
  type EventsResult,
  type PublicEvent,
  type RegistrationErrors,
  type RegistrationValues,
} from '@/lib/events';

// ============================================================
// Public events & webinars calendar — /events
//
// Sessions come from the public_events table (published rows only), so
// nothing appears here until a real session is scheduled — same honesty
// standard as WebinarsPage.tsx. With no sessions the page shows a clean
// "notify me" state. Registration goes through the event-register edge
// function, which also emails the confirmation.
// ============================================================

interface RegisteredInfo {
  email: string;
  joinUrl: string | null;
  alreadyRegistered: boolean;
  emailSent: boolean;
}

type View = 'upcoming' | 'past';

function EventsSEO({ events }: { events: PublicEvent[] }) {
  const jsonLd = useMemo(() => buildEventsJsonLd(events), [events]);
  useSEO({
    title: 'Events & Webinars Calendar — Vireek',
    description:
      'Upcoming live demos, webinars, and workshops from the Vireek team — free to join. Register in seconds and add the session to your calendar.',
    canonical: 'https://vireek.com/events',
    jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
  });
  return null;
}

function downloadIcs(event: PublicEvent, joinUrl: string | null) {
  const ics = buildEventIcs(event, getEventPageUrl(event.slug), new Date(), joinUrl);
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${event.slug}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CalendarActions({ event, joinUrl }: { event: PublicEvent; joinUrl: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <a
        href={buildGoogleCalendarUrl(event, getEventPageUrl(event.slug), joinUrl)}
        target="_blank"
        rel="noopener noreferrer"
        className="focus-ring inline-flex items-center gap-1.5 rounded-lg py-1 font-medium text-accent hover:underline"
      >
        <CalendarPlus size={15} aria-hidden /> Google Calendar
      </a>
      <button
        type="button"
        onClick={() => downloadIcs(event, joinUrl)}
        className="focus-ring inline-flex items-center gap-1.5 rounded-lg py-1 font-medium text-accent hover:underline"
      >
        <Download size={15} aria-hidden /> Apple / Outlook (.ics)
      </button>
    </div>
  );
}

function RegistrationForm({ event, onRegistered }: { event: PublicEvent; onRegistered: (info: RegisteredInfo) => void }) {
  const [values, setValues] = useState<RegistrationValues>({ name: '', email: '', marketingOptIn: false });
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [honeypot, setHoneypot] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const setField = (field: 'name' | 'email') => (e: ChangeEvent<HTMLInputElement>) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateRegistration(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    setFormError(null);
    const res = await registerForEvent(event.slug, values, honeypot);
    setSubmitting(false);
    if (res.ok) {
      onRegistered({ email: values.email.trim(), joinUrl: res.joinUrl, alreadyRegistered: res.alreadyRegistered, emailSent: res.emailSent });
      return;
    }
    setFormError(REGISTER_FAILURE_MESSAGES[res.reason]);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="mt-5 space-y-4 border-t border-border/70 pt-5" aria-label={`Register for ${event.title}`}>
      <Input label="Full name" name="name" autoComplete="name" required value={values.name} onChange={setField('name')} error={errors.name} disabled={submitting} />
      <Input label="Email" name="email" type="email" inputMode="email" autoComplete="email" required value={values.email} onChange={setField('email')} error={errors.email} disabled={submitting} />
      <label className="flex items-start gap-3 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={values.marketingOptIn}
          onChange={(e) => setValues((prev) => ({ ...prev, marketingOptIn: e.target.checked }))}
          disabled={submitting}
          className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border accent-accent"
        />
        <span>Send me occasional product updates from Vireek (optional)</span>
      </label>
      {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
      <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </label>
      </div>

      {formError && (
        <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
          {formError}
        </p>
      )}

      <Button type="submit" size="md" className="w-full sm:w-auto" disabled={submitting}>
        {submitting ? 'Registering…' : 'Confirm registration'}
      </Button>
      <p className="text-xs leading-relaxed text-text-secondary">
        Free. We'll email your confirmation and a calendar link. See our{' '}
        <Link to="/privacy" className="underline hover:text-text-primary">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  );
}

function RegisteredPanel({ event, info }: { event: PublicEvent; info: RegisteredInfo }) {
  return (
    <div className="mt-5 space-y-4 border-t border-border/70 pt-5" role="status">
      <p className="flex items-start gap-2 text-sm font-semibold text-success">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden />
        <span>{info.alreadyRegistered ? "You're already registered for this session." : "You're registered!"}</span>
      </p>
      <p className="text-sm leading-relaxed text-text-secondary">
        {info.alreadyRegistered
          ? "We didn't send another email — check your inbox for the original confirmation."
          : info.emailSent
            ? `We sent a confirmation to ${info.email}.`
            : "Your spot is saved. We couldn't send the confirmation email, so use the buttons below to keep the details."}
      </p>
      {info.joinUrl && (
        <a href={info.joinUrl} target="_blank" rel="noopener noreferrer" className="inline-block">
          <Button variant="primary" size="sm">
            Open join link <ArrowRight size={16} aria-hidden />
          </Button>
        </a>
      )}
      <CalendarActions event={event} joinUrl={info.joinUrl} />
    </div>
  );
}

interface EventCardProps {
  event: PublicEvent;
  open: boolean;
  registered: RegisteredInfo | undefined;
  onToggle: (slug: string) => void;
  onRegistered: (slug: string, info: RegisteredInfo) => void;
}

function EventCard({ event, open, registered, onToggle, onRegistered }: EventCardProps) {
  const badge = getEventDayBadge(event.starts_at);
  const status = spotsLabel(event.registration_status, event.spots_left);
  const isPast = event.registration_status === 'ended';
  const canRegister = event.registration_status === 'open';
  const panelId = `register-${event.slug}`;

  return (
    <div id={`event-${event.slug}`} className="scroll-mt-28">
      <Card className="!p-5 hover:!translate-y-0 sm:!p-6">
        <div className="flex gap-4">
          <div
            className="flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"
            aria-hidden="true"
          >
            <span className="text-[11px] font-semibold tracking-wide">{badge.month}</span>
            <span className="text-2xl font-bold leading-none">{badge.day}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">{EVENT_KIND_LABELS[event.kind]}</span>
              {status && (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    event.registration_status === 'open' ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'
                  }`}
                >
                  {status}
                </span>
              )}
            </div>
            <h3 className="mt-2 break-words text-lg font-semibold text-text-primary">{event.title}</h3>
            <div className="mt-2 space-y-1.5 text-sm text-text-secondary">
              <p className="flex items-start gap-1.5">
                <Clock size={15} className="mt-0.5 shrink-0" aria-hidden /> <span>{formatEventWhen(event.starts_at, event.ends_at)}</span>
              </p>
              <p className="flex items-start gap-1.5">
                <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden /> <span className="break-words">{eventLocationLabel(event)}</span>
              </p>
              {event.host_name && (
                <p className="flex items-start gap-1.5">
                  <Users size={15} className="mt-0.5 shrink-0" aria-hidden /> <span className="break-words">Hosted by {event.host_name}</span>
                </p>
              )}
            </div>
          </div>
        </div>

        {event.description && <p className="mt-4 text-sm leading-relaxed text-text-secondary">{event.description}</p>}

        {isPast ? (
          event.recording_url && (
            <a href={event.recording_url} target="_blank" rel="noopener noreferrer" className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-lg py-1 text-sm font-semibold text-accent hover:underline">
              <PlayCircle size={16} aria-hidden /> Watch recording <ArrowRight size={14} aria-hidden />
            </a>
          )
        ) : registered ? (
          <RegisteredPanel event={event} info={registered} />
        ) : (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
              {canRegister && (
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full sm:w-auto"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => onToggle(event.slug)}
                >
                  {open ? 'Hide form' : 'Register free'} {!open && <ArrowRight size={16} aria-hidden />}
                </Button>
              )}
              <CalendarActions event={event} joinUrl={null} />
            </div>
            {canRegister && open && (
              <div id={panelId}>
                <RegistrationForm event={event} onRegistered={(info) => onRegistered(event.slug, info)} />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function NotifyForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error' | 'invalid'>('idle');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'loading' || state === 'success') return;
    setState('loading');
    const outcome = await subscribeToEventUpdates(email);
    if (outcome === 'ok') {
      setState('success');
      setEmail('');
    } else {
      setState(outcome);
    }
  };

  if (state === 'success') {
    return (
      <p role="status" className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
        <CheckCircle2 size={18} aria-hidden /> You're on the list — we'll email you when the next session is up.
      </p>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="mx-auto flex max-w-md flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1">
        <Input
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          aria-label="Email address"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state === 'invalid' || state === 'error') setState('idle');
          }}
          error={state === 'invalid' ? 'Enter a valid email address.' : state === 'error' ? "Something went wrong. Please try again." : undefined}
          disabled={state === 'loading'}
        />
      </div>
      <Button type="submit" variant="primary" size="md" disabled={state === 'loading'}>
        {state === 'loading' ? 'Sending…' : 'Notify me'}
      </Button>
    </form>
  );
}

export function EventsPage() {
  const [searchParams] = useSearchParams();
  const focusSlug = searchParams.get('event');
  const [result, setResult] = useState<EventsResult | undefined>(undefined);
  const [view, setView] = useState<View>('upcoming');
  const [kind, setKind] = useState<EventKind | 'all'>('all');
  const [openSlug, setOpenSlug] = useState<string | null>(focusSlug);
  const [registered, setRegistered] = useState<Record<string, RegisteredInfo>>({});
  const focused = useRef(false);

  const load = useCallback(async () => {
    setResult(await fetchPublicEvents());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const events = useMemo(() => (result?.state === 'ok' ? result.events : []), [result]);
  const { upcoming, past } = useMemo(() => splitEvents(events), [events]);

  // Deep link (?event=slug): show the right tab once, then scroll the card into view.
  useEffect(() => {
    if (!focusSlug || focused.current || result?.state !== 'ok') return;
    focused.current = true;
    if (past.some((e) => e.slug === focusSlug)) setView('past');
    const id = window.setTimeout(() => document.getElementById(`event-${focusSlug}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
    return () => window.clearTimeout(id);
  }, [focusSlug, result, past]);

  const list = view === 'upcoming' ? upcoming : past;
  const kinds = useMemo(() => Array.from(new Set(list.map((e) => e.kind))), [list]);
  const groups = useMemo(() => groupEventsByMonth(filterByKind(list, kind)), [list, kind]);

  const changeView = (next: View) => {
    setView(next);
    setKind('all');
  };

  const segment = (active: boolean) =>
    `focus-ring min-h-[44px] flex-1 rounded-full px-5 text-sm font-semibold transition-colors sm:flex-none ${
      active ? 'bg-accent text-white shadow-sm' : 'text-text-secondary hover:text-text-primary'
    }`;

  const chip = (active: boolean) =>
    `focus-ring min-h-[40px] shrink-0 rounded-full border px-4 text-sm font-medium transition-colors ${
      active ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40'
    }`;

  return (
    <>
      <EventsSEO events={events} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }} className="text-center">
              <p className={eyebrowClass()}>Events & Webinars</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">Join a live session with the Vireek team</h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Live demos, workshops, and Q&A — free to join. Pick a session, register in seconds, and add it to your calendar.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Calendar */}
        <section id="calendar" className="scroll-mt-24 px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-3xl">
            {result === undefined && (
              <div className="space-y-4" aria-busy="true" aria-label="Loading events">
                {[0, 1].map((i) => (
                  <Card key={i} className="!p-5 hover:!translate-y-0 sm:!p-6">
                    <div className="flex gap-4">
                      <Skeleton className="h-16 w-14 rounded-xl" />
                      <div className="flex-1 space-y-2.5">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-5 w-3/4" />
                        <Skeleton className="h-4 w-1/2" />
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {result?.state === 'error' && (
              <Card className="text-center hover:!translate-y-0">
                <AlertCircle size={28} className="mx-auto mb-3 text-danger" aria-hidden />
                <h2 className="text-lg font-semibold text-text-primary">We couldn't load the calendar</h2>
                <p className={`${bodyClass()} mt-2`}>Check your connection and try again.</p>
                <Button
                  className="mt-5"
                  variant="secondary"
                  onClick={() => {
                    setResult(undefined);
                    void load();
                  }}
                >
                  <RefreshCw size={16} aria-hidden /> Try again
                </Button>
              </Card>
            )}

            {result?.state === 'ok' && (
              <>
                <div className="flex flex-col gap-4">
                  <div className="flex rounded-full border border-border bg-bg-secondary p-1 sm:inline-flex sm:self-start" role="group" aria-label="Show sessions">
                    <button type="button" className={segment(view === 'upcoming')} aria-pressed={view === 'upcoming'} onClick={() => changeView('upcoming')}>
                      Upcoming{upcoming.length > 0 ? ` (${upcoming.length})` : ''}
                    </button>
                    <button type="button" className={segment(view === 'past')} aria-pressed={view === 'past'} onClick={() => changeView('past')}>
                      Past sessions
                    </button>
                  </div>
                  {kinds.length > 1 && (
                    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="group" aria-label="Filter by type">
                      <button type="button" className={chip(kind === 'all')} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
                        All
                      </button>
                      {kinds.map((k) => (
                        <button key={k} type="button" className={chip(kind === k)} aria-pressed={kind === k} onClick={() => setKind(k)}>
                          {EVENT_KIND_LABELS[k]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {groups.length > 0 ? (
                  <div className="mt-8 space-y-10">
                    {groups.map((group) => (
                      <div key={group.key}>
                        <h2 className={`${sectionHeadingClass()} !text-xl sm:!text-2xl`}>{group.label}</h2>
                        <div className="mt-4 space-y-4">
                          {group.events.map((event) => (
                            <EventCard
                              key={event.slug}
                              event={event}
                              open={openSlug === event.slug}
                              registered={registered[event.slug]}
                              onToggle={(slug) => setOpenSlug((current) => (current === slug ? null : slug))}
                              onRegistered={(slug, info) => setRegistered((prev) => ({ ...prev, [slug]: info }))}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : view === 'upcoming' && upcoming.length === 0 ? (
                  <motion.div initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE }} className="mt-10">
                    <Card className="text-center hover:!translate-y-0">
                      <Mail className="mx-auto h-9 w-9 text-accent" aria-hidden />
                      <h2 className="mt-4 text-lg font-semibold text-text-primary">No live session on the calendar right now</h2>
                      <p className={`${bodyClass()} mt-2`}>Leave your email and we'll let you know the moment the next one is scheduled — no spam, just a heads-up.</p>
                      <div className="mt-6">
                        <NotifyForm />
                      </div>
                    </Card>
                  </motion.div>
                ) : (
                  <p className="mt-10 text-center text-sm text-text-secondary">
                    {view === 'past' && past.length === 0 ? 'Recordings will appear here after the first live session.' : 'No sessions match this filter.'}
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 pb-16 md:pb-20">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-14 text-center shadow-glow-accent md:px-16 md:py-20"
          >
            <div className="relative">
              <Video className="mx-auto h-10 w-10 text-white/90" aria-hidden />
              <h2 className="mt-5 text-balance text-3xl font-bold leading-[1.15] tracking-tight text-white md:text-5xl">Prefer a 1-on-1 walkthrough?</h2>
              <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-white/85 md:text-lg">Skip the group session and book a live demo with our team on your schedule.</p>
              <div className="mt-9 flex justify-center">
                <a href="/demo">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Book a demo <ArrowRight size={18} aria-hidden />
                  </Button>
                </a>
              </div>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
