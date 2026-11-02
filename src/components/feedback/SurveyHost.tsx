import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Textarea } from '@/components/ui/Input';
import { claimSurvey, dismissSurvey, respondSurvey } from '@/lib/feedback/api';
import { ERROR_QUIET_MS, getLastErrorAt, installErrorTracker } from '@/lib/feedback/errorTracker';
import { SURVEY_REQUEST_EVENT, type SurveyRequest } from '@/lib/feedback/events';
import { evaluateSurveyGate, isLowScore, isTypingTarget, SURVEY_SCALES } from '@/lib/feedback/surveyRules';
import { useConsent } from '@/lib/consent/useConsent';

const SHOW_DELAY_MS = 1500;
const RETRY_MS = 5000;
const MAX_WAIT_MS = 60_000;

type Phase = 'idle' | 'asking' | 'thanks';

/**
 * Mounted once in DashboardLayout. Call requestSurvey() from a moment that just finished (ticket resolved, job
 * completed, import done). Browser rules (consent, critical flows, errors, open dialogs, typing) run here; the
 * server (survey_claim) enforces frequency caps, snooze, never-ask and one answer per subject.
 */
export function SurveyHost() {
  const { pathname } = useLocation();
  const consent = useConsent();
  const titleId = useId();
  const [req, setReq] = useState<SurveyRequest | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [contactOk, setContactOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef({ pathname, analytics: consent.hasConsent('analytics') });
  live.current = { pathname, analytics: consent.hasConsent('analytics') };
  const pending = useRef<SurveyRequest | null>(null);

  useEffect(() => { installErrorTracker(); }, []);

  const gate = useCallback(() => evaluateSurveyGate({
    analyticsConsent: live.current.analytics, pathname: live.current.pathname, now: Date.now(),
    lastErrorAt: getLastErrorAt(), errorQuietMs: ERROR_QUIET_MS,
    modalOpen: !!document.querySelector('[role="dialog"][aria-modal="true"]'),
    typing: isTypingTarget(document.activeElement), visible: document.visibilityState === 'visible', online: navigator.onLine,
  }), []);

  useEffect(() => {
    let timer: number | undefined;
    const attempt = async (r: SurveyRequest, startedAt: number) => {
      if (pending.current !== r) return;
      const g = gate();
      if (!g.show) {
        if (g.reason === 'no_consent' || Date.now() - startedAt > MAX_WAIT_MS) { pending.current = null; return; }
        timer = window.setTimeout(() => void attempt(r, startedAt), RETRY_MS);
        return;
      }
      if (!(await claimSurvey(r)) || pending.current !== r) { if (pending.current === r) pending.current = null; return; }
      pending.current = null;
      setScore(null); setComment(''); setContactOk(false); setReq(r); setPhase('asking');
    };
    const on = (e: Event) => {
      const r = (e as CustomEvent<SurveyRequest>).detail;
      if (!r || phase !== 'idle' || pending.current) return;
      pending.current = r;
      timer = window.setTimeout(() => void attempt(r, Date.now()), SHOW_DELAY_MS);
    };
    window.addEventListener(SURVEY_REQUEST_EVENT, on);
    return () => { window.removeEventListener(SURVEY_REQUEST_EVENT, on); window.clearTimeout(timer); };
  }, [gate, phase]);

  useEffect(() => {
    if (phase !== 'thanks') return;
    const t = window.setTimeout(() => setPhase('idle'), 3500);
    return () => window.clearTimeout(t);
  }, [phase]);

  const leave = useCallback((action: 'dismissed' | 'snoozed' | 'never') => {
    if (req) void dismissSurvey(req, action, 30);
    setPhase('idle');
  }, [req]);

  useEffect(() => {
    if (phase !== 'asking') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leave('dismissed'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, leave]);

  if (phase === 'idle' || !req) return null;
  const scale = SURVEY_SCALES[req.type];
  const low = score !== null && isLowScore(req.type, score);

  const send = async () => {
    if (score === null || busy) return;
    setBusy(true);
    try {
      const r = await respondSurvey(req, score, comment.trim(), contactOk);
      setPhase(r.ok ? 'thanks' : 'idle');
    } catch { setPhase('idle'); }
    setBusy(false);
  };

  return (
    <div role="dialog" aria-modal="false" aria-labelledby={titleId}
      className="fixed bottom-[calc(16px_+_var(--vk-bottom-nav-h,0px))] right-4 z-40 w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover print:hidden">
      {phase === 'thanks' ? (
        <p id={titleId} role="status" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <CheckCircle2 size={18} className="text-success-500" aria-hidden="true" /> Thank you — this goes straight to our team.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 id={titleId} className="text-sm font-bold text-text-primary">{scale.question}</h2>
            <button type="button" onClick={() => leave('dismissed')} aria-label="Dismiss" className="focus-ring -m-1 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"><X size={16} /></button>
          </div>
          <div role="radiogroup" aria-label={scale.question} className="flex gap-1.5">
            {Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={score === n} onClick={() => setScore(n)}
                className={`focus-ring h-10 flex-1 rounded-lg border text-sm font-semibold ${score === n ? 'border-accent bg-accent text-white' : 'border-border text-text-primary hover:bg-bg-tertiary'}`}>{n}</button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-text-secondary"><span>{scale.lo}</span><span>{scale.hi}</span></div>
          {score !== null && (
            <div className="mt-3 space-y-2">
              <Textarea label={low ? 'What went wrong?' : 'Anything we should know? (optional)'} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
              {low && comment.trim() && <Checkbox label="OK to email me about this" checked={contactOk} onChange={(e) => setContactOk(e.target.checked)} />}
              <Button type="button" onClick={() => void send()} loading={busy} loadingLabel="Sending…">Send</Button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <button type="button" onClick={() => leave('snoozed')} className="focus-ring rounded text-text-secondary underline hover:text-text-primary">Ask me later</button>
            <button type="button" onClick={() => leave('never')} className="focus-ring rounded text-text-secondary underline hover:text-text-primary">Don’t ask me again</button>
          </div>
        </>
      )}
    </div>
  );
}
