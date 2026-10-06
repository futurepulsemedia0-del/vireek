import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Clock, Loader2, Mic, ShieldCheck, Square, Truck, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { LIMITS, SAFETY_GUIDANCE, pendingStep, respondErrorMessage, stepsProgress, timeLeftLabel, type RrRoom } from '@/lib/remoteResolution';
import {
  RrError,
  confirmOutcome,
  fetchRoom,
  fileToJpegBase64,
  reportProblemBack,
  requestVisit,
  startRecording,
  submitCustomerTurn,
  type Recorder,
  type TurnInput,
} from '@/lib/remoteResolutionApi';

const POLL_MS = 20_000;

interface Props {
  token: string;
  onRoomLoaded?: (room: RrRoom | null) => void;
}

export function RemoteResolutionCustomerPanel({ token, onRoomLoaded }: Props) {
  const [room, setRoom] = useState<RrRoom | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('');
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<Recorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const apply = useCallback(
    (r: RrRoom | null) => {
      setRoom(r);
      onRoomLoaded?.(r);
    },
    [onRoomLoaded],
  );

  const load = useCallback(async () => apply(await fetchRoom(token)), [apply, token]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (!busyRef.current && !document.hidden) void load();
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      recorderRef.current?.cancel();
    };
  }, [load]);

  // A new question starts with a clean answer box.
  const questionId = room?.case?.next_question?.id;
  useEffect(() => {
    setText('');
    setChoice('');
  }, [questionId]);

  const run = async (fn: () => Promise<RrRoom | null | void>) => {
    if (busyRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) apply(next);
      else await load();
    } catch (e) {
      const err = e instanceof RrError ? e : new RrError('Something went wrong. Please try again.');
      setError(err.code ? respondErrorMessage(err.code) : err.message);
      if (err.code === 'stale_question' || err.code === 'stale_step' || err.code === 'not_active') await load();
    } finally {
      setBusy(false);
    }
  };

  const send = (input: TurnInput) => run(() => submitCustomerTurn(token, input));

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await run(async () => submitCustomerTurn(token, { photoBase64: await fileToJpegBase64(file) }));
  };

  const toggleRecording = async () => {
    if (recording) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!rec) return;
      await run(async () => submitCustomerTurn(token, { audioBase64: await rec.stop() }));
      return;
    }
    setError(null);
    try {
      recorderRef.current = await startRecording(() => {
        // Auto-stop at the time limit: upload what was captured.
        const rec = recorderRef.current;
        recorderRef.current = null;
        setRecording(false);
        if (rec) void run(async () => submitCustomerTurn(token, { audioBase64: await rec.stop() }));
      });
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording.');
    }
  };

  if (room === undefined) return <SkeletonCard />;
  if (room === null) return <EmptyState icon={AlertTriangle} title="This link is not valid" description="Please use the link we sent you, or contact the business." />;

  const c = room.case;
  if (!c) {
    return <EmptyState icon={Wrench} title="No remote help is open for this job" description={`${room.business_name ?? 'Your service provider'} has not started a remote check yet.`} />;
  }

  const name = room.customer_first_name ? `, ${room.customer_first_name}` : '';
  const active = c.status === 'intake' || c.status === 'troubleshooting';
  const canPhoto = active && c.photos_used < room.limits.photos;
  const canAudio = active && c.audio_used < room.limits.audio;
  const q = c.next_question;
  const step = pendingStep(c.steps);
  const progress = stepsProgress(c.steps);
  const showRequests = active && !step;

  const errorBox = error && (
    <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      {error}
    </p>
  );

  // ---- terminal states ----------------------------------------------------------
  if (c.status === 'dispatch_required' || c.status === 'reopened') {
    const reasons = c.safety_reasons ?? [];
    return (
      <Card className="space-y-4 p-6">
        <div className="flex items-start gap-3">
          <Truck className={reasons.length ? 'text-danger' : 'text-accent'} size={22} aria-hidden="true" />
          <div>
            <h2 className="text-lg font-bold text-text-primary">
              {c.status === 'reopened' ? `We're sorry it came back${name}` : reasons.length ? `Safety first${name}` : `A technician will take it from here${name}`}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {c.status === 'reopened'
                ? `${room.business_name ?? 'The business'} has been told and will treat this as a priority.`
                : `${room.business_name ?? 'The business'} has everything you shared, so you will not have to repeat yourself.`}
            </p>
          </div>
        </div>
        {reasons.length > 0 && (
          <ul className="space-y-2 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-text-primary">
            {reasons.map((r) => (
              <li key={r}>{SAFETY_GUIDANCE[r]}</li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  if (c.status === 'resolved_pending' || c.status === 'resolved_remotely') {
    return (
      <Card className="space-y-4 p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="text-success-500" size={22} aria-hidden="true" />
          <div>
            <h2 className="text-lg font-bold text-text-primary">Glad it's working{name}</h2>
            <p className="mt-1 text-sm text-text-secondary">
              No visit is needed. If the problem comes back{c.verification_until && c.status === 'resolved_pending' ? ` in the next ${timeLeftLabel(c.verification_until).replace(' left', '')}` : ''}, tell us here and we will send a technician with priority.
            </p>
          </div>
        </div>
        {errorBox}
        <Button variant="secondary" disabled={busy} onClick={() => run(() => reportProblemBack(token))}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} The problem is back
        </Button>
      </Card>
    );
  }

  if (c.status === 'expired' || c.status === 'withdrawn') {
    return <EmptyState icon={Clock} title="This remote check has ended" description={`${room.business_name ?? 'The business'} will contact you to schedule the next step.`} />;
  }

  // ---- active conversation --------------------------------------------------------
  return (
    <div className="space-y-4">
      <Card className="space-y-1 p-5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <ShieldCheck size={13} aria-hidden="true" /> Try to fix it without a visit - nothing is charged for this
        </p>
        <p className="text-sm text-text-primary">
          <span className="font-semibold">Your problem:</span> {c.symptom}
        </p>
        <p className="text-xs text-text-secondary">If anything feels unsafe, stop and ask for a technician at any time.</p>
      </Card>

      {errorBox}

      {step ? (
        <Card className="space-y-4 p-5">
          <p className="text-xs font-medium text-text-secondary">
            Step {progress.done + 1} of {progress.total} · about {step.minutes} min
          </p>
          <h3 className="text-base font-bold text-text-primary">{step.title}</h3>
          <p className="text-sm text-text-primary">{step.instructions}</p>
          {step.expected && <p className="text-sm text-text-secondary">What should happen: {step.expected}</p>}
          {step.safety_note && (
            <p className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-sm text-text-primary">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" /> {step.safety_note}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => send({ stepResult: { step_id: step.id, result: 'fixed' } })}>
              It's fixed
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => send({ stepResult: { step_id: step.id, result: 'no_change' } })}>
              Nothing changed
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => send({ stepResult: { step_id: step.id, result: 'cannot_do' } })}>
              I can't do this
            </Button>
          </div>
        </Card>
      ) : c.steps.some((s) => s.result === 'fixed') ? (
        <Card className="space-y-3 p-5">
          <h3 className="text-base font-bold text-text-primary">Is everything working now?</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => run(() => confirmOutcome(token, 'fixed'))}>
              Yes, it's working
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => confirmOutcome(token, 'not_fixed'))}>
              No, send a technician
            </Button>
          </div>
        </Card>
      ) : q ? (
        <Card className="space-y-4 p-5">
          <h3 className="text-base font-bold text-text-primary">{q.text}</h3>
          {q.why && <p className="text-xs text-text-secondary">{q.why}</p>}
          {q.type === 'yes_no' && (
            <div className="flex flex-wrap gap-2">
              {['yes', 'no', 'not sure'].map((v) => (
                <Button key={v} size="sm" variant="secondary" disabled={busy} onClick={() => send({ answers: [{ question_id: q.id, value: v }] })} className="capitalize">
                  {v}
                </Button>
              ))}
            </div>
          )}
          {q.type === 'choice' && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <Button key={o} size="sm" variant="secondary" disabled={busy} onClick={() => send({ answers: [{ question_id: q.id, value: o }] })}>
                  {o}
                </Button>
              ))}
            </div>
          )}
          {(q.type === 'text' || q.type === 'number') && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void send({ answers: [{ question_id: q.id, value: text.trim() }] });
              }}
            >
              {q.type === 'number' ? (
                <Input label="Your answer" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} maxLength={14} />
              ) : (
                <Textarea label="Your answer" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.freeText} />
              )}
              <Button size="sm" type="submit" disabled={busy || !text.trim()}>
                {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Send
              </Button>
            </form>
          )}
        </Card>
      ) : (
        <Card className="space-y-3 p-5">
          <h3 className="text-base font-bold text-text-primary">Anything else we should know?</h3>
          <Textarea label="Extra details" rows={3} value={choice} onChange={(e) => setChoice(e.target.value)} maxLength={LIMITS.freeText} />
          <Button size="sm" disabled={busy || !choice.trim()} onClick={() => send({ freeText: choice })}>
            Send
          </Button>
        </Card>
      )}

      {showRequests && (canPhoto || canAudio) && (
        <Card className="space-y-3 p-5">
          <h3 className="text-sm font-semibold text-text-primary">Help us see and hear it (optional)</h3>
          {c.photo_request && canPhoto && <p className="text-sm text-text-secondary">{c.photo_request}</p>}
          {c.audio_request && canAudio && <p className="text-sm text-text-secondary">{c.audio_request}</p>}
          <div className="flex flex-wrap gap-2">
            {canPhoto && (
              <>
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onPhoto} aria-label="Take or choose a photo" />
                <Button size="sm" variant="secondary" disabled={busy || recording} onClick={() => fileRef.current?.click()}>
                  <Camera size={15} aria-hidden="true" /> Add a photo
                </Button>
              </>
            )}
            {canAudio && (
              <Button size="sm" variant={recording ? 'primary' : 'secondary'} disabled={busy} onClick={toggleRecording} aria-pressed={recording}>
                {recording ? <Square size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
                {recording ? `Stop and send (max ${LIMITS.audioSeconds}s)` : 'Record the sound'}
              </Button>
            )}
          </div>
          <p className="text-xs text-text-secondary">Photos are resized on your device. Please do not include people or documents.</p>
        </Card>
      )}

      {busy && (
        <p className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Working on it...
        </p>
      )}

      <div className="border-t border-border pt-4">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => requestVisit(token))}>
          <Truck size={15} aria-hidden="true" /> I'd rather have a technician come
        </Button>
      </div>
    </div>
  );
}
