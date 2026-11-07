import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { Phone } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { useAuth } from '@/contexts/AuthContext';
import enSarah from '@/locales/en/sarahLearn.json';
import esSarah from '@/locales/es/sarahLearn.json';
import { InterviewStep } from './InterviewStep';
import { ReadinessStep } from './ReadinessStep';
import { ReviewStep } from './ReviewStep';
import { SourcesStep } from './SourcesStep';
import { SuggestionsPanel } from './SuggestionsPanel';
import { ApiError, loadLatestRun, loadRunDetail, track, type ScenarioResultDto } from './sarahLearnApi';
import { formatDuration, type LearnField, type LearnRun, type LearnSource } from './sarahLearnLogic';

// Self-register the namespace so no central i18n file has to change.
if (!i18n.hasResourceBundle('en', 'sarahLearn')) i18n.addResourceBundle('en', 'sarahLearn', enSarah, true, true);
if (!i18n.hasResourceBundle('es', 'sarahLearn')) i18n.addResourceBundle('es', 'sarahLearn', esSarah, true, true);

type Stage = 'sources' | 'interview' | 'review' | 'readiness' | 'live';
const STAGES: Stage[] = ['sources', 'interview', 'review', 'readiness'];

function stageFromRun(run: LearnRun, fieldCount: number): Stage {
  if (run.status === 'live') return 'live';
  if (run.status === 'readiness' || run.status === 'ready') return 'readiness';
  if (run.status === 'review') return 'review';
  if (run.status === 'interviewing') return 'interview';
  return fieldCount > 0 || run.status === 'drafted' ? 'interview' : 'sources';
}

