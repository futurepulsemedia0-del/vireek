import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Loader as Loader2, ArrowRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { supabase } from '@/lib/supabase';
import { EASE } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

type State = 'loading' | 'done' | 'error';

function SEO() {
  useSEO({
    title: 'Unsubscribe from Status Updates | Vireek',
    description: 'Unsubscribe from Vireek status page incident notifications.',
    canonical: 'https://vireek.com/status/unsubscribe',
  });
  return null;
}

export function StatusUnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    if (!token) {
      setState('error');
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.functions.invoke('unsubscribe-status-updates', {
        body: { token },
      });
      if (cancelled) return;
      if (error || !data?.success) {
        setState('error');
      } else {
        setState('done');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <>
      <SEO />
      <Header />
      <main className="flex min-h-screen flex-col items-center justify-center bg-bg-primary px-6 pt-24">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark"
        >
          {state === 'loading' && (
            <>
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-accent" />
              <p className="mt-4 text-sm text-text-secondary">Unsubscribing you from status updates…</p>
            </>
          )}
          {state === 'done' && (
            <>
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-500/10 text-success-500">
                <CheckCircle2 size={28} />
              </span>
              <h1 className="mt-5 text-xl font-bold tracking-tight text-text-primary">You&rsquo;re unsubscribed</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                You won&rsquo;t get any more email alerts about Vireek incidents. You can re-subscribe
                any time from the status page.
              </p>
            </>
          )}
          {state === 'error' && (
            <>
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-danger/10 text-danger">
                <AlertCircle size={28} />
              </span>
              <h1 className="mt-5 text-xl font-bold tracking-tight text-text-primary">Link not valid</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This unsubscribe link is missing or has already been used. If you&rsquo;re still
                getting emails you don&rsquo;t want, email us and we&rsquo;ll remove you directly.
              </p>
            </>
          )}
          <Link to="/status" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
            Back to status page
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
