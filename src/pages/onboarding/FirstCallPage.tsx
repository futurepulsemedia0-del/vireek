import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, Check, Mic, Phone, PhoneOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { getVapiClient, VAPI_DEMO_ASSISTANT_ID } from '@/lib/vapi';
import { SarahOrb, type SarahState } from '@/components/sarah/SarahOrb';
import {
  FirstCallError, HOURS_PRESETS, adviceFor, cancelFirstCall, failureCopy, fetchBooking, fetchSession, fetchTranscript, isTerminal,
  parseDestination, saveQuickSetup, secondsBetween, stagesOf, startFirstCall, trackFirstCallOnce,
  type BookingSummary, type FirstCallSession, type TranscriptLine,
} from '@/lib/firstCall';

const TRADES = [
  { value: 'hvac', label: 'HVAC' }, { value: 'plumbing', label: 'Plumbing' }, { value: 'electrical', label: 'Electrical' },
  { value: 'roofing', label: 'Roofing' }, { value: 'general_home_services', label: 'General home services' }, { value: 'other', label: 'Other' },
];
const INPUT = 'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3.5 text-sm text-text-primary';
const BTN = 'focus-ring inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition-all disabled:opacity-60';
const PRIMARY = `${BTN} bg-accent text-white hover:brightness-110`;
const SECONDARY = `${BTN} border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary`;

type Phase = 'setup' | 'call';

function orbFor(s: FirstCallSession | null, browserLive: boolean): SarahState {
  if (browserLive) return 'listening';
  if (!s) return 'idle';
  if (s.status === 'in_call') return s.first_transcript_at ? 'speaking' : 'listening';
  if (s.status === 'ringing' || s.status === 'created') return 'thinking';
  if (s.status === 'waiting_for_number') return 'offline';
  return 'idle';
}

