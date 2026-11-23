import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { usePmfT } from '@/i18n/pmfNamespace';
import { useConsent } from '@/lib/consent/useConsent';
import { ERROR_QUIET_MS, getLastErrorAt, installErrorTracker } from '@/lib/feedback/errorTracker';
import { evaluateSurveyGate, isTypingTarget } from '@/lib/feedback/surveyRules';
import { PMF_ANSWERS, type PmfAnswer } from '@/lib/pmf';
import { claimPmf, dismissPmf, respondPmf } from '@/lib/pmfApi';

/** Wait before even checking, so the person is never interrupted the moment a page opens. */
export const PMF_PROMPT_DELAY_MS = 45_000;
const RETRY_MS = 5_000;
const MAX_WAIT_MS = 60_000;
/** The layout remounts on navigation; ask the server at most this often per tab. */
const RECHECK_MS = 30 * 60_000;
let lastCheck = 0;

/** Test hook: forget the per-tab throttle. */
export function resetPmfPromptThrottleForTests() {
  lastCheck = 0;
}

type Phase = 'idle' | 'asking' | 'thanks';

/**
 * "How would you feel if you could no longer use Vireek?" (docs/analytics/pmf.md).
 * Browser rules run here: analytics consent, critical routes, recent errors, any open dialog (so it never stacks on
 * the NPS or CSAT prompt), typing, visibility, offline. The server (pmf_claim) owns eligibility: usage threshold,
 * account age, one prompt per 90 days, one answer per 180 days, shared survey fatigue, snooze, "don't ask again",
 * and never during staff impersonation. Without analytics consent nothing is requested from the server at all.
 */
export function PmfPrompt() {
  const { pathname } = useLocation();
  const consent = useConsent();
  const { t } = usePmfT();
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>('idle');
  const [answer, setAnswer] = useState<PmfAnswer | null>(null);
  const [benefit, setBenefit] = useState('');
  const [improve, setImprove] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef({ pathname, analytics: consent.hasConsent('analytics') });
  live.current = { pathname, analytics: consent.hasConsent('analytics') };

  useEffect(() => { installErrorTracker(); }, []);

  useEffect(() => {
    if (Date.now() - lastCheck < RECHECK_MS) return undefined;
    let timer: number | undefined;
    let cancelled = false;
    const startedAt = Date.now();

    const attempt = async () => {
      if (cancelled) return;
      const g = evaluateSurveyGate({
        analyticsConsent: live.current.analytics,
        pathname: live.current.pathname,
        now: Date.now(),
        lastErrorAt: getLastErrorAt(),
        errorQuietMs: ERROR_QUIET_MS,
        modalOpen: !!document.querySelector('[role="dialog"]'),
        typing: isTypingTarget(document.activeElement),
        visible: document.visibilityState === 'visible',
        online: navigator.onLine,
      });
      if (!g.show) {
        if (g.reason === 'no_consent' || Date.now() - startedAt > PMF_PROMPT_DELAY_MS + MAX_WAIT_MS) return;
        timer = window.setTimeout(() => void attempt(), RETRY_MS);
        return;
      }
      lastCheck = Date.now();
      if (await claimPmf()) {
        if (!cancelled) setPhase('asking');
      }
    };

    timer = window.setTimeout(() => void attempt(), PMF_PROMPT_DELAY_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (phase !== 'thanks') return undefined;
    const id = window.setTimeout(() => setPhase('idle'), 4000);
    return () => window.clearTimeout(id);
  }, [phase]);

  const leave = useCallback((action: 'dismissed' | 'snoozed' | 'never') => {
    void dismissPmf(action, 30);
    setPhase('idle');
  }, []);

  useEffect(() => {
    if (phase !== 'asking') return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leave('dismissed'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, leave]);

  if (phase === 'idle') return null;

  const send = async () => {
    if (!answer || busy) return;
    setBusy(true);
    try {
      const r = await respondPmf(answer, benefit.trim(), improve.trim());
      setPhase(r.ok ? 'thanks' : 'idle');
    } catch {
      setPhase('idle');
    }
    setBusy(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="fixed bottom-[calc(16px_+_var(--vk-bottom-nav-h,0px))] end-4 z-40 w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover print:hidden"
    >
      {phase === 'thanks' ? (
        <p id={titleId} role="status" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <CheckCircle2 size={18} className="text-success" aria-hidden="true" /> {t('prompt.thanks')}
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 id={titleId} className="text-sm font-bold text-text-primary">{t('prompt.question')}</h2>
            <button type="button" onClick={() => leave('dismissed')} aria-label={t('prompt.dismiss')} className="focus-ring -m-1 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div role="radiogroup" aria-labelledby={titleId} className="flex flex-col gap-1.5">
            {PMF_ANSWERS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={answer === a}
                onClick={() => setAnswer(a)}
                className={`focus-ring min-h-[44px] rounded-lg border px-3 text-start text-sm font-medium ${answer === a ? 'border-accent bg-accent text-on-accent' : 'border-border text-text-primary hover:bg-bg-tertiary'}`}
              >
                {t(`prompt.answers.${a}`)}
              </button>
            ))}
          </div>
          {answer !== null && (
            <div className="mt-3 space-y-2">
              {answer !== 'no_longer_use' && (
                <Textarea label={t('prompt.benefit')} rows={2} maxLength={500} value={benefit} onChange={(e) => setBenefit(e.target.value)} />
              )}
              <Textarea label={t('prompt.improve')} rows={2} maxLength={500} value={improve} onChange={(e) => setImprove(e.target.value)} />
              <Button type="button" onClick={() => void send()} loading={busy} loadingLabel={t('prompt.sending')}>{t('prompt.send')}</Button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <button type="button" onClick={() => leave('snoozed')} className="focus-ring rounded text-text-secondary underline hover:text-text-primary">{t('prompt.later')}</button>
            <button type="button" onClick={() => leave('never')} className="focus-ring rounded text-text-secondary underline hover:text-text-primary">{t('prompt.never')}</button>
          </div>
        </>
      )}
    </div>
  );
}
