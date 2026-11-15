import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SkeletonBlock } from '@/components/loading';
import { SarahOrb } from '@/components/sarah/SarahOrb';
import { useAuth } from '@/contexts/AuthContext';
import { isSnoozed, normalizeWebsite } from '@/lib/sarahKnowledge';
import { ApiError, interview, track, type InterviewState } from '@/pages/onboarding/sarah/sarahLearnApi';
import { KnowledgeRing } from './KnowledgeRing';
import { HUB_NS } from './sarahHubI18n';
import { useSarahKnowledge } from './useSarahKnowledge';

const CARD = 'rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark';
const HUB = '/dashboard/sarah';
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (userId: string) => `vireek.sarahKnowledge.snoozedUntil.${userId}`;

function readSnooze(userId: string): string | null {
  try {
    return window.localStorage.getItem(snoozeKey(userId));
  } catch {
    return null;
  }
}
function writeSnooze(userId: string, until: number): void {
  try {
    window.localStorage.setItem(snoozeKey(userId), String(until));
  } catch {
    /* storage unavailable: the card simply stays expanded */
  }
}

/**
 * The dashboard's "teach Sarah" surface. Never blocks anything: the owner can ignore it,
 * snooze it for a day, or finish it in small pieces. Hidden for people who cannot edit the
 * business profile (RLS would return nothing for them anyway).
 */
export function SarahKnowledgeCard() {
  const { t, i18n } = useTranslation(HUB_NS);
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const allowed = !!user && (isOwner || permissions.can_edit_business_profile);
  const { status, run, snapshot, refresh } = useSarahKnowledge(allowed);

  const [snoozedRaw, setSnoozedRaw] = useState<string | null>(null);
  const [site, setSite] = useState('');
  const [siteError, setSiteError] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (user) setSnoozedRaw(readSnooze(user.id));
  }, [user]);

  useEffect(() => {
    if (status === 'ready') track('card_view', { stage: snapshot.stage, score: snapshot.score });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, snapshot.stage]);

  const startWithSite = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const normalized = normalizeWebsite(site);
      if (!normalized) {
        setSiteError(t('card.notStarted.urlInvalid'));
        return;
      }
      setSiteError('');
      track('card_start_site');
      navigate(`${HUB}?website=${encodeURIComponent(normalized)}`);
    },
    [navigate, site, t],
  );

  if (!allowed) return null;

  if (status === 'idle' || status === 'loading') {
    return <SkeletonBlock className="h-[132px] w-full rounded-2xl" />;
  }

  if (status === 'error') {
    return (
      <div role="alert" className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-text-primary`}>
        <span>{t('card.error.load')}</span>
        <Button variant="ghost" size="sm" onClick={() => void refresh(false)}>
          {t('card.error.retry')}
        </Button>
      </div>
    );
  }

  const { stage, score, tier, gaps, next } = snapshot;
  const scoreAria = t('card.scoreAria', { score });
  const scoreText = t('card.scoreLabel', { score });

  if (stage === 'not_started') {
    return (
      <section aria-labelledby="sk-title" className={`${CARD} p-5 sm:p-6`} data-testid="sarah-knowledge-card" data-stage="not_started">
        <div className="flex items-start gap-4">
          <SarahOrb state="idle" size={48} decorative />
          <div className="min-w-0 flex-1">
            <h3 id="sk-title" className="text-lg font-semibold text-text-primary">
              {t('card.notStarted.title')}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t('card.notStarted.body')}</p>
            <form onSubmit={startWithSite} noValidate className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex-1">
                <Input
                  label={t('card.notStarted.urlLabel')}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  value={site}
                  onChange={(e) => {
                    setSite(e.target.value.slice(0, 500));
                    if (siteError) setSiteError('');
                  }}
                  placeholder={t('card.notStarted.urlPlaceholder')}
                  error={siteError}
                />
              </div>
              <Button type="submit" className="sm:mt-[26px]" disabled={!site.trim()}>
                {t('card.notStarted.start')}
              </Button>
            </form>
            <Link to={HUB} onClick={() => track('card_no_site')} className="focus-ring mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-accent hover:underline">
              {t('card.notStarted.noSite')}
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const nowMs = Date.now();
  const snoozed = stage !== 'live' && !!user && isSnoozed(snoozedRaw, nowMs);

  if (stage === 'live') {
    // Live and nothing meaningful left to teach: stay out of the way.
    if (gaps.length === 0 || score >= 95) return null;
    return (
      <section aria-labelledby="sk-title" className={`${CARD} flex flex-wrap items-center gap-4 px-4 py-3`} data-testid="sarah-knowledge-card" data-stage="live">
        <KnowledgeRing size={44} score={score} label={scoreAria} valueText={scoreText} />
        <div className="min-w-0 flex-1">
          <h3 id="sk-title" className="text-sm font-semibold text-text-primary">
            {t('card.stage.live.title')}
          </h3>
          <p className="text-xs text-text-secondary">{t('card.stage.live.body', { n: gaps.length })}</p>
        </div>
        <Link to={HUB} className="focus-ring inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent/10">
          {t('card.cta.maintain')}
        </Link>
      </section>
    );
  }

  if (snoozed) {
    return (
      <section aria-label={t('card.region')} className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-4 py-2`} data-testid="sarah-knowledge-card" data-stage={stage} data-snoozed="true">
        <span className="flex items-center gap-3 text-sm text-text-primary">
          <KnowledgeRing size={32} score={score} label={scoreAria} valueText="" />
          {t('card.snoozed', { score })}
        </span>
        <Link to={HUB} className="focus-ring inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent/10">
          {t('card.continue')}
        </Link>
      </section>
    );
  }

  const ctaTo = HUB;
  return (
    <section aria-labelledby="sk-title" className={`${CARD} p-5`} data-testid="sarah-knowledge-card" data-stage={stage}>
      <div className="flex items-start gap-4">
        <KnowledgeRing size={64} score={score} label={scoreAria} valueText={scoreText} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{t(`card.tier.${tier}`)}</p>
          <h3 id="sk-title" className="text-lg font-semibold text-text-primary">
            {t(`card.stage.${stage}.title`)}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t(`card.stage.${stage}.body`, { score, n: gaps.length })}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {next === 'answer' && run ? (
              <Button
                onClick={() => {
                  track('card_inline_open');
                  setAsking(true);
                }}
                disabled={asking}
              >
                {t('card.cta.answer')}
              </Button>
            ) : (
              <Button onClick={() => navigate(ctaTo)}>{t(`card.cta.${next}`)}</Button>
            )}
            {next === 'answer' && (
              <Link to={ctaTo} className="focus-ring inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent/10">
                {t('card.continue')}
              </Link>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                if (!user) return;
                const until = Date.now() + SNOOZE_MS;
                writeSnooze(user.id, until);
                setSnoozedRaw(String(until));
                setAsking(false);
                track('card_snooze');
              }}
            >
              {t('card.notNow')}
            </Button>
          </div>
        </div>
      </div>
      {asking && run && (
        <InlineQuestion
          runId={run.id}
          language={i18n.language}
          onClose={() => setAsking(false)}
          onAnswered={() => void refresh(true)}
          onReview={() => navigate(ctaTo)}
        />
      )}
    </section>
  );
}

