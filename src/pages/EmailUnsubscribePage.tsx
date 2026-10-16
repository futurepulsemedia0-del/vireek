import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CircleCheck as CheckCircle2, CircleAlert as AlertCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { supabase } from '@/lib/supabase';

type State = 'loading' | 'ready' | 'already' | 'working' | 'done' | 'invalid' | 'error';

interface Lookup {
  success: boolean;
  email_masked?: string;
  company?: string | null;
  already?: boolean;
}

/**
 * Public page linked from every campaign email footer (/email/unsubscribe/:token).
 * Two steps (look up -> confirm) so link scanners that merely open the URL can't
 * unsubscribe anyone by accident. The mail client's one-click header goes straight
 * to the `email-unsubscribe` function instead.
 */
export default function EmailUnsubscribePage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<Lookup | null>(null);

  // Never index a per-recipient URL.
  useEffect(() => {
    const previous = document.title;
    document.title = 'Unsubscribe';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.title = previous;
      meta.remove();
    };
  }, []);

  const load = useCallback(async () => {
    setState('loading');
    const { data, error } = await supabase.functions.invoke('email-unsubscribe', { body: { token, action: 'lookup' } });
    const res = data as Lookup | null;
    if (error || !res?.success) {
      // 404/400 from the function means the link itself is bad; anything else is transient.
      const status = (error as { context?: Response } | null)?.context?.status;
      setState(status === 404 || status === 400 || !error ? 'invalid' : 'error');
      return;
    }
    setInfo(res);
    setState(res.already ? 'already' : 'ready');
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    setState('working');
    const { data, error } = await supabase.functions.invoke('email-unsubscribe', { body: { token, action: 'unsubscribe' } });
    setState(!error && (data as Lookup | null)?.success ? 'done' : 'error');
  };

  const company = info?.company || 'this business';

  return (
    <>
      <Header />
      <main className="flex min-h-screen flex-col items-center justify-center bg-bg-primary px-4 pt-24 pb-12">
        <Card className="w-full max-w-md p-6 text-center hover:translate-y-0 sm:p-8" aria-live="polite">
          {state === 'loading' && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="mx-auto h-6 w-48" />
              <Skeleton className="mx-auto h-4 w-64" />
              <Skeleton className="mx-auto h-12 w-full" />
            </div>
          )}

          {(state === 'ready' || state === 'working') && (
            <>
              <h1 className="text-xl font-bold text-text-primary">Unsubscribe from {company}?</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {info?.email_masked} will stop receiving marketing emails from {company}. You&rsquo;ll still receive
                messages about your service appointments and invoices.
              </p>
              <Button className="mt-6 w-full" onClick={() => void confirm()} disabled={state === 'working'}>
                {state === 'working' ? 'Unsubscribing…' : 'Yes, unsubscribe me'}
              </Button>
            </>
          )}

          {(state === 'done' || state === 'already') && (
            <>
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
                <CheckCircle2 size={28} />
              </span>
              <h1 className="mt-5 text-xl font-bold text-text-primary">
                {state === 'already' ? 'You were already unsubscribed' : "You're unsubscribed"}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {info?.email_masked ? `${info.email_masked} won’t` : 'You won’t'} receive marketing emails from {company} anymore.
              </p>
            </>
          )}

          {(state === 'invalid' || state === 'error') && (
            <>
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-danger/10 text-danger">
                <AlertCircle size={28} />
              </span>
              <h1 className="mt-5 text-xl font-bold text-text-primary">
                {state === 'invalid' ? 'This link isn’t valid' : 'Something went wrong'}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {state === 'invalid'
                  ? 'The unsubscribe link is incomplete or has expired. Reply to the email you received and we’ll remove you directly.'
                  : 'We couldn’t process that just now. Please try again in a moment.'}
              </p>
              {state === 'error' && (
                <Button variant="secondary" className="mt-6 w-full" onClick={() => void (info ? confirm() : load())}>
                  Try again
                </Button>
              )}
            </>
          )}
        </Card>
      </main>
      <Footer />
    </>
  );
}
