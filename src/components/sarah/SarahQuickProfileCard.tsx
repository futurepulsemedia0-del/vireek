import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { trackEvent } from '@/lib/analytics';
import { fetchQualificationStatus, saveQualification } from '@/lib/signupQualification';
import {
  QUALIFICATION_QUESTIONS,
  SARAH_CARD_WINDOW_MS,
  hasAnyAnswer,
  shouldPromptQualification,
  type QualAnswers,
  type QuestionId,
} from '@/lib/signupQualificationCore';

type Phase = 'checking' | 'hidden' | 'asking' | 'saved';

/** Three tap-only questions shown once, above Sarah's learning flow. Fails quiet: any error hides it. */
export function SarahQuickProfileCard() {
  const { user, profile } = useAuth();
  const userId = user?.id ?? null;

  const eligible = useMemo(
    () =>
      !!userId &&
      !!profile &&
      shouldPromptQualification({
        role: profile.role,
        createdAt: profile.created_at,
        now: Date.now(),
        windowMs: SARAH_CARD_WINDOW_MS,
      }),
    [userId, profile],
  );

  const [phase, setPhase] = useState<Phase>('checking');
  const [answers, setAnswers] = useState<QualAnswers>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!eligible || !userId) {
      setPhase('hidden');
      return;
    }
    let cancelled = false;
    setPhase('checking');
    void fetchQualificationStatus(userId).then((status) => {
      if (cancelled) return;
      if (status === 'pending') {
        setPhase('asking');
        trackEvent('qualify_view', { surface: 'sarah' });
      } else {
        setPhase('hidden');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, userId]);

  const choose = useCallback((id: QuestionId, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    setFailed(false);
    trackEvent('qualify_answer', { surface: 'sarah', question: id, value });
  }, []);

  const finish = useCallback(
    async (skip: boolean) => {
      if (busy) return;
      setBusy(true);
      setFailed(false);
      const payload: QualAnswers = skip ? {} : answers;
      const ok = await saveQualification(payload, skip || !hasAnyAnswer(payload));
      trackEvent(skip ? 'qualify_skip' : 'qualify_complete', {
        surface: 'sarah',
        answered: Object.keys(answers).length,
        saved: ok ? 1 : 0,
      });
      if (ok) setPhase(skip ? 'hidden' : 'saved');
      else if (skip) setPhase('hidden');
      else setFailed(true);
      setBusy(false);
    },
    [answers, busy],
  );

  if (phase === 'checking' || phase === 'hidden') return null;

  if (phase === 'saved') {
    return (
      <p role="status" className="mb-6 flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
        <Check className="h-4 w-4 text-accent" aria-hidden="true" />
        Saved. Thanks, that helps us set your account up the right way.
      </p>
    );
  }

  return (
    <Card interactive={false} className="mb-6 !p-5 sm:!p-6">
      <section aria-labelledby="sqp-title">
        <p id="sqp-title" className="text-base font-semibold text-text-primary">
          Three quick questions about your business
        </p>
        <p className="mt-1 text-sm text-text-secondary">
          One tap each, about 15 seconds. It helps us set up your account the right way, and you can skip it.
        </p>

        <div className="mt-5 space-y-5">
          {QUALIFICATION_QUESTIONS.map((q) => (
            <fieldset key={q.id} className="min-w-0">
              <legend className="mb-2 text-sm font-medium text-text-primary">{q.title}</legend>
              <div className="flex flex-wrap gap-2">
                {q.options.map((o) => {
                  const selected = answers[q.id] === o.value;
                  return (
                    <label key={o.value} className="relative cursor-pointer">
                      <input
                        type="radio"
                        name={`sqp-${q.id}`}
                        value={o.value}
                        checked={selected}
                        onChange={() => choose(q.id, o.value)}
                        className="peer sr-only"
                      />
                      <span className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary peer-checked:border-accent peer-checked:bg-bg-tertiary peer-checked:ring-1 peer-checked:ring-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
                        {selected && <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />}
                        {o.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        {failed && (
          <p role="alert" className="mt-4 text-sm text-danger">
            We couldn’t save that just now. Try again, or skip for now.
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button loading={busy} disabled={busy || !hasAnyAnswer(answers)} onClick={() => void finish(false)}>
            Save
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void finish(true)}>
            Not now
          </Button>
        </div>
      </section>
    </Card>
  );
}
