import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CalendarClock, CheckCircle2, AlertCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { fetchBookingBusiness, fetchBookedWindow, submitPublicBooking, generateAvailableSlots, BookingBusinessInfo } from '@/lib/onlineBooking';

function formatSlot(date: Date): string {
  return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const embed = searchParams.get('embed') === '1';
  const channel = searchParams.get('src') || 'direct_link';
  const refCode = searchParams.get('ref') || undefined;

  const [business, setBusiness] = useState<BookingBusinessInfo | null | undefined>(undefined);
  const [slots, setSlots] = useState<Date[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Date | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [service, setService] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      const info = await fetchBookingBusiness(slug);
      setBusiness(info);
      if (info?.booking_enabled) {
        const now = new Date();
        const later = new Date(now.getTime() + info.window_days * 24 * 60 * 60 * 1000);
        const booked = await fetchBookedWindow(slug, now, later);
        setSlots(generateAvailableSlots(info, booked, now));
        setService(info.services_offered?.[0] ?? '');
      }
    })();
  }, [slug]);

  const canSubmit = useMemo(() => Boolean(selectedSlot && name.trim().length > 1), [selectedSlot, name]);

  const handleSubmit = async () => {
    if (!slug || !selectedSlot) return;
    setSubmitting(true);
    setError(null);
    const result = await submitPublicBooking({ slug, customerName: name, customerPhone: phone, customerEmail: email, serviceType: service, scheduledDatetime: selectedSlot, notes, channel, refCode });
    if (result.ok) setDone(true);
    else if (result.reason === 'slot_taken') { setError('That time was just taken — please pick another.'); setSelectedSlot(null); }
    else setError('Could not book that appointment. Please call the business directly.');
    setSubmitting(false);
  };

  const content = (
    <div className="w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark">
      {business === undefined && <p className="text-center text-sm text-text-secondary">Loading…</p>}
      {business === null && (
        <div className="text-center">
          <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
          <h1 className="text-lg font-semibold text-text-primary">Booking link not found</h1>
        </div>
      )}
      {business && !business.booking_enabled && (
        <div className="text-center">
          <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
          <h1 className="text-lg font-semibold text-text-primary">Online booking isn't available</h1>
          <p className="mt-2 text-sm text-text-secondary">Please call {business.business_name ?? 'us'} directly.</p>
        </div>
      )}
      {business && business.booking_enabled && !done && (
        <>
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><CalendarClock size={20} /></span>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">Book an appointment</h1>
              <p className="text-xs text-text-secondary">with {business.business_name ?? 'us'}</p>
            </div>
          </div>
          {(business.services_offered?.length ?? 0) > 0 && (
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">Service</label>
              <select value={service} onChange={(e) => setService(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary">
                {business.services_offered!.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
          <p className="mb-3 text-sm font-medium text-text-primary">Pick a time</p>
          {slots.length === 0 ? (
            <p className="text-sm text-text-secondary">No open times in the next {business.window_days} days — please call to find a time together.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {slots.map((slot) => (
                <button key={slot.toISOString()} type="button" onClick={() => setSelectedSlot(slot)}
                  className={`focus-ring rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${selectedSlot?.getTime() === slot.getTime() ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-primary hover:border-accent/40 hover:text-accent'}`}>
                  {formatSlot(slot)}
                </button>
              ))}
            </div>
          )}
          {selectedSlot && (
            <div className="mt-5 space-y-3">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" type="tel" className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" type="email" className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary" />
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything we should know? (optional)" rows={2} className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary" />
              <button type="button" disabled={!canSubmit || submitting} onClick={handleSubmit} className="focus-ring w-full rounded-xl bg-cta px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50">
                {submitting ? 'Booking…' : `Confirm ${formatSlot(selectedSlot)}`}
              </button>
            </div>
          )}
          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </>
      )}
      {done && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center">
          <CheckCircle2 size={28} className="mx-auto mb-3 text-success-500" />
          <h1 className="text-lg font-semibold text-text-primary">You're booked!</h1>
          <p className="mt-2 text-sm text-text-secondary">{business?.business_name ?? 'The business'} will see you {selectedSlot ? formatSlot(selectedSlot) : ''}.</p>
        </motion.div>
      )}
    </div>
  );

  if (embed) return <div className="flex min-h-screen items-center justify-center bg-transparent p-4">{content}</div>;
  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-16">{content}</main>
      <Footer />
    </div>
  );
}
