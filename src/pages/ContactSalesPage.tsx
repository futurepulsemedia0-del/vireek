import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, CalendarCheck, CheckCircle2, Clock, Loader2, Mail, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { buildDemoBookingIcs, getEnterpriseDemoOpenSlots, type DemoSlot } from '@/lib/enterpriseDemoBooking';
import {
  BEST_TIMES,
  EMPTY_SALES_FORM,
  LIMITS,
  LOCATION_COUNTS,
  LOCATION_LABELS,
  TEAM_SIZES,
  TEAM_SIZE_LABELS,
  buildPayload,
  formatDayChip,
  formatFullSlot,
  formatTime,
  groupSlotsByDay,
  readUtm,
  validateSalesForm,
  type SalesFormErrors,
  type SalesFormValues,
} from '@/lib/contactSales';
import { submitSalesInquiry } from '@/lib/contactSalesApi';

const SALES_EMAIL = 'ali@vireek.com';
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

function SEO() {
  useSEO({
    title: 'Contact Sales — Vireek for Multi-Location Teams',
    description:
      'Talk to the Vireek sales team about AI call answering for larger home-service businesses. Send a request or book a live walkthrough.',
    canonical: 'https://vireek.com/contact-sales',
  });
  return null;
}

function SelectField({
  id,
  label,
  required,
  value,
  error,
  onChange,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-text-primary">
        {label}
        {required && <span className="text-cta"> *</span>}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={selectClass}
      >
        {children}
      </select>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ============================================================
// SLOT PICKER (real calendar: same open-slot source as /demo)
// ============================================================

function SlotPicker({
  value,
  onChange,
  refreshKey,
  disabled,
}: {
  value: Date | null;
  onChange: (slot: Date | null) => void;
  refreshKey: number;
  disabled: boolean;
}) {
  const [slots, setSlots] = useState<DemoSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const start = new Date();
    const end = new Date(start.getTime() + 14 * 86_400_000);
    getEnterpriseDemoOpenSlots(start, end)
      .then((rows) => {
        if (!cancelled) setSlots(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, refreshKey]);

  const days = useMemo(() => groupSlotsByDay(slots).slice(0, 10), [slots]);
  const activeKey = pickedDay && days.some((d) => d.key === pickedDay) ? pickedDay : (days[0]?.key ?? null);
  const activeDay = days.find((d) => d.key === activeKey);

  return (
    <div>
      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading available times">
          <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />
          <div className="h-24 animate-pulse rounded-xl bg-bg-tertiary" />
        </div>
      ) : failed ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-bg-primary p-4 text-sm text-text-secondary">
          <p>We couldn't load the calendar. You can still send your request and we'll email you times.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw size={14} /> Try again
          </Button>
        </div>
      ) : days.length === 0 ? (
        <p className="rounded-xl border border-border bg-bg-primary p-4 text-sm text-text-secondary">
          No open times in the next two weeks. Send your request and we'll find a slot with you.
        </p>
      ) : (
        <>
          <div role="group" aria-label="Choose a day" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
            {days.map((d) => (
              <button
                key={d.key}
                type="button"
                disabled={disabled}
                aria-pressed={activeKey === d.key}
                onClick={() => setPickedDay(d.key)}
                className={`focus-ring shrink-0 rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors ${
                  activeKey === d.key
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-secondary hover:border-accent/40'
                }`}
              >
                {formatDayChip(d.date)}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Choose a time" className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {activeDay?.slots.map((slot) => {
              const selected = value?.getTime() === slot.start.getTime();
              return (
                <button
                  key={slot.start.toISOString()}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() => onChange(selected ? null : slot.start)}
                  className={`focus-ring min-h-11 rounded-xl border px-2 py-2 text-sm font-medium transition-colors ${
                    selected
                      ? 'border-accent bg-accent text-white'
                      : 'border-border text-text-primary hover:border-accent/40'
                  }`}
                >
                  {formatTime(slot.start)}
                </button>
              );
            })}
          </div>
        </>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-text-secondary">
        <Clock size={12} aria-hidden="true" />
        {value ? `Selected: ${formatFullSlot(value)}` : 'Optional. No time selected, so we will reply by email.'} ·{' '}
        {timezone}
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="focus-ring ml-1 font-medium text-accent hover:underline"
          >
            Clear
          </button>
        )}
      </p>
    </div>
  );
}

// ============================================================
// SUCCESS
// ============================================================

