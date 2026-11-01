import { useId, useState, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { blogEvents } from '@/lib/blogAnalytics';
import { NEWSLETTER_CONSENT_TEXT, subscribeToNewsletter } from '@/lib/newsletterApi';
import { Link } from 'react-router-dom';

type Status = 'idle' | 'sending' | 'sent' | 'error';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Consent-based, double opt-in: nothing is sent until the visitor clicks the link in the confirmation email. */
export function NewsletterSignup({ source }: { source: string }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot: real visitors never see or fill this
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'sending') return;
    if (!EMAIL_RE.test(email.trim())) {
      setStatus('error');
      setMessage('Please enter a valid email address.');
      return;
    }
    if (!consent) {
      setStatus('error');
      setMessage('Please tick the box to confirm you want to receive our emails.');
      return;
    }
    setStatus('sending');
    const res = await subscribeToNewsletter(email.trim(), source, website);
    if (res.ok) {
      blogEvents.newsletterSignup(source);
      setStatus('sent');
    } else {
      setStatus('error');
      setMessage(res.message);
    }
  };

  return (
    <section aria-labelledby={`${id}-h`} className="rounded-3xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent"><Mail className="h-4 w-4" /></span>
        <h2 id={`${id}-h`} className="text-xl font-bold tracking-tight text-text-primary">Get new playbooks by email</h2>
      </div>
      <p className="mt-3 text-sm leading-6 text-text-secondary">Practical guides for home service business owners. No spam, and you confirm your address before we send anything.</p>

      {status === 'sent' ? (
        <p role="status" className="mt-5 rounded-xl border border-accent/30 bg-accent/[0.06] p-4 text-sm font-medium text-text-primary">
          Almost done. If that address can receive email, a confirmation link is on its way. Click it to finish subscribing.
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="mt-5 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <label htmlFor={`${id}-email`} className="sr-only">Email address</label>
              <input
                id={`${id}-email`}
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourcompany.com"
                aria-describedby={status === 'error' ? `${id}-err` : undefined}
                aria-invalid={status === 'error' ? true : undefined}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60"
              />
            </div>
            <Button type="submit" variant="primary" size="md" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Subscribe'}
            </Button>
          </div>
          {/* honeypot */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
          </div>
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-6 text-text-secondary">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="focus-ring mt-1 h-4 w-4 shrink-0 rounded border-border accent-[rgb(var(--accent-primary))]" />
            <span>
              {NEWSLETTER_CONSENT_TEXT.replace(' See the Privacy Policy.', '')}{' '}
              <Link to="/privacy" className="font-medium text-accent underline underline-offset-2">See the Privacy Policy.</Link>
            </span>
          </label>
          {status === 'error' && <p id={`${id}-err`} role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">{message}</p>}
        </form>
      )}
    </section>
  );
}
