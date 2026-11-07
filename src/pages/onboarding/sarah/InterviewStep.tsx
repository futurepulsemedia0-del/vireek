import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { ApiError, interview, type InterviewState } from './sarahLearnApi';

interface Props {
  runId: string;
  locale: 'en' | 'es';
  onDone: () => void;
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognition(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function InterviewStep({ runId, locale, onDone }: Props) {
  const { t } = useTranslation('sarahLearn');
  const [state, setState] = useState<InterviewState | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const Rec = typeof window !== 'undefined' ? getRecognition() : null;

  const call = useCallback(
    async (action: 'next' | 'answer' | 'skip', q?: string, a?: string) => {
      setBusy(true);
      setError('');
      try {
        const s = await interview(runId, action, q, a);
        setState(s);
        setAnswer('');
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('interview.error'));
      } finally {
        setBusy(false);
      }
    },
    [runId, t],
  );

  useEffect(() => {
    void call('next');
    return () => recRef.current?.stop();
  }, [call]);

  const toggleMic = () => {
    if (!Rec) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Rec();
    rec.lang = locale === 'es' ? 'es-US' : 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0]?.transcript ?? '').join(' ').trim();
      if (text) setAnswer((prev) => `${prev} ${text}`.trim().slice(0, 600));
    };
    rec.onerror = () => {
      setError(t('interview.micError'));
      setListening(false);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      setError(t('interview.micError'));
    }
  };

  const q = state?.question ?? null;

  return (
    <section aria-labelledby="sl-interview" className="space-y-5">
      <div>
        <h2 id="sl-interview" className="text-xl font-bold text-text-primary">
          {t('interview.heading')}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">{t('interview.intro')}</p>
      </div>

      {!state && busy && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <MiniLoader /> {t('interview.loading')}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {state?.done && (
        <div className="space-y-4">
          <p className="text-text-primary">{t('interview.complete')}</p>
          <Button onClick={onDone}>{t('interview.continue')}</Button>
        </div>
      )}

      {q && (
        <div className="space-y-4">
          <p aria-live="polite" className="rounded-2xl border border-border bg-bg-primary p-4 text-base text-text-primary">
            {q.text}
          </p>
          {q.choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {q.choices.map((c) => (
                <Button key={c.value} variant="secondary" size="sm" disabled={busy} onClick={() => setAnswer(c.value)}>
                  {c.label}
                </Button>
              ))}
            </div>
          )}
          <Textarea label={t('interview.answerLabel')} value={answer} onChange={(e) => setAnswer(e.target.value.slice(0, 600))} rows={3} disabled={busy} />
          {!Rec && <p className="text-xs text-text-secondary">{t('interview.micUnsupported')}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || !answer.trim()} loading={busy} onClick={() => call('answer', q.id, answer)}>
              {t('interview.send')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => call('skip', q.id)}>
              {t('interview.skip')}
            </Button>
            {Rec && (
              <Button variant="secondary" onClick={toggleMic} selected={listening} disabled={busy} aria-pressed={listening}>
                {listening ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                {listening ? t('interview.micStop') : t('interview.mic')}
              </Button>
            )}
          </div>
          <p role="status" className="text-xs text-text-secondary">
            {listening ? t('interview.listening') : t('interview.remaining', { count: state?.remaining ?? 0, seconds: state?.estimate_seconds ?? 0 })}
          </p>
        </div>
      )}

      {!state?.done && (
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t('interview.skipAll')}
        </Button>
      )}
    </section>
  );
}
