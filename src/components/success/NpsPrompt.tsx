import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { NpsForm } from '@/components/success/NpsForm';
import { NPS_SNOOZE_DAYS } from '@/lib/successTools';
import { fetchNpsDue, snoozeNpsPrompt, type NpsSubmitResult } from '@/lib/successToolsApi';

/** Wait before asking so the person is never interrupted the moment a page opens. */
export const NPS_PROMPT_DELAY_MS = 20_000;
/** Re-check the server at most this often per tab (the layout remounts on every navigation). */
const RECHECK_MS = 30 * 60_000;
let lastCheck = 0;

/** Test hook: forget the per-tab throttle. */
export function resetNpsPromptThrottleForTests() {
  lastCheck = 0;
}

type Phase = 'hidden' | 'asking' | 'thanks';

/**
 * Quarterly in-app NPS. Server decides eligibility (account age, a real value
 * moment, one answer per person per 90 days, snooze, never while staff are
 * signed in as the customer); this component only presents it, quietly, in a
 * corner that does not cover the page.
 */
export function NpsPrompt() {
  const [phase, setPhase] = useState<Phase>('hidden');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (Date.now() - lastCheck < RECHECK_MS) return () => { alive.current = false; };
    const timer = window.setTimeout(async () => {
      if (document.visibilityState !== 'visible') return;
      lastCheck = Date.now();
      if (await fetchNpsDue()) {
        if (alive.current) setPhase('asking');
      }
    }, NPS_PROMPT_DELAY_MS);
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
    };
  }, []);

  const snooze = useCallback(() => {
    setPhase('hidden');
    void snoozeNpsPrompt(NPS_SNOOZE_DAYS).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (phase !== 'asking') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') snooze();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, snooze]);

  useEffect(() => {
    if (phase !== 'thanks') return;
    const t = window.setTimeout(() => setPhase('hidden'), 4000);
    return () => window.clearTimeout(t);
  }, [phase]);

  const onDone = (r: NpsSubmitResult) => setPhase(r.ok ? 'thanks' : 'hidden');

  if (phase === 'hidden') return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="nps-prompt-title"
      className="fixed bottom-[calc(16px_+_var(--vk-bottom-nav-h,0px))] left-4 z-40 w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover lg:left-[16rem] print:hidden"
    >
      {phase === 'thanks' ? (
        <p id="nps-prompt-title" role="status" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <CheckCircle2 size={18} className="text-success-500" aria-hidden="true" /> Thank you — your feedback goes straight to our team.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 id="nps-prompt-title" className="text-sm font-bold text-text-primary">Quick question</h2>
            <button type="button" onClick={snooze} aria-label="Dismiss for now" className="focus-ring -m-1 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary">
              <X size={16} />
            </button>
          </div>
          <NpsForm context="prompt" onDone={onDone} onSkip={snooze} />
        </>
      )}
    </div>
  );
}
