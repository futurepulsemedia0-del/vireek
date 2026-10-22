/**
 * Public customer view of a job summary — /summary/:token (no auth).
 * Reads ONLY through the job-summary-public edge function (unguessable token, signed photo URLs).
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Skeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { FileX } from 'lucide-react';
import { JobSummaryView } from '@/components/jobs/JobSummaryView';
import { fetchPublicSummary, type PublicSummary } from '@/lib/jobSummariesApi';

type State = { kind: 'loading' } | { kind: 'ready'; summary: PublicSummary } | { kind: 'missing' } | { kind: 'error' };

export function JobSummaryPublicPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      if (!token) return setState({ kind: 'missing' });
      const r = await fetchPublicSummary(token);
      if (cancelled) return;
      setState(r.ok ? { kind: 'ready', summary: r.summary } : { kind: r.reason === 'not_found' ? 'missing' : 'error' });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
        {state.kind === 'loading' && (
          <div className="space-y-4" aria-busy="true" aria-label="Loading summary">
            <Skeleton className="h-8 w-64 rounded-lg" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        )}
        {state.kind === 'missing' && (
          <EmptyState icon={FileX} title="Summary not found" description="This link may be incorrect or the summary is no longer available. Please contact the business that sent it." />
        )}
        {state.kind === 'error' && (
          <EmptyState icon={FileX} title="Couldn't load this summary" description="Please check your connection and refresh the page." action={{ label: 'Try again', onClick: () => window.location.reload() }} />
        )}
        {state.kind === 'ready' && <JobSummaryView data={state.summary} todayISO={new Date().toISOString().slice(0, 10)} />}
      </main>
      <Footer />
    </div>
  );
}