interface InlineProps {
  runId: string;
  language: string;
  onClose: () => void;
  onAnswered: () => void;
  onReview: () => void;
}

/** One next-best question from the same server planner the wizard uses, answered without leaving the dashboard. */
function InlineQuestion({ runId, onClose, onAnswered, onReview }: InlineProps) {
  const { t } = useTranslation(HUB_NS);
  const [state, setState] = useState<InterviewState | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const call = useCallback(
    async (action: 'next' | 'answer' | 'skip', q?: string, a?: string) => {
      setBusy(true);
      setError('');
      try {
        const s = await interview(runId, action, q, a);
        setState(s);
        setAnswer('');
        if (action === 'answer') {
          setSaved(true);
          onAnswered();
        }
      } catch (e) {
        setError(e instanceof ApiError && e.message ? e.message : t('card.inline.error'));
      } finally {
        setBusy(false);
      }
    },
    [onAnswered, runId, t],
  );

  useEffect(() => {
    void call('next');
  }, [call]);

  const q = state?.question ?? null;

  return (
    <div className="mt-5 border-t border-border pt-5" data-testid="sarah-inline-question">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-text-primary">{t('card.inline.heading')}</h4>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('card.inline.close')}
        </Button>
      </div>

      {!state && busy && (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {t('card.inline.loading')}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {t('card.inline.saved')}
        </p>
      )}

      {state?.done && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-text-primary">{t('card.inline.done')}</p>
          <Button onClick={onReview}>{t('card.inline.reviewCta')}</Button>
        </div>
      )}

      {q && (
        <div className="mt-3 space-y-3">
          <p aria-live="polite" className="rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary">
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
          <Textarea label={t('card.inline.answerLabel')} value={answer} onChange={(e) => setAnswer(e.target.value.slice(0, 600))} rows={3} disabled={busy} />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !answer.trim()} loading={busy} onClick={() => void call('answer', q.id, answer)}>
              {t('card.inline.send')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void call('skip', q.id)}>
              {t('card.inline.skip')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
