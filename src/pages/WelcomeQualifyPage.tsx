import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { trackEvent } from '@/lib/analytics';
import { AuthLogo } from '@/components/auth/AuthParts';
import { markQualificationDismissed, saveQualification } from '@/lib/signupQualification';
import {
  QUALIFICATION_QUESTIONS,
  hasAnyAnswer,
  type QualAnswers,
  type QuestionId,
} from '@/lib/signupQualificationCore';

export function WelcomeQualifyPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [answers, setAnswers] = useState<QualAnswers>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const openedAt = useRef(Date.now());
  useEffect(() => {
    trackEvent('qualify_view');
  }, []);

  const answered = Object.keys(answers).length;
  const total = QUALIFICATION_QUESTIONS.length;

  const choose = useCallback((id: QuestionId, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    trackEvent('qualify_answer', { question: id, value });
    setFailed(false);
  }, []);

  const finish = useCallback(
    async (skip: boolean) => {
      if (saving) return;
      setSaving(true);
      setFailed(false);
      const payload: QualAnswers = skip ? {} : answers;
      const ok = await saveQualification(payload, skip || !hasAnyAnswer(payload));
      trackEvent(skip || !hasAnyAnswer(payload) ? 'qualify_skip' : 'qualify_complete', {
        answered: Object.keys(answers).length,
        saved: ok ? 1 : 0,
        seconds: Math.round((Date.now() - openedAt.current) / 1000),
      });
      if (ok) {
        navigate('/dashboard', { replace: true });
        return;
      }
      if (skip) {
        // Never trap the user: remember the dismissal for this session and move on.
        if (user) markQualificationDismissed(user.id);
        navigate('/dashboard', { replace: true });
        return;
      }
      setFailed(true);
      setSaving(false);
    },
    [answers, navigate, saving, user],
  );

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
        <div className="flex items-center gap-2.5">
          <AuthLogo size="h-9 w-9" />
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </div>
        <button
          type="button"
          onClick={() => void finish(true)}
          disabled={saving}
          className="focus-ring min-h-[44px] rounded-lg px-3 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
        >
          Skip for now
        </button>
      </header>

      <main className="flex flex-1 justify-center px-5 pb-28 pt-2 sm:px-8 sm:pb-16 sm:pt-8">
        <div className="w-full max-w-[560px]">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            {answered} of {total} answered
          </p>
          <div
            className="mt-2 h-1 w-full overflow-hidden rounded-full bg-bg-tertiary"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={answered}
            aria-label="Setup questions answered"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${(answered / total) * 100}%` }}
            />
          </div>

          <h1 className="mt-6 text-2xl font-bold tracking-tight text-text-primary sm:text-[28px]">
            Let’s tailor Vireek to your business
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Three quick taps, about 15 seconds. Used only to set up your account, and you can change it anytime.
          </p>

          <div className="mt-8 space-y-8">
            {QUALIFICATION_QUESTIONS.map((q) => (
              <fieldset key={q.id} className="min-w-0">
                <legend className="mb-3 text-sm font-semibold text-text-primary">{q.title}</legend>
                <div className={`grid gap-2.5 ${q.columns === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
                  {q.options.map((o) => {
                    const selected = answers[q.id] === o.value;
                    return (
                      <label key={o.value} className="relative block cursor-pointer">
                        <input
                          type="radio"
                          name={q.id}
                          value={o.value}
                          checked={selected}
                          onChange={() => choose(q.id, o.value)}
                          className="peer sr-only"
                        />
                        <span
                          className="flex min-h-[48px] items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary peer-checked:border-accent peer-checked:bg-bg-tertiary peer-checked:ring-1 peer-checked:ring-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
                        >
                          <span>{o.label}</span>
                          {selected && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>

          {failed && (
            <p role="alert" className="mt-6 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
              We couldn’t save that just now. Try again, or skip — you can finish this later in settings.
            </p>
          )}
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg-primary/95 px-5 py-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:px-8 sm:pb-12 sm:pt-0 sm:backdrop-blur-none">
        <div className="mx-auto w-full max-w-[560px]">
          <button
            type="button"
            onClick={() => void finish(false)}
            disabled={saving}
            className="focus-ring group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-on-accent shadow-sm transition-all duration-200 hover:brightness-110 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : failed ? 'Try again' : 'Continue to dashboard'}
            {!saving && <ArrowRight className="h-[18px] w-[18px] transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}
