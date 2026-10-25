import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { NPS_COMMENT_MAX, npsFollowUpPrompt } from '@/lib/successTools';
import { submitNps, type NpsContext, type NpsSubmitResult } from '@/lib/successToolsApi';

interface NpsFormProps {
  context: NpsContext;
  /** Called once the server has answered (ok or a known refusal). */
  onDone: (result: NpsSubmitResult) => void;
  /** Optional secondary action, e.g. "Not now". */
  onSkip?: () => void;
  skipLabel?: string;
}

const SCORES = Array.from({ length: 11 }, (_, i) => i);

/** 0-10 recommendation question with an adaptive follow-up. Native radios, so keyboard + screen readers just work. */
export function NpsForm({ context, onDone, onSkip, skipLabel = 'Not now' }: NpsFormProps) {
  const name = useId();
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (score === null || busy) return;
    setBusy(true);
    setError('');
    try {
      onDone(await submitNps(score, comment, context));
    } catch {
      setError('We couldn’t save your answer. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-semibold text-text-primary">How likely are you to recommend Vireek to a friend or colleague?</legend>
        <div className="mt-3 grid grid-cols-11 gap-1" role="radiogroup" aria-label="Likelihood to recommend, 0 to 10">
          {SCORES.map((n) => (
            <label key={n} className="relative">
              <input
                type="radio"
                name={name}
                value={n}
                checked={score === n}
                onChange={() => setScore(n)}
                className="peer sr-only"
                aria-label={`${n} out of 10`}
              />
              <span className="flex h-9 cursor-pointer items-center justify-center rounded-lg border border-border bg-bg-primary text-xs font-semibold text-text-secondary transition-colors hover:border-accent/60 peer-checked:border-accent peer-checked:bg-accent peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50">
                {n}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-text-secondary" aria-hidden="true">
          <span>Not at all likely</span>
          <span>Extremely likely</span>
        </div>
      </fieldset>

      {score !== null && (
        <Textarea
          label={npsFollowUpPrompt(score)}
          value={comment}
          rows={3}
          maxLength={NPS_COMMENT_MAX}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Optional"
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {onSkip && (
          <Button type="button" variant="ghost" size="sm" onClick={onSkip} disabled={busy}>
            {skipLabel}
          </Button>
        )}
        <Button type="button" size="sm" onClick={() => void submit()} disabled={score === null || busy}>
          {busy ? 'Sending…' : 'Send feedback'}
        </Button>
      </div>
    </div>
  );
}
