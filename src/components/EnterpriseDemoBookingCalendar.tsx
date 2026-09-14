import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EASE } from '@/lib/motion';
import {
  DemoSlot,
  bookEnterpriseDemoSlot,
  buildDemoBookingIcs,
  getEnterpriseDemoOpenSlots,
} from '@/lib/enterpriseDemoBooking';

type BookingFormData = {
  fullName: string;
  workEmail: string;
  companyName: string;
  phone: string;
  teamSize: string;
  message: string;
};

const INITIAL_FORM: BookingFormData = {
  fullName: '',
  workEmail: '',
  companyName: '',
  phone: '',
  teamSize: '',
  message: '',
};

const TEAM_SIZES = ['1-5', '6-20', '21-50', '50+'];
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const FETCH_WINDOW_DAYS = 90;

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

function dateKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const dayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

type Step = 'calendar' | 'details' | 'confirmed';

interface EnterpriseDemoBookingCalendarProps {
  className?: string;
  heading?: string;
  description?: string;
}

export function EnterpriseDemoBookingCalendar({
  className = '',
  heading = 'Pick a time for your live demo',
  description = '30 minutes with our team — pick whatever works for you and it\u2019s confirmed instantly.',
}: EnterpriseDemoBookingCalendarProps) {
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slotsByDate, setSlotsByDate] = useState<Map<string, DemoSlot[]>>(new Map());
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<DemoSlot | null>(null);

  const [step, setStep] = useState<Step>('calendar');
  const [formData, setFormData] = useState<BookingFormData>(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof BookingFormData, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<DemoSlot | null>(null);

  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const loadSlots = useCallback(async () => {
    setLoadingSlots(true);
    setSlotsError(null);
    try {
      const rangeStart = startOfDay(new Date());
      const rangeEnd = new Date(rangeStart.getTime() + FETCH_WINDOW_DAYS * 86400000);
      const slots = await getEnterpriseDemoOpenSlots(rangeStart, rangeEnd);
      const map = new Map<string, DemoSlot[]>();
      for (const slot of slots) {
        const key = dateKey(slot.start);
        const list = map.get(key) ?? [];
        list.push(slot);
        map.set(key, list);
      }
      for (const list of map.values()) list.sort((a, b) => a.start.getTime() - b.start.getTime());
      setSlotsByDate(map);
    } catch {
      setSlotsError('Couldn\u2019t load available times. Please try again.');
    } finally {
      setLoadingSlots(false);
      setHasLoadedOnce(true);
    }
  }, []);

  useEffect(() => {
    loadSlots();
  }, [loadSlots]);

  const availableDateKeys = useMemo(() => {
    const keys: string[] = [];
    slotsByDate.forEach((slots, key) => {
      if (slots.length > 0) keys.push(key);
    });
    return keys.sort();
  }, [slotsByDate]);

  const availableDateKeySet = useMemo(() => new Set(availableDateKeys), [availableDateKeys]);

  const maxAvailableDate = availableDateKeys.length
    ? new Date(`${availableDateKeys[availableDateKeys.length - 1]}T00:00:00`)
    : null;

  const canGoPrevMonth = visibleMonth > startOfMonth(new Date());
  const canGoNextMonth = maxAvailableDate ? visibleMonth < startOfMonth(maxAvailableDate) : false;

  const goToMonth = (delta: number) => {
    setVisibleMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
    setSelectedDateKey(null);
  };

  const calendarCells = useMemo(() => {
    const first = startOfMonth(visibleMonth);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells: { date: Date | null; key: string | null }[] = [];
    for (let i = 0; i < startWeekday; i++) cells.push({ date: null, key: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(first.getFullYear(), first.getMonth(), d);
      cells.push({ date, key: dateKey(date) });
    }
    return cells;
  }, [visibleMonth]);

  const selectedDaySlots = selectedDateKey ? slotsByDate.get(selectedDateKey) ?? [] : [];

  const update = (key: keyof BookingFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => ({ ...prev, [key]: false }));
  };

  const validate = () => {
    const errors: Partial<Record<keyof BookingFormData, boolean>> = {};
    if (!formData.fullName.trim()) errors.fullName = true;
    if (!formData.workEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.workEmail)) errors.workEmail = true;
    if (!formData.companyName.trim()) errors.companyName = true;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    if (!selectedSlot) return;
    if (!validate()) return;
    setSubmitting(true);
    try {
      const result = await bookEnterpriseDemoSlot({
        fullName: formData.fullName,
        workEmail: formData.workEmail,
        companyName: formData.companyName,
        phone: formData.phone || undefined,
        teamSize: formData.teamSize || undefined,
        message: formData.message || undefined,
        slotStart: selectedSlot.start,
      });
      if (result.ok) {
        setConfirmed(selectedSlot);
        setStep('confirmed');
      } else if (result.reason === 'SLOT_NOT_AVAILABLE') {
        setSubmitError('That time was just booked by someone else. Please pick another time.');
        setSelectedSlot(null);
        setStep('calendar');
        loadSlots();
      } else if (result.reason === 'INVALID_EMAIL') {
        setFieldErrors((prev) => ({ ...prev, workEmail: true }));
        setSubmitError('Please enter a valid work email.');
      } else {
        setSubmitError('Something went wrong. Please try again.');
      }
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const downloadIcs = () => {
    if (!confirmed) return;
    const blob = buildDemoBookingIcs({
      start: confirmed.start,
      end: confirmed.end,
      title: 'Vireek Enterprise Demo',
      description: `Live walkthrough of Vireek${formData.companyName ? ` with ${formData.companyName}` : ''}.`,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vireek-enterprise-demo.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const resetToCalendar = () => {
    setStep('calendar');
    setSelectedSlot(null);
    setSelectedDateKey(null);
    setConfirmed(null);
    setFormData(INITIAL_FORM);
    setFieldErrors({});
    setSubmitError(null);
    loadSlots();
  };

  return (
    <div
      className={`rounded-3xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8 ${className}`}
    >
      <AnimatePresence mode="wait">
        {step === 'calendar' && (
          <motion.div
            key="calendar"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            <h2 className="text-xl font-bold text-text-primary">{heading}</h2>
            <p className="mt-1.5 text-sm text-text-secondary">{description}</p>

            {loadingSlots && !hasLoadedOnce && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-secondary">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
                <p className="text-sm">Loading open times…</p>
              </div>
            )}

            {!loadingSlots && slotsError && (
              <div className="flex flex-col items-center gap-3 py-14 text-center">
                <AlertCircle className="h-6 w-6 text-danger" />
                <p className="text-sm text-text-secondary">{slotsError}</p>
                <Button type="button" variant="secondary" size="sm" onClick={loadSlots} className="gap-2">
                  <RefreshCw size={14} /> Try again
                </Button>
              </div>
            )}

            {!loadingSlots && !slotsError && hasLoadedOnce && availableDateKeys.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-14 text-center">
                <CalendarDays className="h-6 w-6 text-text-secondary" />
                <p className="max-w-xs text-sm text-text-secondary">
                  No open times right now. Email{' '}
                  <a href="mailto:ali@vireek.com" className="font-semibold text-accent">
                    ali@vireek.com
                  </a>{' '}
                  and we’ll find a time that works.
                </p>
              </div>
            )}

            {!loadingSlots && !slotsError && availableDateKeys.length > 0 && (
              <div className="mt-6 grid gap-6 sm:grid-cols-[1fr_200px]">
                <div>
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => goToMonth(-1)}
                      disabled={!canGoPrevMonth}
                      aria-label="Previous month"
                      className="focus-ring flex h-8 w-8 items-center justify-center rounded-full border border-border text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="text-sm font-semibold text-text-primary">
                      {monthFormatter.format(visibleMonth)}
                    </span>
                    <button
                      type="button"
                      onClick={() => goToMonth(1)}
                      disabled={!canGoNextMonth}
                      aria-label="Next month"
                      className="focus-ring flex h-8 w-8 items-center justify-center rounded-full border border-border text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>

                  <div className="mt-4 grid grid-cols-7 gap-y-1 text-center">
                    {WEEKDAY_LABELS.map((w, i) => (
                      <div
                        key={`wd-${i}`}
                        className="pb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary/70"
                      >
                        {w}
                      </div>
                    ))}
                    {calendarCells.map((cell, i) => {
                      const hasSlots = cell.key ? availableDateKeySet.has(cell.key) : false;
                      const isSelected = !!cell.key && cell.key === selectedDateKey;
                      return (
                        <div key={cell.key ?? `pad-${i}`} className="flex items-center justify-center py-0.5">
                          {cell.date && (
                            <button
                              type="button"
                              disabled={!hasSlots}
                              onClick={() => cell.key && setSelectedDateKey(cell.key)}
                              className={`focus-ring relative flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium transition-colors ${
                                isSelected
                                  ? 'bg-accent text-white'
                                  : hasSlots
                                    ? 'text-text-primary hover:bg-accent/10 hover:text-accent'
                                    : 'cursor-not-allowed text-text-secondary/30'
                              }`}
                            >
                              {cell.date.getDate()}
                              {hasSlots && !isSelected && (
                                <span className="absolute bottom-1 h-1 w-1 rounded-full bg-accent" />
                              )}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-4 text-xs text-text-secondary">Times shown in your local time zone ({timezone}).</p>
                </div>

                <div className="border-t border-border pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {selectedDateKey ? dayFormatter.format(new Date(`${selectedDateKey}T00:00:00`)) : 'Select a date'}
                  </h3>
                  {!selectedDateKey && (
                    <p className="mt-2 text-sm text-text-secondary">Pick a highlighted day to see open times.</p>
                  )}
                  {selectedDateKey && (
                    <div className="mt-3 flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
                      {selectedDaySlots.map((slot) => (
                        <button
                          key={slot.start.toISOString()}
                          type="button"
                          onClick={() => {
                            setSelectedSlot(slot);
                            setSubmitError(null);
                            setStep('details');
                          }}
                          className="focus-ring rounded-xl border border-border px-4 py-2.5 text-left text-sm font-semibold text-text-primary transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
                        >
                          {timeFormatter.format(slot.start)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {step === 'details' && selectedSlot && (
          <motion.div
            key="details"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            <button
              type="button"
              onClick={() => {
                setStep('calendar');
                setSubmitError(null);
              }}
              className="focus-ring mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-text-secondary transition-colors hover:text-accent"
            >
              <ChevronLeft size={16} /> Change time
            </button>

            <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent/20 bg-accent/[0.04] px-4 py-3">
              <Clock className="h-5 w-5 shrink-0 text-accent" />
              <div className="text-sm">
                <p className="font-semibold text-text-primary">{dayFormatter.format(selectedSlot.start)}</p>
                <p className="text-text-secondary">
                  {timeFormatter.format(selectedSlot.start)}–{timeFormatter.format(selectedSlot.end)} ({timezone})
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-1">
                  <label htmlFor="edb-fullName" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Full name
                  </label>
                  <input
                    id="edb-fullName"
                    value={formData.fullName}
                    onChange={(e) => update('fullName', e.target.value)}
                    className={`${inputClass} ${fieldErrors.fullName ? 'border-danger/60' : ''}`}
                    placeholder="Jane Smith"
                  />
                </div>
                <div className="sm:col-span-1">
                  <label htmlFor="edb-workEmail" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Work email
                  </label>
                  <input
                    id="edb-workEmail"
                    type="email"
                    value={formData.workEmail}
                    onChange={(e) => update('workEmail', e.target.value)}
                    className={`${inputClass} ${fieldErrors.workEmail ? 'border-danger/60' : ''}`}
                    placeholder="jane@company.com"
                  />
                </div>
                <div className="sm:col-span-1">
                  <label htmlFor="edb-companyName" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Company name
                  </label>
                  <input
                    id="edb-companyName"
                    value={formData.companyName}
                    onChange={(e) => update('companyName', e.target.value)}
                    className={`${inputClass} ${fieldErrors.companyName ? 'border-danger/60' : ''}`}
                    placeholder="Smith Plumbing Co."
                  />
                </div>
                <div className="sm:col-span-1">
                  <label htmlFor="edb-phone" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Phone <span className="font-normal text-text-secondary">(optional)</span>
                  </label>
                  <input
                    id="edb-phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => update('phone', e.target.value)}
                    className={inputClass}
                    placeholder="(555) 555-5555"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="edb-teamSize" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Team size
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {TEAM_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => update('teamSize', size)}
                        className={`focus-ring rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                          formData.teamSize === size
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/40'
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="edb-message" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Anything specific you want us to cover?{' '}
                    <span className="font-normal text-text-secondary">(optional)</span>
                  </label>
                  <textarea
                    id="edb-message"
                    rows={3}
                    value={formData.message}
                    onChange={(e) => update('message', e.target.value)}
                    className={inputClass}
                    placeholder="E.g. CRM integration, multi-location routing..."
                  />
                </div>
              </div>

              {submitError && (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                  <AlertCircle size={16} className="shrink-0" />
                  {submitError}
                </div>
              )}

              <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={submitting}>
                {submitting ? 'Booking\u2026' : 'Confirm Booking'}
              </Button>
            </form>
          </motion.div>
        )}

        {step === 'confirmed' && (
          <motion.div
            key="confirmed"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="flex flex-col items-center py-6 text-center"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success-500/10 text-success-500">
              <CheckCircle2 size={26} />
            </span>
            <h2 className="mt-5 text-xl font-bold text-text-primary">You’re booked!</h2>
            {confirmed && (
              <p className="mt-2 text-sm font-medium text-text-primary">
                {dayFormatter.format(confirmed.start)} · {timeFormatter.format(confirmed.start)}–
                {timeFormatter.format(confirmed.end)} ({timezone})
              </p>
            )}
            <p className="mt-2 max-w-xs text-sm text-text-secondary">
              We’ll see you then. Add it to your calendar so you don’t miss it.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button type="button" variant="secondary" size="md" className="gap-2" onClick={downloadIcs}>
                <Download size={16} /> Add to calendar
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={resetToCalendar}>
                Book another time
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
