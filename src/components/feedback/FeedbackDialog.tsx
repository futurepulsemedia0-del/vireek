import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Check, Copy, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Textarea } from '@/components/ui/Input';
import { FeedbackScreenshot } from '@/components/feedback/FeedbackScreenshot';
import { useDialogA11y } from '@/components/feedback/useDialogA11y';
import { getFeedbackPrivacy, submitFeedback, uploadScreenshot } from '@/lib/feedback/api';
import { collectFeedbackContext } from '@/lib/feedback/context';
import { OPEN_FEEDBACK_EVENT, type FeedbackCategory } from '@/lib/feedback/events';
import { redactText } from '@/lib/feedback/redact';

const CATEGORIES: { id: FeedbackCategory; label: string }[] = [
  { id: 'bug', label: 'Something’s broken' }, { id: 'idea', label: 'Idea' }, { id: 'question', label: 'Question' },
  { id: 'praise', label: 'Praise' }, { id: 'other', label: 'Other' },
];
const MAX = 4000;
const REASONS: Record<string, string> = {
  rate_limited: 'You’ve sent a lot of feedback in the last hour. Please try again a little later.',
  message_too_short: 'Tell us a bit more (at least 3 characters).',
  unavailable: 'Feedback can’t be sent while support is signed in as you.',
};

/** Global feedback dialog. Open with openFeedback(), the header button, the "f b" shortcut or the palette. */
export function FeedbackDialog() {
  const { user } = useAuth();
  const location = useLocation();
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [message, setMessage] = useState('');
  const [shot, setShot] = useState<Blob | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [anonymous, setAnonymous] = useState(false);
  const [contactOk, setContactOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const close = useCallback(() => setOpen(false), []);
  useDialogA11y(open, ref, close);

  useEffect(() => {
    const on = (e: Event) => {
      const cat = (e as CustomEvent<{ category?: FeedbackCategory }>).detail?.category;
      setMessage(''); setShot(null); setError(null); setDone(null); setBusy(false); setCopied(false);
      if (cat) setCategory(cat);
      setOpen(true);
      void getFeedbackPrivacy().then((p) => setAnonymous(p.anonymous_default)).catch(() => undefined);
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, on);
    return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, on);
  }, []);

  if (!open) return null;

  const context = includeContext ? collectFeedbackContext(location.pathname) : null;
  const redacted = redactText(message) !== message;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (message.trim().length < 3) { setError(REASONS.message_too_short); return; }
    setBusy(true); setError(null);
    try {
      let path: string | null = null;
      if (shot && user) {
        try { path = await uploadScreenshot(user.id, shot); } catch { /* feedback still goes through */ }
      }
      const r = await submitFeedback({
        category, message: redactText(message.trim()), context: context ?? {}, anonymous, contactOk: contactOk && !anonymous, screenshotPath: path,
      });
      if (r.ok && r.trackingCode) setDone({ code: r.trackingCode });
      else setError(REASONS[r.reason ?? ''] ?? 'We couldn’t send that. Please try again.');
    } catch {
      setError(navigator.onLine ? 'We couldn’t send that. Please try again.' : 'You’re offline. Reconnect and try again.');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-text-primary">Send feedback</h2>
            <p id={descId} className="text-sm text-text-secondary">We read every message. Emails, phone and card numbers are hidden automatically.</p>
          </div>
          <button type="button" onClick={close} aria-label="Close feedback" className="focus-ring -m-1 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>

        {done ? (
          <div role="status" className="space-y-3">
            <p className="flex items-center gap-2 text-base font-semibold text-text-primary"><Check className="h-5 w-5 text-success-500" aria-hidden="true" /> Thank you — we’ve got it.</p>
            <p className="text-sm text-text-secondary">Your tracking ID is <strong className="font-mono text-text-primary">{done.code}</strong>. You can follow its status any time.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(done.code); setCopied(true); }}>
                <Copy className="h-4 w-4" aria-hidden="true" /> {copied ? 'Copied' : 'Copy ID'}
              </Button>
              <Link to="/dashboard/feedback/mine" onClick={close} className="focus-ring inline-flex items-center rounded-xl px-3 py-1.5 text-sm font-medium text-accent hover:underline">Track status</Link>
              <Button type="button" size="sm" onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-text-primary">What kind of feedback?</legend>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <label key={c.id} className={`focus-within:ring-2 focus-within:ring-accent cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium ${category === c.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                    <input type="radio" name="feedback-category" value={c.id} checked={category === c.id} onChange={() => setCategory(c.id)} className="sr-only" />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <Textarea label="Your feedback" required rows={5} maxLength={MAX} value={message} onChange={(e) => setMessage(e.target.value)}
              error={error ?? undefined} helperText={redacted ? 'Some details look private and will be hidden before sending.' : `${message.length}/${MAX}`} />
            <FeedbackScreenshot onChange={setShot} />
            <div className="space-y-2 rounded-xl border border-border p-3">
              <Checkbox label="Include technical details" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)}
                helperText={context ? `Page ${context.route}, ${context.browser} on ${context.os}, app ${context.app_version}${context.error_id ? `, error ${context.error_id}` : ''}. No personal data.` : 'Nothing about your browser or page is sent.'} />
              <Checkbox label="Keep me anonymous to the team" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)}
                helperText="The team won’t see who you are. You can still follow the status here." />
              <Checkbox label="OK to email me about this" checked={contactOk} onChange={(e) => setContactOk(e.target.checked)}
                disabled={anonymous} disabledReason="Not available while you’re anonymous." />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
              <Button type="submit" loading={busy} loadingLabel="Sending…">Send feedback</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
