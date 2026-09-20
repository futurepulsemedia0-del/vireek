import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Clock, MapPin, Wrench } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { fetchJobTracking, minutesRemaining, type JobTracking } from '@/lib/liveTracking';

const POLL_MS = 20000;

const STATUS_COPY: Record<JobTracking['job_status'], string> = {
  scheduled: "Your technician hasn't left yet — check back closer to your appointment.",
  en_route: 'Your technician is on the way.',
  in_progress: 'Your technician has arrived and is working on your service.',
  completed: 'This service visit is complete.',
  cancelled: 'This visit was cancelled.',
  no_show: 'This visit was marked as a no-show.',
};

export function TrackingPage() {
  const { token } = useParams<{ token: string }>();
  const [tracking, setTracking] = useState<JobTracking | null | undefined>(undefined);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      const data = await fetchJobTracking(token);
      if (!cancelled) setTracking(data);
    };

    load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [token]);

  useEffect(() => {
    if (!tracking) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(minutesRemaining(tracking.eta_minutes, tracking.eta_set_at));
    tick();
    const interval = setInterval(tick, 30000);
    return () => clearInterval(interval);
  }, [tracking]);

  const hasLocation =
    tracking && tracking.technician_lat !== null && tracking.technician_lng !== null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-lg">
          {tracking === undefined && (
            <p className="py-20 text-center text-sm text-text-secondary">Loading…</p>
          )}

          {tracking === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Tracking not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This link isn't valid, or live tracking isn't turned on for this business yet.
                Please call the business directly for an update.
              </p>
            </div>
          )}

          {tracking && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">{tracking.business_name ?? 'Your service'}</p>
              <h1 className="mt-1 text-xl font-bold text-text-primary">
                {tracking.service_type ?? 'Service visit'}
              </h1>

              {tracking.job_status === 'en_route' && remaining !== null ? (
                <div className="mt-5 flex items-center gap-4 rounded-2xl border border-accent/30 bg-accent/5 p-5">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
                    <Clock size={22} />
                  </span>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">
                      {remaining > 0 ? `${remaining} min` : 'Arriving now'}
                    </p>
                    <p className="text-xs text-text-secondary">Estimated time of arrival</p>
                  </div>
                </div>
              ) : (
                <div className="mt-5 flex items-center gap-3 rounded-2xl border border-border/60 p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
                    <Wrench size={18} />
                  </span>
                  <p className="text-sm text-text-primary">{STATUS_COPY[tracking.job_status]}</p>
                </div>
              )}

              {tracking.technician_name && (
                <p className="mt-4 text-sm text-text-secondary">
                  Technician: <span className="font-medium text-text-primary">{tracking.technician_name}</span>
                </p>
              )}

              {hasLocation && (
                <div className="mt-5 overflow-hidden rounded-2xl border border-border">
                  <iframe
                    title="Technician location"
                    className="h-64 w-full"
                    loading="lazy"
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${tracking.technician_lng! - 0.02}%2C${tracking.technician_lat! - 0.02}%2C${tracking.technician_lng! + 0.02}%2C${tracking.technician_lat! + 0.02}&layer=mapnik&marker=${tracking.technician_lat}%2C${tracking.technician_lng}`}
                  />
                  <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-text-secondary">
                    <MapPin size={11} /> Location updates automatically every {POLL_MS / 1000}s
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
