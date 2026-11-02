import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { CodeTabs } from '@/components/developers/CodeTabs';
import { DocsFeedback, DocsHeaderBar, DocsPager } from '@/components/developers/DocsChrome';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import { eyebrowClass, sectionHeadingClass, bodyClass } from '@/lib/motion';
import { formatDuration, timeToFirstSuccess } from '@/lib/quickstartMetrics';
import { QUICKSTARTS } from '../../supabase/functions/api-v1/quickstarts';

function SEO() {
  useSEO({
    title: 'Quickstarts — your first Vireek API call in 5 minutes',
    description:
      'Three copy-paste guides: sync calls, alert on new leads, export jobs. Every script is executed in CI.',
    canonical: 'https://vireek.com/developers/quickstarts',
  });
  return null;
}

/** Measured for the signed-in account from its own keys and request logs (30-day log retention). */
function MeasuredTime() {
  const { user } = useAuth();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const [keys, logs] = await Promise.all([
        supabase.from('api_keys').select('id, created_at'),
        supabase
          .from('api_request_logs')
          .select('api_key_id, status, created_at')
          .gte('status', 200)
          .lt('status', 300)
          .order('created_at', { ascending: true })
          .limit(1000),
      ]);
      if (cancelled || keys.error || logs.error) return;
      const best = timeToFirstSuccess(keys.data ?? [], logs.data ?? []);
      setText(
        best
          ? `Your fastest first successful call: ${formatDuration(best.seconds)} after creating the key.`
          : 'No successful API call from your keys yet. Run a quickstart below.',
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!text) return null;
  return (
    <p className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm text-text-primary">
      <Timer size={14} aria-hidden="true" /> {text}
    </p>
  );
}

export function QuickstartsPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <DocsHeaderBar sourceFile="src/pages/QuickstartsPage.tsx" />
        <section className="px-6 py-14">
          <div className="mx-auto max-w-4xl">
            <BackButton />
            <p className={`${eyebrowClass()} mt-8`}>Developers</p>
            <h1 className={`${sectionHeadingClass()} mt-3`}>Your first API call in 5 minutes</h1>
            <p className={`mt-3 max-w-2xl ${bodyClass()}`}>
              Pick a use case, create a Test key, paste the script. Each one is run in our CI
              against the real API contract, so it works as written.
            </p>
            <MeasuredTime />
            <div className="mt-10 space-y-14">
              {QUICKSTARTS.map((q) => (
                <article key={q.id} id={q.id} className="scroll-mt-28">
                  <h2 className="text-2xl font-bold text-text-primary">{q.title}</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    {q.useCase} About {q.estimateMinutes} minutes.
                  </p>
                  <ol className="mt-5 list-decimal space-y-3 pl-5 text-sm text-text-secondary">
                    {q.steps.map((s) => (
                      <li key={s.title}>
                        <strong className="font-semibold text-text-primary">{s.title}.</strong>{' '}
                        {s.body}
                      </li>
                    ))}
                  </ol>
                  <div className="mt-5">
                    <p className="mb-2 font-mono text-xs text-text-secondary">{q.filename}</p>
                    <CodeTabs
                      label={`${q.title} code`}
                      tabs={[
                        {
                          id: q.language,
                          label: q.language === 'python' ? 'Python' : 'JavaScript',
                          source: q.code,
                        },
                      ]}
                    />
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
        <DocsPager />
        <DocsFeedback page="/developers/quickstarts" />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
