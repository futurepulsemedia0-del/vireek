import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProgressRing } from '@/components/agentReadiness/ProgressRing';
import { ScoreChecklist } from '@/components/agentReadiness/ScoreChecklist';
import { useAgentReadinessT } from '@/i18n/agentReadinessNamespace';
import { runPublicCheck } from '@/lib/agentReadiness';
import { coveragePct, type PublicResult } from '@/lib/agentReadinessCore';
import { useSEO } from '@/lib/seo';

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; code: string } | { kind: 'done'; result: PublicResult };

export function AgentReadinessPublicPage() {
  const { t } = useAgentReadinessT();
  const [url, setUrl] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const honeypot = useRef<HTMLInputElement>(null);
  useSEO({ title: t('public.seoTitle'), description: t('public.seoDescription'), canonical: 'https://vireek.com/agent-readiness' });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state.kind === 'loading') return;
    setState({ kind: 'loading' });
    try {
      const res = await runPublicCheck(url, honeypot.current?.value ?? '');
      setState(res.ok ? { kind: 'done', result: res } : { kind: 'error', code: res.code });
    } catch { setState({ kind: 'error', code: 'network' }); }
  }
  const busy = state.kind === 'loading';

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-28">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-3xl font-bold text-text-primary sm:text-4xl">{t('public.heading')}</h1>
          <p className="mt-3 text-text-secondary">{t('public.lead')}</p>

          <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
            <label className="flex-1 text-sm font-medium text-text-primary">
              {t('public.urlLabel')}
              <Input type="text" inputMode="url" autoComplete="url" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('public.urlPlaceholder')} className="mt-1" />
            </label>
            {/* Honeypot: hidden from people and assistive tech. */}
            <input ref={honeypot} type="text" name="website_confirm" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            <Button type="submit" loading={busy} loadingLabel={t('public.checking')} disabled={url.trim() === ''}>{t('public.check')}</Button>
          </form>
          <p className="mt-3 text-xs text-text-secondary">{t('public.privacy')}</p>

          <div aria-live="polite" className="mt-6">
            {state.kind === 'error' && <p role="alert" className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-primary">{t(`errors.${state.code}`, { defaultValue: t('errors.unknown') })}</p>}
          </div>

          {state.kind === 'done' && (
            <section className="mt-6 space-y-6" aria-labelledby="ar-result">
              <div className="flex flex-wrap items-center gap-6 rounded-2xl border border-border bg-bg-secondary p-5">
                <ProgressRing score={state.result.score} label={t('scoreLabel')} unknownLabel={t('scoreUnknown')} />
                <div className="min-w-0 flex-1">
                  <h2 id="ar-result" className="text-lg font-semibold text-text-primary">{t('public.resultFor', { host: state.result.host })}</h2>
                  <p className="mt-1 text-xs text-text-secondary">{t('public.scope')}</p>
                  <p className="mt-1 text-xs text-text-secondary">{t('coverage', { pct: coveragePct(state.result.coverage) })}</p>
                  <p className="mt-1 text-xs text-text-secondary">{t('honesty')}</p>
                </div>
              </div>

              <div>
                <h2 className="mb-3 text-base font-semibold text-text-primary">{t('public.topFixes')}</h2>
                {state.result.topFixes.length === 0 ? <p className="text-sm text-text-secondary">{t('public.noFixes')}</p> : (
                  <ol className="space-y-2">
                    {state.result.topFixes.map((f) => (
                      <li key={f.ruleId} className="rounded-xl border border-border bg-bg-secondary p-4 text-sm">
                        <p className="font-medium text-text-primary">{t(`rules.${f.ruleId}.title`)} <span className="ml-1 text-xs font-normal text-text-secondary">{t('public.lostPoints', { points: Math.round(f.lost) })}</span></p>
                        <p className="mt-1 text-xs text-text-secondary">{t(`evidence.${f.evidence.k}`, f.evidence.p ?? {})}</p>
                        <p className="mt-1 text-xs text-text-secondary">{t('howToFix')}: {t(`rules.${f.ruleId}.fix`)}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <details className="rounded-2xl border border-border bg-bg-secondary p-4">
                <summary className="focus-ring cursor-pointer text-sm font-medium text-text-primary">{t('public.allChecks')}</summary>
                <div className="mt-3"><ScoreChecklist subscores={state.result.subscores} checks={state.result.checks} /></div>
              </details>

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="text-base font-semibold text-text-primary">{t('public.ctaTitle')}</h2>
                <p className="mt-1 text-sm text-text-secondary">{t('public.ctaBody')}</p>
                <div className="mt-3"><Link to="/" className="focus-ring text-sm font-semibold text-accent underline">{t('public.cta')}</Link></div>
              </div>
            </section>
          )}
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
