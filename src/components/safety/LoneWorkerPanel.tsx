// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Mic, Radio } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DuressButton } from '@/components/safety/DuressButton';
import {
  EMERGENCY_SERVICES_NOTICE,
  checkIn,
  endSession,
  extendSession,
  fetchMySession,
  fetchTransparency,
  flushQueue,
  heartbeat,
  isPlainOkPhrase,
  listenForCheckin,
  pokeEngine,
  queueAction,
  recordLocation,
  smsHelpHref,
  startSession,
  voiceCheckinSupported,
  type MySession,
  type Transparency,
} from '@/lib/siteSafety';

interface Props {
  jobId: string;
  expectedMinutes?: number | null;
}

const HEARTBEAT_MS = 60_000;
const TICK_MS = 15_000;

function minutesUntil(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((t - now) / 60_000);
}

const START_ERROR: Record<string, string> = {
  safety_disabled: 'Lone-worker safety is not turned on for your company.',
  consent_required: 'Please review and agree to the monitoring notice first.',
  drills_disabled: 'Practice drills are not turned on.',
};

/**
 * Lone-worker check-in for the current job. Alerts the technician's own team only; it never contacts emergency
 * services (the notice says so). Heartbeat and optional location run only while a session is active.
 */
export function LoneWorkerPanel({ jobId, expectedMinutes }: Props) {
  const { toast } = useToast();
  const [info, setInfo] = useState<Transparency | null>(null);
  const [session, setSession] = useState<MySession | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lock = useRef(false);
  const seq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError(false);
    try {
      const [t, s] = await Promise.all([fetchTransparency(), fetchMySession(jobId)]);
      if (alive.current && mine === seq.current) {
        setInfo(t);
        setSession(s);
      }
    } catch {
      if (alive.current && mine === seq.current) setLoadError(true);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sessionId = session?.active ? session.session_id ?? null : null;
  const active = sessionId !== null;
  const locationOn = !!info && info.location_sharing_enabled && info.location_opt_in && info.consent_current;

  // Clock for the countdown (only while a session runs).
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  // Heartbeat + replay of anything queued while offline.
  useEffect(() => {
    if (!sessionId) return;
    const beat = () => { void heartbeat(sessionId).catch(() => undefined); };
    const replay = () => { void flushQueue().then((n) => { if (n > 0) void load(); }).catch(() => undefined); };
    beat();
    const id = window.setInterval(beat, HEARTBEAT_MS);
    window.addEventListener('online', replay);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', replay);
    };
  }, [sessionId, load]);

  // Location: only with monitoring consent AND the technician's own opt-in AND while a session is active.
  // The server re-checks every one of these and refuses otherwise; nothing here is the authority.
  useEffect(() => {
    if (!sessionId || !locationOn || typeof navigator === 'undefined' || !navigator.geolocation) return;
    let last = 0;
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const t = Date.now();
        if (t - last < HEARTBEAT_MS) return;
        last = t;
        void recordLocation(sessionId, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null, at: t }).catch(() => undefined);
      },
      () => undefined, // denied / unavailable: simply no location, never an error for the technician
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [sessionId, locationOn]);

  const run = async (name: string, fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    try {
      await fn();
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const start = (drill: boolean) =>
    run(drill ? 'drill' : 'start', async () => {
      try {
        const res = await startSession(jobId, expectedMinutes ?? undefined, drill);
        if (!res.success) {
          toast(START_ERROR[res.error ?? ''] ?? 'Could not start the check-in.', 'error');
          return;
        }
        if (res.session_id) void pokeEngine(res.session_id);
        await load();
      } catch {
        toast('Could not start the check-in. Try again.', 'error');
      }
    });

  const imOk = () =>
    run('checkin', async () => {
      if (!sessionId) return;
      try {
        const res = await checkIn(sessionId, 'tap');
        if (!res.success) throw new Error('rejected');
        toast('Checked in. Thank you.', 'success');
        await load();
      } catch {
        queueAction({ kind: 'checkin', sessionId, at: Date.now() });
        toast('No signal: your check-in is saved and will be sent when you are back online.', 'info');
      }
    });

  const voice = () =>
    run('voice', async () => {
      if (!sessionId) return;
      const heard = await listenForCheckin(info ? (typeof navigator !== 'undefined' ? navigator.language : 'en-US') : 'en-US');
      if (!heard) {
        toast('Did not catch that. Use the button instead.', 'info');
        return;
      }
      try {
        // A plain "I'm fine" counts as a normal check-in; any other phrase is sent as text so a duress word still works.
        const res = isPlainOkPhrase(heard) ? await checkIn(sessionId, 'tap') : await checkIn(sessionId, 'voice', heard);
        if (!res.success) throw new Error('rejected');
        toast('Checked in. Thank you.', 'success');
        await load();
      } catch {
        queueAction({ kind: 'checkin', sessionId, at: Date.now() });
        toast('No signal: your check-in is saved and will be sent when you are back online.', 'info');
      }
    });

  const extend = (minutes: number) =>
    run(`extend${minutes}`, async () => {
      if (!sessionId) return;
      try {
        const res = await extendSession(sessionId, minutes);
        if (res.success) toast(`Added ${minutes} minutes.`, 'success');
        await load();
      } catch {
        toast('Could not add time. Try again.', 'error');
      }
    });

  const finish = (outcome: 'completed' | 'false_alarm') =>
    run(`end-${outcome}`, async () => {
      if (!sessionId) return;
      try {
        await endSession(sessionId, outcome);
        void pokeEngine(sessionId);
        await load();
      } catch {
        toast('Could not end the check-in. Try again.', 'error');
      }
    });

  if (loadError) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
        Could not load check-in status. <button type="button" onClick={() => void load()} className="focus-ring font-semibold text-accent underline">Try again</button>
      </div>
    );
  }
  // Hidden unless the company turned the module on and this person is a team member.
  if (!info || !info.enabled || !info.is_member) return null;

  const needsConsent = info.monitoring_consent_required && !info.consent_current;
  const dueIn = minutesUntil(session?.next_checkin_due_at, now);
  const endIn = minutesUntil(session?.expected_end_at, now);
  const smsHref = info.sms_fallback_enabled ? smsHelpHref(info.sms_number) : null;
  const escalating = session?.status === 'escalating';

  return (
    <section aria-labelledby={`lwp-${jobId}`} className="rounded-xl border border-border bg-bg-secondary p-4">
      <h2 id={`lwp-${jobId}`} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Radio size={16} aria-hidden="true" /> Lone-worker check-in
        {session?.is_drill && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">Practice drill</span>}
      </h2>

      {!active ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-text-secondary">
            Start a check-in when you arrive. Your team is alerted if you do not check in on time. Checking in every {info.checkin_interval_minutes} minutes.
          </p>
          {needsConsent && (
            <p className="rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
              Please read and agree to the monitoring notice before you start. <Link to="/tech/safety" className="font-semibold underline">Open safety settings</Link>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void start(false)} disabled={busy !== null || needsConsent} className="focus-ring min-h-[48px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">
              {busy === 'start' ? 'Starting…' : 'Start check-in'}
            </button>
            <button type="button" onClick={() => void start(true)} disabled={busy !== null || needsConsent} className="focus-ring min-h-[48px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary disabled:opacity-50">
              Practice drill
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p role="status" aria-live="polite" className={`flex items-center gap-2 text-sm ${escalating ? 'font-semibold text-danger' : 'text-text-primary'}`}>
            <Clock size={15} aria-hidden="true" />
            {escalating
              ? 'Your team has been alerted. Check in now if you are safe.'
              : dueIn === null
                ? 'Check-in running.'
                : dueIn <= 0
                  ? 'Check-in due now.'
                  : `Next check-in in ${dueIn} min.`}
            {endIn !== null && !escalating && <span className="text-xs text-text-secondary">· job time ends in {Math.max(0, endIn)} min</span>}
          </p>

          <button type="button" onClick={() => void imOk()} disabled={busy !== null} className="focus-ring flex min-h-[56px] w-full items-center justify-center gap-2 rounded-xl bg-success-500 px-4 text-base font-bold text-white disabled:opacity-60">
            <CheckCircle2 size={18} aria-hidden="true" />
            {busy === 'checkin' ? 'Sending…' : "I'm OK"}
          </button>

          <div className="flex flex-wrap gap-2">
            {voiceCheckinSupported() && (
              <button type="button" onClick={() => void voice()} disabled={busy !== null} className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-text-primary disabled:opacity-60">
                <Mic size={14} aria-hidden="true" /> {busy === 'voice' ? 'Listening…' : 'Say it'}
              </button>
            )}
            {[15, 30].map((m) => (
              <button key={m} type="button" onClick={() => void extend(m)} disabled={busy !== null} className="focus-ring min-h-[44px] rounded-lg border border-border px-3 text-sm font-semibold text-text-primary disabled:opacity-60">+{m} min</button>
            ))}
            <button type="button" onClick={() => void finish('completed')} disabled={busy !== null} className="focus-ring min-h-[44px] rounded-lg border border-border px-3 text-sm font-semibold text-text-primary disabled:opacity-60">Finished safely</button>
            <button type="button" onClick={() => void finish('false_alarm')} disabled={busy !== null} className="focus-ring min-h-[44px] rounded-lg px-3 text-sm font-semibold text-text-secondary underline disabled:opacity-60">False alarm</button>
          </div>

          {sessionId && <DuressButton sessionId={sessionId} onRaised={() => void load()} />}
          {smsHref && (
            <a href={smsHref} className="focus-ring inline-block text-xs font-semibold text-accent underline">No signal? Send HELP by text message</a>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-text-secondary">{EMERGENCY_SERVICES_NOTICE}</p>
    </section>
  );
}