export function SarahLearnPage() {
  const { t, i18n: inst } = useTranslation('sarahLearn');
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const locale: 'en' | 'es' = (inst.language ?? 'en').toLowerCase().startsWith('es') ? 'es' : 'en';

  const [stage, setStage] = useState<Stage>('sources');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [run, setRun] = useState<LearnRun | null>(null);
  const [fields, setFields] = useState<LearnField[]>([]);
  const [sources, setSources] = useState<LearnSource[]>([]);
  const [results, setResults] = useState<ScenarioResultDto[]>([]);
  const [rerunOf, setRerunOf] = useState<string | undefined>();
  const [draftMs, setDraftMs] = useState<number | null>(null);
  const [liveMs, setLiveMs] = useState<number | null>(null);

  const reload = useCallback(async (runId?: string) => {
    const id = runId ?? run?.id;
    if (!id) return;
    const d = await loadRunDetail(id);
    setRun(d.run);
    setFields(d.fields);
    setSources(d.sources);
    setResults(d.results);
  }, [run?.id]);

  // Resume where the owner left off.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const latest = await loadLatestRun();
        if (cancelled) return;
        if (latest) {
          const d = await loadRunDetail(latest.id);
          if (cancelled) return;
          setRun(d.run);
          setFields(d.fields);
          setSources(d.sources);
          setResults(d.results);
          setStage(stageFromRun(d.run, d.fields.length));
          if (d.run.status === 'live' && d.run.live_at) setLiveMs(new Date(d.run.live_at).getTime() - new Date(d.run.started_at).getTime());
          if (d.run.first_draft_at) setDraftMs(new Date(d.run.first_draft_at).getTime() - new Date(d.run.started_at).getTime());
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof ApiError && /permission|denied/i.test(e.message) ? t('page.noPermission') : t('page.loadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  const onDrafted = async (runId: string, info: { fields: number; ms: number }) => {
    setDraftMs(info.ms);
    setRerunOf(undefined);
    await reload(runId);
    setStage('interview');
  };

  const toReview = async () => {
    await reload();
    setStage('review');
  };

  const businessName = (() => {
    const v = fields.find((f) => f.key === 'business_name')?.value;
    return typeof v === 'string' ? v : '';
  })();

  const stepIndex = STAGES.indexOf(stage === 'live' ? 'readiness' : stage);
  const maxReached = run ? STAGES.indexOf(stageFromRun(run, fields.length) === 'live' ? 'readiness' : stageFromRun(run, fields.length)) : 0;

  if (authLoading || loading) {
    return (
      <div role="status" aria-label={t('page.loading')} className="flex min-h-screen items-center justify-center bg-bg-primary">
        <MiniLoader size={28} />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-bg-primary px-4 pb-16 pt-20 sm:px-6">
      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-4 sm:px-6">
        <span className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
            <Phone size={16} strokeWidth={2.5} aria-hidden="true" />
          </span>
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </span>
        <div className="flex items-center gap-3">
          <Link to="/onboarding/manual" className="focus-ring text-xs font-medium text-text-secondary hover:text-accent">
            {t('page.manual')}
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">{t('page.title')}</h1>
          <p className="mt-2 text-sm text-text-secondary">{t('page.subtitle')}</p>
        </div>

        {stage !== 'live' && (
          <nav aria-label={t('steps.list')}>
            <ol className="flex flex-wrap gap-2 text-xs font-medium">
              {STAGES.map((s, i) => {
                const reachable = !!run && i <= Math.max(maxReached, stepIndex) && i > 0;
                const current = s === stage;
                return (
                  <li key={s}>
                    <button
                      type="button"
                      aria-current={current ? 'step' : undefined}
                      disabled={!(reachable || current)}
                      onClick={() => setStage(s)}
                      className={`focus-ring min-h-[32px] rounded-full border px-3 py-1 ${current ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'} disabled:opacity-50`}
                    >
                      {i + 1}. {t(`steps.${s}`)}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        {loadError && (
          <p role="alert" className="text-sm text-danger">
            {loadError}
          </p>
        )}
        {!user && !loadError && <p className="text-sm text-text-secondary">{t('page.signedOut')}</p>}

        {user && (
          <Card interactive={false} className="!p-5 sm:!p-8">
            {stage === 'sources' && <SourcesStep locale={locale} parentRunId={rerunOf} initialUrl={run?.website_url ?? ''} onDone={onDrafted} />}
            {stage === 'interview' && run && <InterviewStep runId={run.id} locale={run.locale} onDone={toReview} />}
            {stage === 'review' && run && (
              <ReviewStep
                run={run}
                fields={fields}
                sources={sources}
                onReload={() => reload()}
                onNext={() => setStage('readiness')}
                onRerun={() => {
                  setRerunOf(run.id);
                  setStage('sources');
                }}
                onDeleted={() => {
                  setRun(null);
                  setFields([]);
                  setSources([]);
                  setResults([]);
                  setStage('sources');
                }}
              />
            )}
            {stage === 'readiness' && run && (
              <ReadinessStep
                run={run}
                fields={fields}
                initialResults={results}
                locale={run.locale}
                businessName={businessName}
                onReload={() => reload()}
                onLive={async ({ ms }) => {
                  setLiveMs(ms);
                  await reload();
                  setStage('live');
                }}
              />
            )}
            {stage === 'live' && run && (
              <section aria-labelledby="sl-live" className="space-y-4">
                <h2 id="sl-live" className="text-xl font-bold text-text-primary">
                  {t('live.heading')}
                </h2>
                <p className="text-sm text-text-secondary">{t('live.body')}</p>
                <ul className="space-y-1 text-sm text-text-primary">
                  {draftMs !== null && <li>{t('live.draftTime', { time: formatDuration(draftMs) })}</li>}
                  {liveMs !== null && <li>{t('live.time', { time: formatDuration(liveMs) })}</li>}
                  <li>{t('live.edits', { count: fields.reduce((n, f) => n + f.edit_count, 0) })}</li>
                </ul>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => navigate('/dashboard', { replace: true })}>{t('live.dashboard')}</Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      track('rerun');
                      setRerunOf(run.id);
                      setStage('sources');
                    }}
                  >
                    {t('live.again')}
                  </Button>
                </div>
                <SuggestionsPanel />
              </section>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
