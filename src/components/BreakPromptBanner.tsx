import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Coffee, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { nextBreakPrompt, type BreakSettings, type PromptShift } from '@/lib/breakCompliance';
import { fetchMyBreakRules, readCachedRules } from '@/lib/breakComplianceApi';

const TONE: Record<string, string> = {
  bad: 'border-danger/40 bg-danger/10',
  warn: 'border-warning-500/40 bg-warning-500/10',
  neutral: 'border-border bg-bg-secondary',
  good: 'border-success/40 bg-success/10',
};

interface Props {
  /** The technician's current shift from useTimeClock (tc.view). */
  shift: PromptShift | null;
  /** Current time in ms from useTimeClock (tc.now). */
  now: number;
  /** True while a clock action is running. */
  busy?: boolean;
  /** Starts a break (tc.startBreak). Omit to hide the button. */
  onStartBreak?: () => void;
  /** True when the technician is already on a break. */
  onBreak?: boolean;
}

/**
 * Reminder card for the technician Timesheet screen. Rules load once (cached on the
 * device, so reminders keep working offline); if they can't be loaded nothing is shown.
 */
export function BreakPromptBanner({ shift, now, busy = false, onStartBreak, onBreak = false }: Props) {
  const [rules, setRules] = useState<BreakSettings | null>(() => readCachedRules());
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyBreakRules()
      .then((r) => alive && setRules(r))
      .catch(() => undefined); // keep the cached rules (or none)
    return () => {
      alive = false;
    };
  }, []);

  const prompt = useMemo(() => nextBreakPrompt(shift, rules, now), [shift, rules, now]);

  // Haptic nudge once per new prompt, where the device supports it.
  const key = prompt?.key ?? null;
  const urgent = prompt?.tone === 'bad';
  useEffect(() => {
    if (key && urgent && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(200);
      } catch {
        /* not supported */
      }
    }
  }, [key, urgent]);

  if (!prompt || dismissed === prompt.key) return null;
  const Icon = prompt.tone === 'bad' ? AlertTriangle : Coffee;
  const canStart = !!onStartBreak && !onBreak && prompt.kind !== 'break_too_short';

  return (
    <div role={prompt.tone === 'bad' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-xl border p-3 text-sm text-text-primary ${TONE[prompt.tone]}`}>
      <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${prompt.tone === 'bad' ? 'text-danger' : 'text-warning-500'}`} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{prompt.title}</p>
        <p className="mt-0.5 text-text-secondary">{prompt.message}</p>
        {canStart && (
          <Button size="sm" className="mt-3" onClick={onStartBreak} disabled={busy}>
            <Coffee className="h-4 w-4" /> Start break
          </Button>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(prompt.key)}
        aria-label="Dismiss reminder"
        className="focus-ring -mr-1 -mt-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
