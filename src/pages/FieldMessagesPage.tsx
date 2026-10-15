import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { JobThread } from '@/components/messages/JobThread';
import { useRealtimeSubscription } from '@/lib/realtime';
import { fetchThreadSummaries, previewText, type ThreadSummary } from '@/lib/jobMessages';

/** Office side of /tech/messages: every job thread on the account, thread pane on the right (desktop). */
export function FieldMessagesPage() {
  const [params, setParams] = useSearchParams();
  const activeJob = params.get('job');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(() => {
    fetchThreadSummaries()
      .then((rows) => { setThreads(rows); setState('ready'); })
      .catch(() => setState((s) => (s === 'ready' ? s : 'error')));
  }, []);
  useEffect(load, [load]);
  useRealtimeSubscription({ channelName: 'office-field-messages', table: 'job_messages', event: 'INSERT', onChange: load, enabled: state === 'ready' });

  const active = threads.find((t) => t.job_id === activeJob);

  return (
    <DashboardLayout activeLabel="Field Messages">
      <div className="mx-auto flex h-[calc(100dvh-4rem)] max-w-6xl flex-col px-4 py-4">
        <h1 className="mb-3 text-2xl font-bold text-text-primary">Field Messages</h1>
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-bg-secondary">
          <aside className={`${activeJob ? 'hidden md:block' : 'block'} w-full overflow-y-auto border-r border-border md:w-80 md:flex-shrink-0`}>
            {state === 'loading' && <div className="p-3"><SkeletonCardList count={4} rows={2} /></div>}
            {state === 'error' && (
              <EmptyState icon={MessageSquare} title="Couldn't load threads" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => { setState('loading'); load(); } }} />
            )}
            {state === 'ready' && threads.length === 0 && (
              <EmptyState icon={MessageSquare} title="No field messages yet" description="When a technician messages about a job, it shows up here." />
            )}
            {state === 'ready' && threads.map((t) => (
              <button
                key={t.job_id}
                type="button"
                onClick={() => setParams({ job: t.job_id })}
                className={`focus-ring flex w-full items-start gap-2 border-b border-border px-4 py-3 text-left hover:bg-bg-tertiary ${t.job_id === activeJob ? 'bg-bg-tertiary' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm text-text-primary ${t.unread_count ? 'font-semibold' : 'font-medium'}`}>{t.customer_name}</p>
                  <p className="truncate text-xs text-text-secondary">{t.service_type || '—'}</p>
                  <p dir="auto" className="mt-0.5 truncate text-xs text-text-secondary">{previewText(t, 'office')}</p>
                </div>
                {t.unread_count > 0 && <span className="rounded-full bg-accent px-1.5 py-0.5 text-xs font-semibold text-white" aria-label={`${t.unread_count} unread`}>{t.unread_count}</span>}
              </button>
            ))}
          </aside>

          <section className={`${activeJob ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
            {activeJob ? (
              <>
                <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                  <button type="button" onClick={() => setParams({})} className="focus-ring rounded md:hidden" aria-label="Back to threads"><ArrowLeft className="h-5 w-5" /></button>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-text-primary">{active?.customer_name ?? 'Job thread'}</p>
                    {active?.address && <p className="truncate text-xs text-text-secondary">{active.address}</p>}
                  </div>
                </div>
                <div className="min-h-0 flex-1"><JobThread key={activeJob} jobId={activeJob} viewer="office" /></div>
              </>
            ) : (
              <EmptyState icon={MessageSquare} title="Select a conversation" description="Pick a job on the left to read and reply." />
            )}
          </section>
        </div>
      </div>
    </DashboardLayout>
  );
}
