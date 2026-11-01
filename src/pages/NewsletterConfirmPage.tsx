import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { confirmNewsletter, unsubscribeNewsletter } from '@/lib/newsletterApi';

type Status = 'idle' | 'working' | 'done' | 'error';

/**
 * /newsletter/confirm and /newsletter/unsubscribe. The action runs only when the visitor clicks the
 * button, so link scanners and prefetchers that merely open the URL can never confirm or unsubscribe anyone.
 */
export function NewsletterConfirmPage({ mode }: { mode: 'confirm' | 'unsubscribe' }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const isConfirm = mode === 'confirm';

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    const prev = document.title;
    document.title = isConfirm ? 'Confirm your subscription | Vireek' : 'Unsubscribe | Vireek';
    return () => {
      meta.remove();
      document.title = prev;
    };
  }, [isConfirm]);

  const run = async () => {
    setStatus('working');
    const res = await (isConfirm ? confirmNewsletter(token) : unsubscribeNewsletter(token));
    if (res.ok) setStatus('done');
    else {
      setMessage(res.message);
      setStatus('error');
    }
  };

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-36">
        <div className="mx-auto max-w-lg rounded-3xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">{isConfirm ? 'Confirm your subscription' : 'Unsubscribe from Vireek emails'}</h1>
          {!token ? (
            <p role="alert" className="mt-4 text-text-secondary">This link is incomplete. Please use the link from your email.</p>
          ) : status === 'done' ? (
            <p role="status" className="mt-4 text-text-primary">{isConfirm ? 'You are subscribed. Thanks for confirming.' : 'You have been unsubscribed. You will not receive further emails.'}</p>
          ) : (
            <>
              <p className="mt-4 text-text-secondary">{isConfirm ? 'Click the button to finish subscribing to Vireek articles and playbooks.' : 'Click the button to stop receiving Vireek article emails.'}</p>
              {status === 'error' && <p role="alert" className="mt-4 text-sm font-medium text-red-600 dark:text-red-400">{message}</p>}
              <div className="mt-6"><Button variant="primary" size="lg" onClick={run} disabled={status === 'working'}>{status === 'working' ? 'Working…' : isConfirm ? 'Confirm subscription' : 'Unsubscribe'}</Button></div>
            </>
          )}
          <p className="mt-8 text-sm"><Link to="/blog" className="focus-ring rounded-sm font-medium text-accent underline underline-offset-2">Back to the blog</Link></p>
        </div>
      </main>
      <Footer />
    </>
  );
}
