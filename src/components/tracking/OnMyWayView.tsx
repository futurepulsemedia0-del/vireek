import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Clock, MapPin, Star, Wrench } from 'lucide-react';
import {
  ensureReviewRequest,
  formatArrivalWindow,
  freshness,
  osmEmbedUrl,
  resolveEta,
  type JobTracking,
} from '@/lib/liveTracking';

const STATUS_COPY: Record<JobTracking['job_status'], string> = {
  scheduled: "Your technician hasn't left yet — we'll update this page as soon as they're on the way.",
  en_route: 'Your technician is on the way.',
  in_progress: 'Your technician has arrived and is working on your service.',
  completed: 'This service visit is complete.',
  cancelled: 'This visit was cancelled.',
  no_show: 'This visit was marked as a no-show.',
};

const STEPS = ['Scheduled', 'On the way', 'Arrived', 'Done'] as const;
const STEP_INDEX: Partial<Record<JobTracking['job_status'], number>> = {
  scheduled: 0,
  en_route: 1,
  in_progress: 2,
  completed: 3,
};

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('') || '?'
  );
}

function TechnicianAvatar({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoUrl]);

  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl}
        alt={`Photo of ${name}`}
        width={56}
        height={56}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-14 w-14 shrink-0 rounded-full object-cover ring-2 ring-accent/30"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-lg font-semibold text-text-secondary"
    >
      {initials(name)}
    </span>
  );
}

