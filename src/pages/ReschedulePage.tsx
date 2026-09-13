import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CalendarClock, CheckCircle2, AlertCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  fetchJobForReschedule,
  fetchBookedSlots,
  submitReschedule,
  generateCandidateSlots,
  RescheduleJobInfo,
} from '@/lib/reschedule';

function formatSlot(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ReschedulePage() {
  const { token } = useParams<{ token: string }>();
  const [job, setJob] = useState<RescheduleJobInfo | null | undefined>(undefined);
  const [slots, setSlots] = useState<Date[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const info = await fetchJobForReschedule(token);
      setJob(info);
      if (info?.allow_reschedule && info.job_status === 'scheduled') {
        const now = new Date();
        const later = new Date();
        later.setDate(later.getDate() + 10);
        const booked = await fetchBookedSlots(token, now, later);
        setSlots(generateCandidateSlots(10, booked));
      }
    })();
  }, [token]);

  const handlePick = async (slot: Date) => {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    const ok = await submitReschedule(token, slot);
    if (ok) {
      setDone(slot);
    } else {
      setError("That time just got taken, or this link isn't valid anymore. Please call us directly.");
    }
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark">
          {job === undefined && <p className="text-center text-sm text-text-secondary">Loading your appointment…</p>}

          {job === null && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Link not found</h1>
              <p className="mt-2 text-sm text-text-secondary">
                This reschedule link doesn't match an appointment. Please call the business directly.
              </p>
            </div>
          )}

          {job && !job.allow_reschedule && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Self-reschedule isn't available</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Please call {job.business_name ?? 'us'} to change your appointment time.
              </p>
            </div>
          )}

          {job && job.allow_reschedule && job.job_status !== 'scheduled' && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">This appointment can't be rescheduled</h1>
              <p className="mt-2 text-sm text-text-secondary">
                It looks like this job is already {job.job_status.replace('_', ' ')}.
              </p>
            </div>
          )}

          {job && job.allow_reschedule && job.job_status === 'scheduled' && !done && (
            <>
              <div className="mb-6 flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <CalendarClock size={20} />
                </span>
                <div>
                  <h1 className="text-lg font-semibold text-text-primary">Reschedule your appointment</h1>
                  <p className="text-xs text-text-secondary">
                    {job.service_type ?? 'Your appointment'} with {job.business_name ?? 'us'}
                  </p>
                </div>
              </div>

              {job.scheduled_datetime && (
                <p className="mb-4 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
                  Currently scheduled for {formatSlot(new Date(job.scheduled_datetime))}
                </p>
              )}

              <p className="mb-3 text-sm font-medium text-text-primary">Pick a new time</p>
              {slots.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No open times in the next 10 days — please call to find a time together.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {slots.map((slot) => (
                    <button
                      key={slot.toISOString()}
                      type="button"
                      disabled={submitting}
                      onClick={() => handlePick(slot)}
                      className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-xs font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
                    >
                      {formatSlot(slot)}
                    </button>
                  ))}
                </div>
              )}
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
            </>
          )}

          {done && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-success-500" />
              <h1 className="text-lg font-semibold text-text-primary">You're all set</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Your appointment is now scheduled for {formatSlot(done)}.
              </p>
            </motion.div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
