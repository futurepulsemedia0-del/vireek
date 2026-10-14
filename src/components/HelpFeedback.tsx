import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import {
  MAX_COMMENT_LENGTH, readStoredVote, storeVote, submitHelpFeedback, type HelpVote,
} from '@/lib/helpFeedback';

type Phase = 'idle' | 'comment' | 'submitting' | 'done' | 'error';

export function HelpFeedback({ slug }: { slug: string }) {
  const [vote, setVote] = useState<HelpVote | null>(() => readStoredVote(slug));
  const [phase, setPhase] = useState<Phase>(() => (readStoredVote(slug) ? 'done' : 'idle'));
  const [pending, setPending] = useState<HelpVote | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = async (next: HelpVote, text?: string) => {
    setPhase('submitting');
    setPending(next);
    setError(null);
    try {
      await submitHelpFeedback({ slug, vote: next, comment: text });
      storeVote(slug, next);
      setVote(next);
      setPhase('done');
    } catch {
      setError(
        typeof navigator !== 'undefined' && !navigator.onLine
          ? "You're offline. Reconnect and try again."
          : "We couldn't send your feedback. Please try again.",
      );
      setPhase(next === 'not_helpful' ? 'comment' : 'error');
    } finally {
      setPending(null);
    }
  };

  const onSubmitComment = (e: FormEvent) => {
    e.preventDefault();
    void send('not_helpful', comment);
  };

  const busy = phase === 'submitting';
  const showForm = phase === 'comment' || (busy && pending === 'not_helpful');

  return (
    <section aria-labelledby="help-feedback-title" className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      {phase === 'done' ? (
        <div role="status">
          <p className="text-base font-semibold text-text-primary">Thanks for your feedback.</p>
          <p className="mt-1 text-sm text-text-secondary">
            {vote === 'not_helpful' ? (
              <>
                Sorry this didn’t solve it.{' '}
                <Link to="/contact" className="font-semibold text-accent hover:underline">
                  Contact support
                </Link>{' '}
                and we’ll help directly.
              </>
            ) : (
              'We’re glad it helped.'
            )}
          </p>
          <button
            type="button"
            onClick={() => setPhase('idle')}
            className="focus-ring mt-3 min-h-11 text-sm font-semibold text-accent hover:underline"
          >
            Change my answer
          </button>
        </div>
      ) : showForm ? (
        <form onSubmit={onSubmitComment}>
          <label htmlFor="help-feedback-comment" className="block text-base font-semibold text-text-primary">
            What were you looking for? <span className="font-normal text-text-secondary">(optional)</span>
          </label>
          <textarea
            id="help-feedback-comment"
            value={comment}
            maxLength={MAX_COMMENT_LENGTH}
            rows={3}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
            className="focus-ring mt-3 w-full rounded-xl border border-border bg-bg-primary p-3 text-base text-text-primary"
          />
          <p className="mt-1 text-xs text-text-secondary">
            {comment.length}/{MAX_COMMENT_LENGTH}. Please don’t include passwords or card numbers.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="focus-ring min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Send feedback'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPhase('idle');
                setError(null);
              }}
              className="focus-ring min-h-11 rounded-xl border border-border px-4 text-sm font-medium text-text-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <h2 id="help-feedback-title" className="text-base font-semibold text-text-primary">
            Was this article helpful?
          </h2>
          <div role="group" aria-labelledby="help-feedback-title" className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void send('helpful')}
              className="focus-ring flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold text-text-primary disabled:opacity-60 sm:flex-none sm:px-6"
            >
              <ThumbsUp aria-hidden="true" className="h-4 w-4" /> Yes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setPhase('comment');
              }}
              className="focus-ring flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold text-text-primary disabled:opacity-60 sm:flex-none sm:px-6"
            >
              <ThumbsDown aria-hidden="true" className="h-4 w-4" /> No
            </button>
          </div>
          {busy && (
            <p role="status" className="mt-2 text-sm text-text-secondary">
              Sending…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
