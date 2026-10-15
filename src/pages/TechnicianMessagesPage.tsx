import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useRealtimeSubscription } from '@/lib/realtime';
import { fetchThreadSummaries, previewText, type ThreadSummary } from '@/lib/jobMessages';
import { formatTime } from '@/lib/technicianOS';

export function TechnicianMessagesPage() {
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(() => {
    fetchThreadSummaries()
      .then((rows) => { setThreads(rows); setState('ready'); })
      .catch(() => setState((s) => (s === 'ready' ? s : 'error')));
  }, []);

  useEffect(load, [load]);

  // RLS scopes realtime events to threads this technician can read.
  const status = useRealtimeSubscription({
    channelName: 'tech-messages-inbox', table: 'job_messages', event: 'INSERT', onChange: load, enabled: state === 'ready',
  });

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <button type="button" onClick={() => navigate('/tech/today')} className="focus-ring rounded" aria-label="Back to today"><ArrowLeft className="h-5 w-5" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text-primary">Messages</h1>
          <p className="text-sm text-text-secondary">Your job threads with the office</p>
        </div>
        <LiveIndicator status={status} />
      </header>

      <main className="mx-auto max-w-lg px-4 py-4">
        {state === 'loading' && <SkeletonCardList count={4} rows={2} />}

        {state === 'error' && (
          <EmptyState icon={MessageSquare} title="Couldn't load messages" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => { setState('loading'); load(); } }} />
        )}

        {state === 'ready' && threads.length === 0 && (
          <EmptyState icon={MessageSquare} title="No conversations yet" description="Open a job and tap Message office to start a thread." action={{ label: 'Go to today’s jobs', onClick: () => navigate('/tech/today') }} />
        )}

        {state === 'ready' && threads.length > 0 && (
          <ul className="space-y-3">
            {threads.map((t) => (
              <li key={t.job_id}>
                <Link
                  to={`/tech/messages/${t.job_id}`}
                  className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-secondary p-4 active:scale-[0.98]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate ${t.unread_count ? 'font-semibold' : 'font-medium'} text-text-primary`}>{t.customer_name}</span>
                      <span className="flex-shrink-0 text-xs text-text-secondary">{formatTime(t.last_message_at ?? t.scheduled_datetime)}</span>
                    </div>
                    <p className="truncate text-xs text-text-secondary">{t.service_type || '—'}</p>
                    <p dir="auto" className={`mt-1 truncate text-sm ${t.unread_count ? 'text-text-primary' : 'text-text-secondary'}`}>{previewText(t, 'technician')}</p>
                  </div>
                  {t.unread_count > 0 && (
                    <span className="min-w-[22px] rounded-full bg-accent px-1.5 py-0.5 text-center text-xs font-semibold text-white" aria-label={`${t.unread_count} unread`}>{t.unread_count}</span>
                  )}
                  <ChevronRight className="h-5 w-5 flex-shrink-0 text-text-secondary" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}

        {state === 'ready' && <div className="mt-6 text-center"><Button variant="ghost" size="sm" onClick={load}>Refresh</Button></div>}
      </main>
    </div>
  );
}