function ProgressSteps({ index }: { index: number }) {
  return (
    <ol className="mt-5 grid grid-cols-4 gap-1.5" aria-label="Visit progress">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i === index ? 'step' : undefined} className="text-center">
          <div className={`h-1.5 rounded-full ${i <= index ? 'bg-accent' : 'bg-bg-tertiary'}`} />
          <span className={`mt-1.5 block text-[11px] ${i === index ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ReviewPrompt({ tracking, token }: { tracking: JobTracking; token: string }) {
  const [fetched, setFetched] = useState<string | null>(null);
  const answered = tracking.review_status === 'completed' || tracking.review_status === 'declined';
  const reviewToken = fetched ?? tracking.review_token;

  useEffect(() => {
    if (answered || reviewToken) return;
    let cancelled = false;
    void ensureReviewRequest(token).then((t) => {
      if (!cancelled) setFetched(t);
    });
    return () => {
      cancelled = true;
    };
  }, [answered, reviewToken, token]);

  if (answered) {
    return (
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-border/60 p-4">
        <CheckCircle2 size={20} className="shrink-0 text-success" />
        <p className="text-sm text-text-primary">Thanks — we have your feedback on file.</p>
      </div>
    );
  }
  if (!reviewToken) return null;

  const firstName = tracking.technician_name?.split(' ')[0];
  return (
    <div className="mt-5 rounded-2xl border border-accent/30 bg-accent/5 p-5 text-center">
      <p className="text-sm font-semibold text-text-primary">
        {firstName ? `How did ${firstName} do?` : 'How did we do?'}
      </p>
      <p className="mt-1 text-xs text-text-secondary">Tap a star to rate your visit — it takes 10 seconds.</p>
      <div className="mt-3 flex justify-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <Link
            key={n}
            to={`/review/${reviewToken}?rating=${n}`}
            aria-label={`Rate ${n} out of 5`}
            className="rounded-lg p-1.5 text-warning-500 transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Star size={28} />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function OnMyWayView({ tracking, token }: { tracking: JobTracking; token: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [tracking]);

  // Correct for a customer phone whose clock is off, so countdowns match the server's timestamps.
  const serverMs = tracking.server_time ? Date.parse(tracking.server_time) : NaN;
  const clockOffset = useMemo(() => (Number.isNaN(serverMs) ? 0 : serverMs - Date.now()), [serverMs]);
  const nowMs = now + clockOffset;

  const status = tracking.job_status;
  const arrived = status === 'in_progress' || (status === 'en_route' && Boolean(tracking.arrived_at));
  const eta = arrived ? null : resolveEta(tracking, nowMs);
  const stepIndex = arrived ? 2 : STEP_INDEX[status];
  const windowText = formatArrivalWindow(tracking.arrival_window_start, tracking.arrival_window_end, { nowMs });
  const fresh = freshness(tracking.location_updated_at, nowMs);

  const hasLocation = isNum(tracking.technician_lat) && isNum(tracking.technician_lng);
  const mapUrl = useMemo(() => {
    if (!isNum(tracking.technician_lat) || !isNum(tracking.technician_lng)) return null;
    const site =
      isNum(tracking.site_lat) && isNum(tracking.site_lng) ? { lat: tracking.site_lat, lng: tracking.site_lng } : null;
    return osmEmbedUrl({ lat: tracking.technician_lat, lng: tracking.technician_lng }, site);
  }, [tracking.technician_lat, tracking.technician_lng, tracking.site_lat, tracking.site_lng]);

  const arrivalClock = eta
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(nowMs + eta.minutes * 60000))
    : null;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <p className="text-xs font-medium text-text-secondary">{tracking.business_name ?? 'Your service'}</p>
      <h1 className="mt-1 text-xl font-bold text-text-primary">{tracking.service_type ?? 'Service visit'}</h1>

      {stepIndex !== undefined && <ProgressSteps index={stepIndex} />}

      <div aria-live="polite">
        {eta ? (
          <div className="mt-5 flex items-center gap-4 rounded-2xl border border-accent/30 bg-accent/5 p-5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
              <Clock size={22} />
            </span>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-text-primary">{eta.minutes > 0 ? `${eta.minutes} min` : 'Arriving now'}</p>
              <p className="text-xs text-text-secondary">
                {arrivalClock && eta.minutes > 0 ? `Arriving around ${arrivalClock} · ` : ''}
                {eta.source === 'live' ? 'Live GPS' : 'Estimated by technician'}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-3 rounded-2xl border border-border/60 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
              <Wrench size={18} />
            </span>
            <p className="text-sm text-text-primary">
              {arrived && status === 'en_route' ? 'Your technician has just arrived.' : STATUS_COPY[status]}
            </p>
          </div>
        )}
      </div>

      {status === 'scheduled' && windowText && (
        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-border/60 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <CalendarClock size={18} />
          </span>
          <div>
            <p className="text-xs text-text-secondary">Arrival window</p>
            <p className="text-sm font-semibold text-text-primary">{windowText}</p>
          </div>
        </div>
      )}

      {tracking.technician_name && (
        <div className="mt-4 flex items-center gap-4 rounded-2xl border border-border/60 p-4">
          <TechnicianAvatar name={tracking.technician_name} photoUrl={tracking.technician_photo_url} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-text-primary">{tracking.technician_name}</p>
            <p className="text-xs text-text-secondary">Your technician</p>
          </div>
        </div>
      )}

      {hasLocation && mapUrl && !arrived && (
        <div className="mt-5 overflow-hidden rounded-2xl border border-border">
          <iframe title="Technician location" className="h-64 w-full" loading="lazy" src={mapUrl} />
          <p className={`flex items-center gap-1.5 px-3 py-2 text-[11px] ${fresh?.stale ? 'text-warning-500' : 'text-text-secondary'}`}>
            <MapPin size={11} />
            {fresh ? fresh.label : 'Location updates automatically'}
            {tracking.position_source === 'telematics' ? ' · vehicle GPS' : ''}
          </p>
        </div>
      )}

      {tracking.can_reschedule && (
        <Link
          to={`/reschedule/${token}`}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CalendarClock size={16} /> Need a different time? Reschedule
        </Link>
      )}

      {status === 'completed' && <ReviewPrompt tracking={tracking} token={token} />}
    </div>
  );
}