export function FirstCallPage() {
  const { user, profile } = useAuth();
  const ownerId = user?.id ?? null;
  const [phase, setPhase] = useState<Phase>('setup');

  // ---- setup (business name, trade, hours: nothing else)
  const [name, setName] = useState(profile?.company_name ?? '');
  const [trade, setTrade] = useState('');
  const [preset, setPreset] = useState(HOURS_PRESETS[0].id);
  const [setupErr, setSetupErr] = useState('');
  const [saving, setSaving] = useState(false);

  // ---- call
  const [phone, setPhone] = useState('');
  const [notify, setNotify] = useState(false);
  const [phoneErr, setPhoneErr] = useState('');
  const [session, setSession] = useState<FirstCallSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code: string; hint?: string } | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [booking, setBooking] = useState<BookingSummary | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [browserLive, setBrowserLive] = useState(false);
  const [browserErr, setBrowserErr] = useState('');
  const levelRef = useRef(0);
  const sessionRef = useRef<FirstCallSession | null>(null);
  sessionRef.current = session;

  const applySession = useCallback((s: FirstCallSession | null) => {
    if (!s) return;
    setSession((prev) => (prev && prev.id !== s.id ? prev : s));
  }, []);

  // Realtime + 2 s polling (the poll alone is enough; Realtime just makes it instant).
  useRealtimeSubscription({
    channelName: `first-call-${session?.id ?? 'none'}`, table: 'first_call_sessions', event: 'UPDATE',
    filter: session ? `id=eq.${session.id}` : undefined, enabled: !!session && !isTerminal(session.status),
    onChange: (p) => applySession(p.new as unknown as FirstCallSession),
  });
  useEffect(() => {
    if (!session || isTerminal(session.status)) return;
    const id = window.setInterval(() => {
      void fetchSession(session.id).then(applySession).catch(() => undefined);
      setNowMs(Date.now());
    }, 2000);
    return () => window.clearInterval(id);
  }, [session, applySession]);

  // Transcript + booking follow the session.
  const vapiId = (session as (FirstCallSession & { vapi_call_id?: string }) | null)?.vapi_call_id;
  useEffect(() => {
    if (!session || session.channel !== 'phone' || !session.answered_at) return;
    let stop = false;
    const pull = async () => {
      const vid = vapiId ?? (await vapiLookup(session.id));
      if (vid && !stop) setLines(await fetchTranscript(vid));
    };
    void pull();
    const id = window.setInterval(() => !isTerminal(sessionRef.current?.status ?? 'created') && void pull(), 2500);
    return () => { stop = true; window.clearInterval(id); };
  }, [session?.id, session?.answered_at, session?.status, vapiId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (session?.job_id) void fetchBooking(session.job_id).then(setBooking);
  }, [session?.job_id]);
  useEffect(() => { if (session) trackFirstCallOnce(session); }, [session]);

  const onSaveSetup = async () => {
    if (!ownerId) return;
    if (name.trim().length < 2) return setSetupErr('Enter your business name.');
    if (!trade) return setSetupErr('Choose your trade.');
    setSetupErr(''); setSaving(true);
    try {
      await saveQuickSetup(ownerId, { companyName: name, industry: trade, hours: HOURS_PRESETS.find((p) => p.id === preset)!.hours });
      setPhase('call');
    } catch {
      setSetupErr('We couldn’t save that. Check your connection and try again.');
    } finally { setSaving(false); }
  };

  const ringMe = async () => {
    const d = parseDestination(phone);
    if (!d.ok) return setPhoneErr(d.hint);
    setPhoneErr(''); setErr(null); setBusy(true); setLines([]); setBooking(null);
    try {
      const r = await startFirstCall({ channel: 'phone', phone, notifyWhenReady: notify });
      setSession(r.session);
    } catch (e) {
      const fe = e as FirstCallError;
      if (fe.code === 'invalid_number' || fe.code === 'unsupported_destination') setPhoneErr(fe.hint ?? '');
      else setErr({ code: fe.code, hint: fe.hint });
    } finally { setBusy(false); }
  };

  const cancel = async () => { if (session) { const r = await cancelFirstCall(session.id).catch(() => null); if (r?.session) setSession(r.session); } };

  // ---- in-browser fallback (existing demo assistant; transcript from the SDK, no booking tools on that assistant)
  const talkInBrowser = async () => {
    setBrowserErr(''); setLines([]); setBooking(null);
    try {
      const rec = await startFirstCall({ channel: 'browser' }).catch(() => null);
      if (rec?.session) setSession(rec.session);
      const vapi = getVapiClient();
      vapi.removeAllListeners();
      vapi.on('call-start', () => setBrowserLive(true));
      vapi.on('call-end', () => setBrowserLive(false));
      vapi.on('volume-level', (v: number) => { levelRef.current = v; });
      vapi.on('error', () => { setBrowserLive(false); setBrowserErr('The browser call couldn’t connect. Check that the microphone is allowed for this site.'); });
      vapi.on('message', (m: { type?: string; transcriptType?: string; role?: string; transcript?: string }) => {
        if (m.type === 'transcript' && m.transcriptType === 'final' && m.transcript)
          setLines((l) => [...l, { id: l.length + 1, role: m.role === 'user' ? 'caller' : 'assistant', content: m.transcript as string }]);
      });
      await vapi.start(VAPI_DEMO_ASSISTANT_ID, { variableValues: { company_name: name || 'your business', assistant_name: 'Sarah', industry: trade || 'home services' } });
    } catch (e) {
      setBrowserErr(e instanceof Error ? e.message : 'The browser call couldn’t start.');
    }
  };
  useEffect(() => () => { try { getVapiClient().stop(); } catch { /* not configured */ } }, []);

  const stages = useMemo(() => (session ? stagesOf(session) : []), [session]);
  const terminal = !!session && isTerminal(session.status);
  const advice = session ? adviceFor(session, nowMs) : 'none';
  const copy = session?.failure_code ? failureCopy(session.failure_code) : null;
  const success = session?.status === 'completed' || (session?.status === 'in_call' && !!session.first_transcript_at);
  const seconds = session ? secondsBetween(session.signup_at, session.answered_at) : null;
  const inProgress = !!session && !terminal;

  return (
    <main className="mx-auto max-w-xl px-4 py-8 sm:py-12">
      <div className="flex items-center gap-3">
        <SarahOrb state={phase === 'setup' ? 'idle' : orbFor(session, browserLive)} size={48} amplitudeRef={levelRef} decorative />
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-primary">{phase === 'setup' ? 'Meet Sarah in about a minute' : 'Call Sarah now'}</h1>
          <p className="text-sm text-text-secondary">{phase === 'setup' ? 'Three quick answers, then she rings your phone.' : 'She will answer as your business.'}</p>
        </div>
      </div>

      {phase === 'setup' && (
        <form className="mt-8 space-y-5" onSubmit={(e) => { e.preventDefault(); void onSaveSetup(); }} noValidate>
          <label className="block text-sm font-medium text-text-primary">Business name
            <input className={`${INPUT} mt-1.5`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" aria-invalid={!!setupErr && name.trim().length < 2} />
          </label>
          <label className="block text-sm font-medium text-text-primary">Trade
            <select className={`${INPUT} mt-1.5`} value={trade} onChange={(e) => setTrade(e.target.value)}>
              <option value="">Choose…</option>
              {TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-text-primary">Hours
            <select className={`${INPUT} mt-1.5`} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {HOURS_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="mt-1 block text-xs font-normal text-text-secondary">You can fine-tune each day later.</span>
          </label>
          <p role="alert" className="min-h-[1.25rem] text-sm text-danger">{setupErr}</p>
          <button type="submit" className={`${PRIMARY} w-full`} disabled={saving}>{saving ? 'Saving…' : 'Continue'}</button>
        </form>
      )}

      {phase === 'call' && (
        <div className="mt-8 space-y-5">
          {!session && !browserLive && (
            <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
              <label className="block text-sm font-medium text-text-primary">Your mobile number
                <input className={`${INPUT} mt-1.5`} type="tel" inputMode="tel" autoComplete="tel" placeholder="(512) 555-0123 or +44 7700 900123" value={phone}
                  onChange={(e) => { setPhone(e.target.value); setPhoneErr(''); }} aria-describedby="fc-phone-help" aria-invalid={!!phoneErr} />
                <span id="fc-phone-help" className="mt-1 block text-xs font-normal text-text-secondary">Outside the US or Canada, start with + and your country code. We only use it for this call.</span>
              </label>
              <p role="alert" className="min-h-[1.25rem] text-sm text-danger">{phoneErr}</p>
              <label className="flex min-h-[44px] items-center gap-2.5 text-sm text-text-secondary">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4" />
                If your number isn’t ready yet, text me when it is (one message)
              </label>
              <button type="button" className={`${PRIMARY} w-full`} onClick={() => void ringMe()} disabled={busy}><Phone size={16} aria-hidden="true" />{busy ? 'Starting…' : 'Ring my phone'}</button>
              <button type="button" className={`${SECONDARY} w-full`} onClick={() => void talkInBrowser()}><Mic size={16} aria-hidden="true" />No signal? Talk to Sarah in your browser</button>
              {err && <p role="alert" className="text-sm text-danger">{failureCopy(err.code as never).body}</p>}
            </div>
          )}

          {(session || browserLive) && (
            <section aria-label="Call progress" className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p role="status" aria-live="polite" className="text-sm font-semibold text-text-primary" data-testid="fc-status">
                {browserLive ? 'Sarah is listening in your browser.'
                  : session?.status === 'waiting_for_number' ? failureCopy('number_pending').title
                  : session?.status === 'ringing' || session?.status === 'created' ? (session.channel === 'phone' ? 'Your phone is ringing. Pick up to hear Sarah.' : 'Connecting…')
                  : session?.status === 'in_call' ? 'You’re talking to Sarah.'
                  : success ? 'That was Sarah answering as your business.'
                  : copy?.title ?? 'Call finished.'}
              </p>
              {session && session.channel === 'phone' && (
                <ol className="mt-4 space-y-2" data-testid="fc-stages">
                  {stages.map((s) => (
                    <li key={s.id} className="flex items-center gap-2.5 text-sm" aria-current={s.active ? 'step' : undefined}>
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full ${s.done ? 'bg-success-500 text-white' : s.active ? 'border-2 border-accent' : 'border border-border'}`}>
                        {s.done && <Check size={12} aria-hidden="true" />}
                      </span>
                      <span className={s.done ? 'text-text-primary' : 'text-text-secondary'}>{s.label}{s.done ? '' : s.active ? '…' : ''}</span>
                    </li>
                  ))}
                </ol>
              )}

              {(lines.length > 0 || session?.status === 'in_call' || browserLive) && (
                <div className="mt-5 max-h-64 space-y-2 overflow-y-auto rounded-xl bg-bg-tertiary/60 p-3" role="log" aria-label="Live transcript" data-testid="fc-transcript">
                  {lines.length === 0 && <p className="text-sm text-text-secondary">Waiting for the first words…</p>}
                  {lines.map((l) => (
                    <p key={l.id} className="text-sm"><span className="font-semibold text-text-primary">{l.role === 'assistant' ? 'Sarah' : 'You'}: </span><span className="text-text-secondary">{l.content}</span></p>
                  ))}
                </div>
              )}

              {booking && (
                <div className="mt-4 flex items-start gap-3 rounded-xl border border-success-500/30 bg-success-500/10 p-4" data-testid="fc-booking">
                  <CalendarCheck size={18} aria-hidden="true" className="mt-0.5 text-success-500" />
                  <div className="text-sm">
                    <p className="font-semibold text-text-primary">Booking captured{booking.service_type ? `: ${booking.service_type}` : ''}</p>
                    <p className="text-text-secondary">{booking.scheduled_datetime ? new Date(booking.scheduled_datetime).toLocaleString() : 'Time to be confirmed'}</p>
                    <p className="mt-1 text-xs text-text-secondary">This was a practice booking from your test call. Cancel it from <Link className="underline" to="/dashboard/jobs">Jobs</Link> if you don’t want it. It is never counted in your Today numbers.</p>
                  </div>
                </div>
              )}

              {success && seconds !== null && seconds <= 900 && (
                <p className="mt-4 text-sm text-text-secondary" data-testid="fc-celebrate">Done in {seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} min`} from sign-up. Your customers get this, 24/7.</p>
              )}

              {terminal && copy && (
                <div role="alert" className="mt-4 rounded-xl bg-bg-tertiary/60 p-4 text-sm"><p className="font-semibold text-text-primary">{copy.title}</p><p className="mt-1 text-text-secondary">{copy.body}</p></div>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                {inProgress && <button type="button" className={SECONDARY} onClick={() => void cancel()}><PhoneOff size={16} aria-hidden="true" />Cancel</button>}
                {browserLive && <button type="button" className={SECONDARY} onClick={() => getVapiClient().stop()}><PhoneOff size={16} aria-hidden="true" />End call</button>}
                {(terminal && !success) && <button type="button" className={PRIMARY} onClick={() => { setSession(null); setLines([]); }}>Try again</button>}
                {(advice === 'offer_browser' || (terminal && !success)) && !browserLive && <button type="button" className={SECONDARY} onClick={() => void talkInBrowser()}><Mic size={16} aria-hidden="true" />Talk in your browser instead</button>}
              </div>
              {browserErr && <p role="alert" className="mt-3 text-sm text-danger">{browserErr}</p>}
            </section>
          )}

          {(success || (!browserLive && session && terminal)) && (
            <section aria-labelledby="fc-next" className="rounded-2xl border border-border bg-bg-secondary p-5">
              <h2 id="fc-next" className="text-sm font-semibold text-text-primary">Next steps</h2>
              <ul className="mt-3 space-y-1">
                {[['/onboarding', 'Finish setup: calendar, services and greeting'], ['/dashboard/phone-numbers', 'Forward your business line to Sarah'], ['/dashboard/today', 'See Sarah’s results on your Today screen']].map(([to, label]) => (
                  <li key={to}><Link to={to} className="focus-ring flex min-h-[44px] items-center rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent/10">{label}</Link></li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

/** vapi_call_id is not in the public column list on purpose; resolve it once when the transcript is first needed. */
async function vapiLookup(sessionId: string): Promise<string | null> {
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.from('first_call_sessions').select('vapi_call_id').eq('id', sessionId).maybeSingle();
  return (data as { vapi_call_id: string | null } | null)?.vapi_call_id ?? null;
}
