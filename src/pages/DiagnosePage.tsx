// src/pages/DiagnosePage.tsx
//
// Public, token-gated customer intake for the Adaptive Customer Diagnostic (/diagnose/:token).
// One question per screen, large tap targets, always a "Not sure" escape. The customer never sees
// diagnoses or probabilities — only questions; the technician receives the result.

import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, ShieldAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { addNote, answerQuestion, startDiagnostic } from '@/lib/adaptiveDiagnosticApi';
import { progressPercent, type StepResponse } from '@/lib/adaptiveDiagnostic';

type Phase = 'safety' | 'describe' | 'asking';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-6 shadow-card sm:p-8';
const CHOICE =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-4 text-left text-base font-medium text-text-primary transition-colors hover:border-accent/50 hover:bg-bg-tertiary active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60';

export function DiagnosePage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>('safety');
  const [text, setText] = useState('');
  const [step, setStep] = useState<StepResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState('');
  const [extraSent, setExtraSent] = useState(false);

  const run = useCallback(async (fn: () => Promise<StepResponse>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      setStep(res);
      setPhase('asking');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!token) return null;

  const begin = (hazard: boolean) => run(() => startDiagnostic(token, { hazard, text }));
  const answer = (code: string, id: string) => step && run(() => answerQuestion(token, step.sessionId, code, id));
  const sendExtra = async () => {
    if (!step || extra.trim().length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addNote(token, step.sessionId, extra);
      setExtraSent(true);
      setStep(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const q = step?.question ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10 sm:py-14">
        <div className="mx-auto w-full max-w-xl space-y-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step?.hazard ? (
            <section className={`${CARD} border-red-500/40`} aria-live="assertive">
              <ShieldAlert className="mb-3 text-red-500" size={32} />
              <h1 className="text-xl font-bold text-text-primary">Please put safety first</h1>
              <p className="mt-2 text-sm text-text-secondary">
                If you smell gas, see smoke or sparks, or a carbon monoxide alarm is sounding: leave the building now, keep everyone outside, and call
                911 or your gas utility from a safe place. Do not use light switches or devices inside.
              </p>
              <p className="mt-3 text-sm text-text-secondary">Your service provider has been alerted and will contact you.</p>
            </section>
          ) : phase === 'safety' ? (
            <section className={CARD}>
              <h1 className="text-xl font-bold text-text-primary">A quick safety check</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Right now, do you smell gas, see smoke or sparks, or hear a carbon monoxide alarm?
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button type="button" className={CHOICE} disabled={busy} onClick={() => begin(true)}>
                  Yes, something is wrong
                </button>
                <button type="button" className={CHOICE} disabled={busy} onClick={() => setPhase('describe')}>
                  No, nothing like that
                </button>
              </div>
              {busy && <Loader2 className="mx-auto mt-4 animate-spin text-accent" size={20} />}
            </section>
          ) : phase === 'describe' ? (
            <section className={CARD}>
              <h1 className="text-xl font-bold text-text-primary">Tell us what&apos;s going on</h1>
              <p className="mt-2 text-sm text-text-secondary">
                A sentence or two is plenty. Then we&apos;ll ask a few quick questions so your technician arrives prepared.
              </p>
              <div className="mt-4">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, 1000))}
                  rows={4}
                  placeholder="e.g. The AC is running but blowing warm air since this morning."
                  aria-label="Describe the problem"
                />
              </div>
              <Button className="mt-5 w-full" size="lg" disabled={busy} onClick={() => begin(false)}>
                {busy ? <Loader2 className="animate-spin" size={18} /> : null}
                Start
                <ChevronRight size={18} />
              </Button>
            </section>
          ) : step?.status === 'unsupported' ? (
            <section className={CARD}>
              <CheckCircle2 className="mb-3 text-accent" size={30} />
              <h1 className="text-xl font-bold text-text-primary">Thank you</h1>
              <p className="mt-2 text-sm text-text-secondary">We&apos;ve passed your description to your service provider. They&apos;ll follow up if they need anything else.</p>
            </section>
          ) : q ? (
            <section className={CARD} aria-live="polite">
              <div className="mb-5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(step?.answered, step?.estimatedTotal)}>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progressPercent(step?.answered, step?.estimatedTotal)}%` }} />
                </div>
                <p className="mt-2 text-xs text-text-secondary">Question {(step?.answered ?? 0) + 1}</p>
              </div>
              <h1 className="text-xl font-bold text-text-primary">{q.text}</h1>
              {q.help && <p className="mt-1 text-sm text-text-secondary">{q.help}</p>}
              <div className="mt-5 space-y-3">
                {q.options.map((o) => (
                  <button key={o.id} type="button" className={CHOICE} disabled={busy} onClick={() => answer(q.code, o.id)}>
                    {o.label}
                  </button>
                ))}
                <button type="button" className={`${CHOICE} text-text-secondary`} disabled={busy} onClick={() => answer(q.code, 'unsure')}>
                  I&apos;m not sure
                </button>
              </div>
              {busy && <Loader2 className="mx-auto mt-4 animate-spin text-accent" size={20} />}
            </section>
          ) : (
            <section className={CARD} aria-live="polite">
              <CheckCircle2 className="mb-3 text-accent" size={30} />
              <h1 className="text-xl font-bold text-text-primary">Thank you, that&apos;s everything we need</h1>
              <p className="mt-2 text-sm text-text-secondary">Your technician will have your answers before they arrive.</p>
              {!extraSent ? (
                <div className="mt-5">
                  <Textarea
                    value={extra}
                    onChange={(e) => setExtra(e.target.value.slice(0, 1000))}
                    rows={3}
                    label="Anything else we should know? (optional)"
                  />
                  <Button className="mt-3" variant="secondary" disabled={busy || extra.trim().length < 4} onClick={sendExtra}>
                    {busy ? <Loader2 className="animate-spin" size={16} /> : null}
                    Send
                  </Button>
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">Added. Thank you.</p>
              )}
            </section>
          )}
          <p className="px-1 text-center text-xs text-text-secondary">Your answers go only to your service provider.</p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
