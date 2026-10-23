import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, ShieldCheck, Square, Trash2, UserCheck, UserX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  analyzeRecording,
  discardRecording,
  fetchRecentJobs,
  recordConsent,
  startSession,
  uploadAndAttach,
  type JobOption,
} from '@/lib/conversationIntelApi';
import {
  buildDisclosureText,
  detectStateFromAddress,
  formatDuration,
  resolveConsentPolicy,
} from '../../../supabase/functions/_shared/conversation-intel/engine';

/**
 * Guided, consent-first recorder. Nothing is captured until BOTH the technician has confirmed the
 * disclosure was given AND the customer has actively agreed. Consent is stored server-side with the
 * exact disclosure text; a "stop & delete" button is always one tap away.
 */

type Step = 'setup' | 'consent' | 'recording' | 'saving' | 'declined';

const MAX_SECONDS = 45 * 60;

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

interface Props {
  companyName: string;
  onFinished: () => void;
  onCancel: () => void;
}

export function ConversationRecorder({ companyName, onFinished, onCancel }: Props) {
  const { toast } = useToast();

  const [step, setStep] = useState<Step>('setup');
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobId, setJobId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [techConfirmed, setTechConfirmed] = useState(false);
  const [verbalConfirmed, setVerbalConfirmed] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const stepRef = useRef<Step>('setup');
  const sessionRef = useRef<string | null>(null);
  stepRef.current = step;
  sessionRef.current = sessionId;

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  useEffect(() => {
    fetchRecentJobs().then(setJobs).catch(() => setJobs([]));
  }, []);

  const policy = useMemo(() => resolveConsentPolicy(stateCode), [stateCode]);
  const disclosure = useMemo(() => buildDisclosureText(policy, companyName), [policy, companyName]);

  const stopHardware = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Leaving mid-recording means the audio cannot be saved: stop the mic and remove the empty session.
  useEffect(() => {
    return () => {
      const recording = stepRef.current === 'recording';
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      stopHardware();
      if (recording && sessionRef.current) void discardRecording(sessionRef.current).catch(() => undefined);
    };
  }, [stopHardware]);

  useEffect(() => {
    if (step !== 'recording') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [step]);

  function handleJobChange(id: string) {
    setJobId(id);
    const job = jobs.find((j) => j.id === id);
    if (job) {
      setCustomerName(job.customer_name);
      setStateCode(detectStateFromAddress(job.address) ?? '');
    }
  }

  async function handleBegin() {
    if (!customerName.trim()) {
      toast('Add the customer’s name first.', 'error');
      return;
    }
    setBusy(true);
    try {
      const id = await startSession({
        jobId: jobId || null,
        customerName: customerName.trim(),
        state: policy.state,
        consentMode: policy.mode,
        disclosureVersion: policy.disclosureVersion,
        disclosureText: disclosure,
      });
      setSessionId(id);
      setStep('consent');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the session.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await recordConsent(sessionId, false, 'tap_on_device');
      setStep('declined');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the decision.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleAgree() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await recordConsent(sessionId, true, policy.requireVerbalConfirmation ? 'both' : 'tap_on_device');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save consent.', 'error');
      setBusy(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24_000 });
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        const secs = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setElapsed(secs);
        if (secs >= MAX_SECONDS) void finish(true);
      }, 1000);
      setStep('recording');
    } catch {
      // Consent was given but the microphone is unavailable: remove the empty session, nothing was captured.
      await discardRecording(sessionId).catch(() => undefined);
      setSessionId(null);
      setStep('setup');
      toast('Microphone access was blocked, so nothing was recorded. Allow the microphone and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function stopRecorder(): Promise<Blob> {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      const type = recorder?.mimeType || 'audio/webm';
      const done = () => {
        stopHardware();
        resolve(new Blob(chunksRef.current, { type }));
      };
      if (!recorder || recorder.state === 'inactive') return done();
      recorder.onstop = done;
      recorder.stop();
    });
  }

  async function finish(save: boolean) {
    if (!sessionId || stepRef.current !== 'recording') return;
    stepRef.current = 'saving';
    setStep('saving');
    const seconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    const blob = await stopRecorder();
    recorderRef.current = null;

    try {
      if (!save) {
        await discardRecording(sessionId);
        toast('Recording stopped and deleted.', 'success');
        onFinished();
        return;
      }
      await uploadAndAttach(sessionId, blob, blob.type, seconds);
      toast('Saved. Analysing the conversation…', 'success');
      try {
        await analyzeRecording(sessionId);
        toast('Analysis complete.', 'success');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Analysis failed — retry from the list.', 'error');
      }
      onFinished();
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Could not save the recording.';
      toast(`${reason} The recording was discarded — please record again.`, 'error');
      await discardRecording(sessionId).catch(() => undefined);
      onFinished();
    }
  }

  if (!supported) {
    return (
      <Card className="!p-5">
        <p className="text-sm text-text-secondary">
          This browser can’t record audio. Open Vireek in an up-to-date Chrome, Safari or Edge on your phone to record conversations.
        </p>
        <div className="mt-3"><Button variant="secondary" size="sm" onClick={onCancel}>Close</Button></div>
      </Card>
    );
  }

  if (step === 'setup') {
    return (
      <Card className="!p-5">
        <div className="flex items-center gap-2 text-text-primary">
          <ShieldCheck size={18} className="text-accent" />
          <h2 className="text-base font-semibold">Record a conversation</h2>
        </div>
        <p className="mt-1 text-sm text-text-secondary">
          You’ll read a short disclosure and the customer decides. Nothing is recorded until they agree.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="ci-job" className="mb-1.5 block text-sm font-medium text-text-primary">Job (optional)</label>
            <select
              id="ci-job"
              value={jobId}
              onChange={(e) => handleJobChange(e.target.value)}
              className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-3 text-sm text-text-primary"
            >
              <option value="">No linked job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.customer_name}{j.address ? ` — ${j.address}` : ''}</option>
              ))}
            </select>
          </div>
          <Input label="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={200} required />
          <Input
            label="State (2 letters)"
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value.toUpperCase().slice(0, 2))}
            helperText={policy.assumedStrictest ? 'Unknown or non-US — the strictest consent rules apply.' : policy.mode === 'all_party' ? 'All-party consent state — a spoken yes is also required.' : 'Customer consent is still required.'}
          />
        </div>
        <div className="mt-5 flex gap-2">
          <Button onClick={handleBegin} disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : null} Continue</Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </Card>
    );
  }

  if (step === 'consent') {
    const ready = techConfirmed && (!policy.requireVerbalConfirmation || verbalConfirmed);
    return (
      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">Ask {customerName || 'the customer'} for permission</h2>
        <p className="mt-1 text-sm text-text-secondary">Read this aloud, or hand them the screen.</p>
        <blockquote className="mt-4 rounded-xl border border-border bg-bg-tertiary p-4 text-sm leading-relaxed text-text-primary">{disclosure}</blockquote>

        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" className="mt-0.5" checked={techConfirmed} onChange={(e) => setTechConfirmed(e.target.checked)} />
            I read this to the customer and I agree to be recorded too.
          </label>
          {policy.requireVerbalConfirmation && (
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-0.5" checked={verbalConfirmed} onChange={(e) => setVerbalConfirmed(e.target.checked)} />
              The customer said “yes” out loud.
            </label>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={handleAgree} disabled={!ready || busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <UserCheck size={16} />} Customer agrees — start recording
          </Button>
          <Button variant="secondary" onClick={handleDecline} disabled={busy}><UserX size={16} /> Customer declines</Button>
        </div>
        <p className="mt-3 text-xs text-text-secondary">Declining has no effect on the service. Nothing is recorded.</p>
      </Card>
    );
  }

  if (step === 'declined') {
    return (
      <Card className="!p-5">
        <p className="text-sm text-text-primary">The customer declined. Nothing was recorded — carry on with the visit as normal.</p>
        <div className="mt-3"><Button variant="secondary" size="sm" onClick={onFinished}>Done</Button></div>
      </Card>
    );
  }

  if (step === 'saving') {
    return (
      <Card className="!p-5">
        <p className="flex items-center gap-2 text-sm text-text-primary"><Loader2 size={16} className="animate-spin" /> Saving and analysing — keep this page open.</p>
      </Card>
    );
  }

  return (
    <Card className="!p-5">
      <div className="flex items-center gap-3">
        <span className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-danger" />
        </span>
        <p className="text-base font-semibold text-text-primary">Recording · {formatDuration(elapsed)}</p>
        <Mic size={16} className="text-text-secondary" />
      </div>
      <p className="mt-1 text-sm text-text-secondary">Everyone present has agreed. If anyone changes their mind, tap “Stop & delete”.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => void finish(true)}><Square size={16} /> Stop & save</Button>
        <Button variant="secondary" onClick={() => void finish(false)}><Trash2 size={16} /> Stop & delete</Button>
      </div>
    </Card>
  );
}
