import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CalendarClock, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { fetchBookedWindow, fetchBookingBusiness, generateAvailableSlots } from '@/lib/onlineBooking';
import {
  fetchPublicLandingPage,
  loadStoredAttribution,
  storeAttribution,
  submitLandingBooking,
  submitLandingLead,
  trackLandingEvent,
} from '@/lib/landingPages';
import type { PublicLandingPageData } from '@/lib/landingPages';
import {
  hasAttribution,
  parseAttributionFromSearch,
  readableTextColor,
  resolveAttribution,
  sanitizeReferrer,
} from '@/lib/landingPageUtils';
import type { Attribution, SubmitFailure } from '@/lib/landingPageUtils';

const FAILURE_COPY: Record<SubmitFailure, string> = {
  slot_taken: 'That time was just taken — please pick another.',
  too_soon: 'That time is too soon. Please choose a later slot.',
  unavailable: 'Online requests are unavailable right now. Please call the business directly.',
  rate_limited: 'Too many requests — please wait a few minutes and try again.',
  invalid_contact: 'Please check your name and contact details.',
  unknown: 'Something went wrong. Please try again.',
};

const selectCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'missing' }
  | { kind: 'ready'; page: PublicLandingPageData };

type Mode = 'lead' | 'booking';

function formatSlotTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function PublicLandingPage({ host }: { host?: string }) {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const [mode, setMode] = useState<Mode>('lead');
  const [form, setForm] = useState({ name: '', phone: '', email: '', service: '', message: '', website: '' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<Mode | null>(null);

  const [booking, setBooking] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; slots: Date[] }>({
    status: 'idle',
    slots: [],
  });
  const [slotsKey, setSlotsKey] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<Date | null>(null);

  const formRef = useRef<HTMLDivElement>(null);
  const attributionRef = useRef<Attribution>({});
  const viewTrackedFor = useRef<string | null>(null);
  const ctaTracked = useRef(false);

  const page = state.kind === 'ready' ? state.page : null;
  const bookingSlug = page?.booking_slug ?? null;
  const canBook = !!bookingSlug && !!page && page.cta_mode !== 'lead_form';
  const canLead = !!page && (page.cta_mode !== 'booking' || !canBook);

  // Load the page (by custom-domain host, or by slug).
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const data = await fetchPublicLandingPage({ slug, host });
        if (cancelled) return;
        setState(data ? { kind: 'ready', page: data } : { kind: 'missing' });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, host, reloadKey]);

  // Initial form mode + default service once the page is known.
  useEffect(() => {
    if (!page) return;
    setMode(canBook && page.cta_mode === 'booking' ? 'booking' : 'lead');
    setForm((f) => ({ ...f, service: page.services_offered?.[0] ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id]);

  // Attribution capture + one page view per page load.
  useEffect(() => {
    if (!page) return;
    const current: Attribution = parseAttributionFromSearch(window.location.search);
    const referrer = sanitizeReferrer(document.referrer, window.location.hostname);
    if (referrer) current.referrer = referrer;
    const resolved = resolveAttribution(current, loadStoredAttribution(page.id));
    if (hasAttribution(current)) storeAttribution(page.id, current);
    attributionRef.current = resolved;

    if (viewTrackedFor.current !== page.id) {
      viewTrackedFor.current = page.id;
      void trackLandingEvent({ pageId: page.id, type: 'view', attribution: resolved });
    }
  }, [page]);

  // SEO: title + meta description (restored on unmount).
  useEffect(() => {
    if (!page) return;
    const previousTitle = document.title;
    document.title = page.seo_title || page.headline;

    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.appendChild(meta);
    }
    const el = meta;
    const previousDescription = el.content;
    el.content = page.seo_description || page.subheadline || '';

    return () => {
      document.title = previousTitle;
      if (created) el.remove();
      else el.content = previousDescription;
    };
  }, [page]);

  // Lazy-load real availability only when the booking tab is open.
  useEffect(() => {
    if (mode !== 'booking' || !bookingSlug) return;
    let cancelled = false;
    setBooking({ status: 'loading', slots: [] });
    (async () => {
      try {
        const info = await fetchBookingBusiness(bookingSlug);
        if (!info || !info.booking_enabled) {
          if (!cancelled) setBooking({ status: 'error', slots: [] });
          return;
        }
        const now = new Date();
        const later = new Date(now.getTime() + info.window_days * 24 * 60 * 60 * 1000);
        const booked = await fetchBookedWindow(bookingSlug, now, later);
        if (!cancelled) setBooking({ status: 'ready', slots: generateAvailableSlots(info, booked, now) });
      } catch {
        if (!cancelled) setBooking({ status: 'error', slots: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, bookingSlug, slotsKey]);

  const slotGroups = useMemo(() => {
    const groups = new Map<string, Date[]>();
    for (const slot of booking.slots) {
      const key = slot.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const list = groups.get(key);
      if (list) list.push(slot);
      else groups.set(key, [slot]);
    }
    return Array.from(groups.entries());
  }, [booking.slots]);

  const setField = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleCta = () => {
    if (!page) return;
    if (!ctaTracked.current) {
      ctaTracked.current = true;
      void trackLandingEvent({ pageId: page.id, type: 'cta_click', attribution: attributionRef.current });
    }
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleLeadSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!page || submitting) return;
    setFormError(null);
    if (form.website.trim()) {
      // Honeypot filled: pretend success, send nothing.
      setDone('lead');
      return;
    }
    if (form.name.trim().length < 2) {
      setFormError('Please enter your name.');
      return;
    }
    if (!form.phone.trim() && !form.email.trim()) {
      setFormError('Please add a phone number or email so we can reach you.');
      return;
    }
    setSubmitting(true);
    const result = await submitLandingLead({
      pageId: page.id,
      name: form.name,
      phone: form.phone,
      email: form.email,
      service: form.service,
      message: form.message,
      attribution: attributionRef.current,
    });
    setSubmitting(false);
    if (result.ok) setDone('lead');
    else setFormError(FAILURE_COPY[result.reason]);
  };

  const handleBookingSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!page || submitting) return;
    setFormError(null);
    if (form.website.trim()) {
      setDone('booking');
      return;
    }
    if (!selectedSlot) {
      setFormError('Please choose a time.');
      return;
    }
    if (form.name.trim().length < 2) {
      setFormError('Please enter your name.');
      return;
    }
    if (!form.phone.trim() && !form.email.trim()) {
      setFormError('Please add a phone number or email so we can confirm your booking.');
      return;
    }
    setSubmitting(true);
    const result = await submitLandingBooking({
      pageId: page.id,
      name: form.name,
      phone: form.phone,
      email: form.email,
      service: form.service,
      scheduledDatetime: selectedSlot,
      notes: form.message,
      attribution: attributionRef.current,
    });
    setSubmitting(false);
    if (result.ok) {
      setDone('booking');
      return;
    }
    setFormError(FAILURE_COPY[result.reason]);
    if (result.reason === 'slot_taken' || result.reason === 'too_soon') {
      setSelectedSlot(null);
      setSlotsKey((k) => k + 1);
    }
  };

  // ---------------- states ----------------

  if (state.kind === 'loading') {
    return (
      <div className="min-h-screen bg-bg-primary px-5 py-16">
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-6 h-12 w-48" />
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary px-5">
        <div className="max-w-sm text-center">
          <AlertCircle className="mx-auto text-danger" size={32} aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-text-primary">We couldn't load this page</h1>
          <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
          <Button className="mt-5" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'missing' || !page) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary px-5">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-text-primary">This page isn't available</h1>
          <p className="mt-1 text-sm text-text-secondary">
            The link may be incorrect, or the page has been unpublished.
          </p>
        </div>
      </div>
    );
  }

  const accentStyle = { backgroundColor: page.accent_color, color: readableTextColor(page.accent_color) };
  const services = page.services_offered ?? [];

  return (
    <div className="min-h-screen bg-bg-primary pb-24 text-text-primary md:pb-0">
      <main>
        <section className="mx-auto max-w-3xl px-5 pb-10 pt-14 sm:pt-20">
          {page.business_name && (
            <p className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{page.business_name}</p>
          )}
          <h1 className="mt-3 text-4xl font-bold leading-tight sm:text-5xl">{page.headline}</h1>
          {page.subheadline && (
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{page.subheadline}</p>
          )}
          <Button size="lg" className="mt-8" style={accentStyle} onClick={handleCta}>
            {page.cta_label}
          </Button>
          {page.body && (
            <p className="mt-10 whitespace-pre-line text-base leading-relaxed text-text-secondary">{page.body}</p>
          )}
        </section>

        {page.sections.length > 0 && (
          <section className="mx-auto grid max-w-3xl gap-4 px-5 pb-10 sm:grid-cols-2">
            {page.sections.map((s, i) => (
              <div key={`${s.title}-${i}`} className="rounded-2xl border border-border bg-bg-secondary p-5">
                {s.title && <h2 className="text-base font-semibold">{s.title}</h2>}
                {s.body && <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{s.body}</p>}
              </div>
            ))}
          </section>
        )}

        <section ref={formRef} className="mx-auto max-w-3xl scroll-mt-6 px-5 pb-16">
          <div className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-8">
            {done ? (
              <div className="py-6 text-center" role="status">
                <CheckCircle2 className="mx-auto text-success" size={40} aria-hidden="true" />
                <h2 className="mt-3 text-xl font-semibold">
                  {done === 'booking' ? "You're booked!" : 'Thanks — we got your request'}
                </h2>
                <p className="mt-1.5 text-sm text-text-secondary">
                  {done === 'booking' && selectedSlot
                    ? `We'll see you ${selectedSlot.toLocaleString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}.`
                    : "We'll be in touch shortly."}
                </p>
              </div>
            ) : (
              <>
                {canBook && canLead && (
                  <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-bg-tertiary p-1" role="tablist">
                    {(['lead', 'booking'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={mode === m}
                        onClick={() => {
                          setMode(m);
                          setFormError(null);
                        }}
                        className={`focus-ring rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                          mode === m ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary'
                        }`}
                      >
                        {m === 'lead' ? 'Request a call' : 'Book a time'}
                      </button>
                    ))}
                  </div>
                )}

                <form
                  onSubmit={mode === 'booking' ? handleBookingSubmit : handleLeadSubmit}
                  noValidate
                  className="space-y-4"
                >
                  {mode === 'booking' && (
                    <fieldset>
                      <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
                        <CalendarClock size={16} aria-hidden="true" /> Choose a time
                      </legend>
                      {booking.status === 'loading' && <Skeleton className="h-28 w-full" />}
                      {booking.status === 'error' && (
                        <div className="rounded-xl bg-bg-tertiary p-4 text-sm text-text-secondary">
                          Availability couldn't be loaded.{' '}
                          <button
                            type="button"
                            className="font-semibold text-accent hover:underline"
                            onClick={() => setSlotsKey((k) => k + 1)}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {booking.status === 'ready' && slotGroups.length === 0 && (
                        <p className="rounded-xl bg-bg-tertiary p-4 text-sm text-text-secondary">
                          Online times are fully booked right now — please send a request instead.
                        </p>
                      )}
                      {booking.status === 'ready' && slotGroups.length > 0 && (
                        <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                          {slotGroups.map(([day, slots]) => (
                            <div key={day}>
                              <p className="mb-1.5 text-xs font-semibold text-text-secondary">{day}</p>
                              <div className="flex flex-wrap gap-2">
                                {slots.map((slot) => {
                                  const active = selectedSlot?.getTime() === slot.getTime();
                                  return (
                                    <button
                                      key={slot.toISOString()}
                                      type="button"
                                      aria-pressed={active}
                                      onClick={() => setSelectedSlot(slot)}
                                      className={`focus-ring min-h-[40px] rounded-lg border px-3 text-sm font-medium transition-colors ${
                                        active
                                          ? 'border-transparent'
                                          : 'border-border bg-bg-primary text-text-primary hover:border-accent/40'
                                      }`}
                                      style={active ? accentStyle : undefined}
                                    >
                                      {formatSlotTime(slot)}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </fieldset>
                  )}

                  <Input label="Your name" required autoComplete="name" value={form.name} onChange={setField('name')} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label="Phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={form.phone}
                      onChange={setField('phone')}
                    />
                    <Input
                      label="Email"
                      type="email"
                      autoComplete="email"
                      value={form.email}
                      onChange={setField('email')}
                    />
                  </div>

                  {services.length > 0 && (
                    <div>
                      <label htmlFor="lp-service" className="mb-1.5 block text-sm font-medium">
                        Service
                      </label>
                      <select id="lp-service" className={selectCls} value={form.service} onChange={setField('service')}>
                        {services.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <Textarea
                    label={mode === 'booking' ? 'Notes (optional)' : 'How can we help? (optional)'}
                    rows={3}
                    value={form.message}
                    onChange={setField('message')}
                  />

                  {/* Honeypot — hidden from people and assistive tech; bots fill it. */}
                  <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
                    <label>
                      Website
                      <input
                        type="text"
                        tabIndex={-1}
                        autoComplete="off"
                        value={form.website}
                        onChange={setField('website')}
                      />
                    </label>
                  </div>

                  {formError && (
                    <p className="flex items-start gap-2 text-sm text-danger" role="alert">
                      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                      {formError}
                    </p>
                  )}

                  <Button type="submit" size="lg" className="w-full" style={accentStyle} disabled={submitting}>
                    {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {mode === 'booking' ? 'Confirm booking' : page.cta_label}
                  </Button>
                </form>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="pb-8 text-center text-xs text-text-secondary">Powered by Vireek</footer>

      {!done && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg-primary/95 p-3 backdrop-blur md:hidden">
          <Button size="md" className="w-full" style={accentStyle} onClick={handleCta}>
            {page.cta_label}
          </Button>
        </div>
      )}
    </div>
  );
}
