// Public, token-gated survey response page (/s/:token). No login. All data access goes through the two
// SECURITY DEFINER RPCs in 20270410000000_post_job_surveys.sql — the token is the only credential.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock, Frown, Loader2, Meh, Smile, SmilePlus, Angry } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { fetchPublicSurvey, submitPublicSurvey, type PublicSurvey } from '@/lib/surveysApi';
import { SCORE_RANGE } from '@/lib/surveys';

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; survey: PublicSurvey };

const CSAT_OPTIONS = [
  { score: 1, label: 'Very unhappy', icon: Angry },
  { score: 2, label: 'Unhappy', icon: Frown },
  { score: 3, label: 'Okay', icon: Meh },
  { score: 4, label: 'Happy', icon: Smile },
  { score: 5, label: 'Very happy', icon: SmilePlus },
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
      <main className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8">
        {children}
      </main>
    </div>
  );
}

function Notice({ icon: Icon, title, body }: { icon: typeof AlertCircle; title: string; body: string }) {
  return (
    <div className="text-center" role="status">
      <Icon size={30} className="mx-auto mb-3 text-text-secondary" aria-hidden="true" />
      <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
      <p className="mt-2 text-sm text-text-secondary">{body}</p>
    </div>
  );
}

export function SurveyResponsePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Private link: keep it out of search engines.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const load = useCallback(async () => {
    if (!token || !UUID_RE.test(token)) {
      setState({ kind: 'missing' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const survey = await fetchPublicSurvey(token);
      setState(survey ? { kind: 'ready', survey } : { kind: 'missing' });
    } catch {
      setState({ kind: 'error' });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!token || score === null || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submitPublicSurvey(token, score, comment);
      if (outcome === 'ok') {
        setDone(true);
      } else if (outcome === 'already_responded') {
        await load();
      } else if (outcome === 'expired') {
        setSubmitError('This survey link has expired.');
      } else {
        setSubmitError("We couldn't record that answer. Please check your choice and try again.");
      }
    } catch {
      setSubmitError('Something went wrong sending your answer. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-secondary" role="status">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </div>
      </Shell>
    );
  }

  if (state.kind === 'error') {
    return (
      <Shell>
        <Notice icon={AlertCircle} title="We couldn't load this survey" body="Check your connection and try again." />
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  if (state.kind === 'missing') {
    return (
      <Shell>
        <Notice
          icon={AlertCircle}
          title="Survey not found"
          body="This link isn't valid. It may have been copied incompletely — please use the link from your message."
        />
      </Shell>
    );
  }

  const { survey } = state;
  const business = survey.business_name?.trim() || 'us';

  if (done || survey.already_responded) {
    return (
      <Shell>
        <div className="text-center" role="status">
          <CheckCircle2 size={36} className="mx-auto mb-3 text-success" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-text-primary">
            {done ? 'Thank you!' : 'You already answered this survey'}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {done ? survey.thank_you_message : `Your feedback for ${business} has been recorded. Thanks again.`}
          </p>
        </div>
      </Shell>
    );
  }

  if (survey.expired) {
    return (
      <Shell>
        <Notice icon={Clock} title="This survey has expired" body={`The feedback window for ${business} has closed.`} />
      </Shell>
    );
  }

  const isNps = survey.survey_type === 'nps';
  const { min, max } = SCORE_RANGE[survey.survey_type];
  const nps = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <Shell>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
        {survey.business_name ? survey.business_name : 'Your feedback'}
      </p>
      <h1 className="mt-1 text-xl font-semibold text-text-primary" id="survey-question">
        {survey.customer_first_name && survey.customer_first_name !== 'there' ? `${survey.customer_first_name}, ` : ''}
        {survey.question}
      </h1>

      <div className="mt-6" role="radiogroup" aria-labelledby="survey-question">
        {isNps ? (
          <>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
              {nps.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={score === n}
                  aria-label={`${n} out of ${max}`}
                  onClick={() => setScore(n)}
                  className={`focus-ring min-h-[44px] rounded-xl border text-base font-semibold transition-colors ${
                    score === n
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-bg-primary text-text-primary hover:border-accent/50'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-xs text-text-secondary">
              <span>Not likely at all</span>
              <span>Extremely likely</span>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-5 gap-2">
            {CSAT_OPTIONS.map(({ score: s, label, icon: Icon }) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={score === s}
                aria-label={label}
                onClick={() => setScore(s)}
                className={`focus-ring flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-[11px] font-medium leading-tight transition-colors ${
                  score === s
                    ? 'border-accent bg-accent text-white'
                    : 'border-border bg-bg-primary text-text-secondary hover:border-accent/50'
                }`}
              >
                <Icon size={22} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {score !== null && (
        <div className="mt-6">
          <Textarea
            label={survey.follow_up_question || 'Anything else you would like to tell us? (optional)'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Your comments are read by the owner."
          />
        </div>
      )}

      {submitError && (
        <p className="mt-4 text-sm text-danger" role="alert">
          {submitError}
        </p>
      )}

      <Button className="mt-6 w-full" disabled={score === null || submitting} onClick={() => void submit()}>
        {submitting ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Sending…
          </>
        ) : (
          'Submit feedback'
        )}
      </Button>
    </Shell>
  );
}