function SuccessCard({ booking }: { booking: { start: Date; end: Date } | null }) {
  const downloadIcs = () => {
    if (!booking) return;
    const blob = buildDemoBookingIcs({
      start: booking.start,
      end: booking.end,
      title: 'Vireek enterprise demo',
      description: 'Live walkthrough of Vireek with our sales team.',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vireek-demo.ics';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div role="status" className="flex flex-col items-center py-10 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 text-success">
        {booking ? <CalendarCheck size={36} /> : <CheckCircle2 size={40} />}
      </span>
      <h2 className="mt-6 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
        {booking ? "You're booked" : 'Request received'}
      </h2>
      <p className="mt-3 max-w-md text-base leading-relaxed text-text-secondary">
        {booking
          ? `Your 30-minute walkthrough is set for ${formatFullSlot(booking.start)}. We'll email you the details.`
          : "Thanks for reaching out. Someone from our team will reply within one business day."}
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {booking && (
          <Button type="button" variant="secondary" size="sm" onClick={downloadIcs}>
            <CalendarCheck size={14} /> Add to calendar
          </Button>
        )}
        <Link to="/">
          <Button type="button" variant="ghost" size="sm">
            Back to homepage
          </Button>
        </Link>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ContactSalesPage() {
  const [searchParams] = useSearchParams();
  const utm = useMemo(() => readUtm(searchParams.toString()), [searchParams]);

  const [values, setValues] = useState<SalesFormValues>(EMPTY_SALES_FORM);
  const [errors, setErrors] = useState<SalesFormErrors>({});
  const [slot, setSlot] = useState<Date | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [slotNotice, setSlotNotice] = useState<string | null>(null);
  const [done, setDone] = useState<{ booking: { start: Date; end: Date } | null } | null>(null);

  const set = useCallback(<K extends keyof SalesFormValues>(key: K, value: SalesFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next: Record<string, unknown> = { ...prev };
      delete next[key];
      return next as SalesFormErrors;
    });
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateSalesForm(values);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`sales-${first}`)?.focus();
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setSlotNotice(null);
    const result = await submitSalesInquiry(buildPayload(values, { slotStart: slot, source: 'contact-sales', ...utm }));
    setSubmitting(false);

    if (result.kind === 'ok') {
      setDone({ booking: result.booking });
    } else if (result.kind === 'slot_taken') {
      setSlot(null);
      setRefreshKey((k) => k + 1);
      setSlotNotice("Someone just booked that time. Pick another, or send without a time and we'll reach out.");
    } else {
      setSubmitError(result.message);
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Enterprise</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Talk to our sales team
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-text-secondary">
                Running several locations or a larger crew? Tell us about your business and book a live walkthrough, or
                just send the request and we'll reply within one business day.
              </p>
            </motion.div>
          </div>
        </section>

        <section className="px-6 pb-24 pt-4">
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1.5fr_1fr] lg:gap-12">
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-8 md:p-10">
              {done ? (
                <SuccessCard booking={done.booking} />
              ) : (
                <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-5">
                  <h2 className="text-2xl font-bold tracking-tight text-text-primary">Tell us about your business</h2>

                  <div className="grid gap-5 sm:grid-cols-2">
                    <Input
                      id="sales-fullName"
                      label="Full name"
                      required
                      autoComplete="name"
                      maxLength={LIMITS.name}
                      value={values.fullName}
                      onChange={(e) => set('fullName', e.target.value)}
                      error={errors.fullName}
                    />
                    <Input
                      id="sales-workEmail"
                      label="Email"
                      type="email"
                      required
                      autoComplete="email"
                      inputMode="email"
                      maxLength={LIMITS.email}
                      value={values.workEmail}
                      onChange={(e) => set('workEmail', e.target.value)}
                      error={errors.workEmail}
                    />
                    <Input
                      id="sales-jobTitle"
                      label="Your role (optional)"
                      autoComplete="organization-title"
                      maxLength={LIMITS.title}
                      value={values.jobTitle}
                      onChange={(e) => set('jobTitle', e.target.value)}
                    />
                    <Input
                      id="sales-companyName"
                      label="Company"
                      required
                      autoComplete="organization"
                      maxLength={LIMITS.company}
                      value={values.companyName}
                      onChange={(e) => set('companyName', e.target.value)}
                      error={errors.companyName}
                    />
                    <Input
                      id="sales-phone"
                      label="Phone (optional)"
                      type="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      maxLength={LIMITS.phone}
                      value={values.phone}
                      onChange={(e) => set('phone', e.target.value)}
                      error={errors.phone}
                    />
                    <SelectField
                      id="sales-bestTimeToCall"
                      label="Best time to call (optional)"
                      value={values.bestTimeToCall}
                      onChange={(v) => set('bestTimeToCall', v as SalesFormValues['bestTimeToCall'])}
                    >
                      <option value="">No preference</option>
                      {BEST_TIMES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      id="sales-teamSize"
                      label="Team size"
                      required
                      value={values.teamSize}
                      error={errors.teamSize}
                      onChange={(v) => set('teamSize', v as SalesFormValues['teamSize'])}
                    >
                      <option value="">Select…</option>
                      {TEAM_SIZES.map((t) => (
                        <option key={t} value={t}>
                          {TEAM_SIZE_LABELS[t]}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      id="sales-locations"
                      label="Locations"
                      required
                      value={values.locations}
                      error={errors.locations}
                      onChange={(v) => set('locations', v as SalesFormValues['locations'])}
                    >
                      <option value="">Select…</option>
                      {LOCATION_COUNTS.map((l) => (
                        <option key={l} value={l}>
                          {LOCATION_LABELS[l]}
                        </option>
                      ))}
                    </SelectField>
                  </div>

                  <div>
                    <Textarea
                      id="sales-message"
                      label="What would you like to solve? (optional)"
                      rows={4}
                      maxLength={LIMITS.message}
                      value={values.message}
                      onChange={(e) => set('message', e.target.value)}
                      error={errors.message}
                      placeholder="Call volume, after-hours coverage, dispatch setup, integrations…"
                    />
                    <p className="mt-1 text-right text-xs text-text-secondary">
                      {values.message.length}/{LIMITS.message}
                    </p>
                  </div>

                  <fieldset className="rounded-xl border border-border bg-bg-primary p-4 sm:p-5">
                    <legend className="px-1 text-sm font-semibold text-text-primary">Book a live walkthrough</legend>
                    <p className="mb-4 text-sm text-text-secondary">
                      30 minutes with our team. Pick a time and it's confirmed instantly.
                    </p>
                    <SlotPicker value={slot} onChange={setSlot} refreshKey={refreshKey} disabled={submitting} />
                    {slotNotice && (
                      <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-warning-500">
                        <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {slotNotice}
                      </p>
                    )}
                  </fieldset>

                  {/* Honeypot: invisible to people and assistive tech; bots tend to fill it. */}
                  <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
                    <label>
                      Website
                      <input
                        type="text"
                        name="website"
                        tabIndex={-1}
                        autoComplete="off"
                        value={values.website}
                        onChange={(e) => set('website', e.target.value)}
                      />
                    </label>
                  </div>

                  <div>
                    <label className="flex items-start gap-3 text-sm text-text-secondary">
                      <input
                        id="sales-smsConsent"
                        type="checkbox"
                        checked={values.smsConsent}
                        onChange={(e) => set('smsConsent', e.target.checked)}
                        aria-invalid={!!errors.smsConsent}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
                      />
                      <span>I agree to receive texts about my inquiry. Message and data rates may apply.</span>
                    </label>
                    {errors.smsConsent && (
                      <p role="alert" className="mt-1.5 text-xs text-danger">
                        {errors.smsConsent}
                      </p>
                    )}
                  </div>

                  {submitError && (
                    <p
                      role="alert"
                      className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger"
                    >
                      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                      {submitError}
                    </p>
                  )}

                  <Button type="submit" variant="primary" size="lg" disabled={submitting} className="w-full">
                    {submitting && <Loader2 size={18} className="animate-spin" />}
                    {submitting ? 'Sending…' : slot ? 'Book my demo' : 'Contact sales'}
                  </Button>
                  <p className="text-center text-xs text-text-secondary">
                    By submitting you agree to our{' '}
                    <Link to="/privacy" className="font-medium text-accent hover:underline">
                      Privacy Policy
                    </Link>
                    .
                  </p>
                </form>
              )}
            </div>

            <aside className="flex flex-col gap-5">
              <div className="rounded-2xl border border-border bg-bg-secondary p-6">
                <h2 className="text-lg font-bold text-text-primary">What happens next</h2>
                <ol className="mt-4 space-y-4 text-sm leading-relaxed text-text-secondary">
                  <li className="flex gap-3">
                    <Users size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                    <span>We review your setup so the walkthrough is about your business, not a generic demo.</span>
                  </li>
                  <li className="flex gap-3">
                    <CalendarCheck size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                    <span>Booked a time? You're confirmed. Otherwise we reply within one business day.</span>
                  </li>
                  <li className="flex gap-3">
                    <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                    <span>Security, data handling and rollout questions are welcome on the call.</span>
                  </li>
                </ol>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">
                <p className="font-semibold text-text-primary">Prefer email?</p>
                <a
                  href={`mailto:${SALES_EMAIL}`}
                  className="focus-ring mt-2 inline-flex items-center gap-2 break-all font-medium text-accent hover:underline"
                >
                  <Mail size={16} aria-hidden="true" /> {SALES_EMAIL}
                </a>
                <p className="mt-4">
                  Just have a question?{' '}
                  <Link to="/contact" className="font-medium text-accent hover:underline">
                    Contact us
                  </Link>
                  .
                </p>
              </div>
            </aside>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
