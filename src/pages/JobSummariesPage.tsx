// /dashboard/job-summaries — review queue, sent history and settings for automatic post-job summaries.
// Schema: supabase/migrations/20271020000000_job_summaries.sql · Engine: supabase/functions/job-summary-engine
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, Lock } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { JobSummaryEditor } from '@/components/jobs/JobSummaryEditor';
import { JobSummarySettingsForm } from '@/components/jobs/JobSummarySettingsForm';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  DEFAULT_SETTINGS,
  STATUS_LABELS,
  describeWarnings,
  scheduledCountdown,
  type JobSummary,
  type JobSummarySettings,
  type SummaryStatus,
} from '@/lib/jobSummaries';
import { fetchSettings, fetchSummaries } from '@/lib/jobSummariesApi';

type Tab = 'queue' | 'sent' | 'settings';
const TABS: { key: Tab; label: string; statuses: SummaryStatus[] }[] = [
  { key: 'queue', label: 'Review queue', statuses: ['draft', 'scheduled', 'sending', 'failed', 'skipped'] },
  { key: 'sent', label: 'Sent', statuses: ['sent'] },
  { key: 'settings', label: 'Settings', statuses: [] },
];

export function JobSummariesPage() {
  const { isOwner, permissions, profile, teamMember } = useAuth();
  const [params, setParams] = useSearchParams();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canView = isOwner || permissions.can_view_all_jobs;
  const canConfigure = isOwner || permissions.can_view_billing; // same bar as identity_is_manager()

  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = TABS.some((t) => t.key === tabParam) ? (tabParam as Tab) : 'queue';
  const selectedId = params.get('summary');

  const [rows, setRows] = useState<JobSummary[]>([]);
  const [settings, setSettings] = useState<JobSummarySettings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    if (!ownerId || !canView) return;
    try {
      const statuses = TABS.find((t) => t.key === tab)!.statuses;
      if (tab === 'settings') {
        if (canConfigure) setSettings(await fetchSettings(ownerId));
      } else {
        setRows(await fetchSummaries(ownerId, statuses));
      }
      setState('ready');
    } catch {
      setState('error');
    }
  }, [ownerId, canView, canConfigure, tab]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  useRealtimeSubscription({
    channelName: `job-summaries-${ownerId ?? 'none'}`,
    table: 'job_summaries',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    enabled: !!ownerId && canView && tab !== 'settings',
    onChange: () => void load(),
  });

  const setTab = (t: Tab) => setParams(t === 'queue' ? {} : { tab: t }, { replace: true });
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('summary', id);
    else next.delete('summary');
    setParams(next, { replace: true });
  };
  const replaceRow = (s: JobSummary) => setRows((r) => r.map((x) => (x.id === s.id ? s : x)));
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  if (!canView) {
    return (
      <DashboardLayout activeLabel="Job Summaries">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <EmptyState icon={Lock} title="You don't have access" description="Ask an owner or admin for the “View all jobs” permission." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Job Summaries">
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">Job summaries</h1>
          <p className="mt-1 text-sm text-text-secondary">A friendly “what we did” for every completed job — photos, work, parts, warranty and next service — sent by text/email and kept in the customer portal.</p>
        </header>

        <nav className="flex gap-1 border-b border-border" role="tablist" aria-label="Job summaries">
          {TABS.filter((t) => t.key !== 'settings' || canConfigure).map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.key ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              {t.label}
            </button>
          ))}
        </nav>

        {state === 'loading' && <SkeletonCardList />}
        {state === 'error' && <EmptyStateError icon={ClipboardCheck} title="Couldn't load summaries" onRetry={() => void load()} />}

        {state === 'ready' && tab === 'settings' && canConfigure && ownerId && (
          <JobSummarySettingsForm ownerId={ownerId} initial={settings} onSaved={setSettings} />
        )}

        {state === 'ready' && tab !== 'settings' && ownerId && (
          rows.length === 0 ? (
            <EmptyState icon={ClipboardCheck} title={tab === 'queue' ? 'Nothing waiting for review' : 'No summaries sent yet'} description={tab === 'queue' ? 'Turn on automatic summaries in Settings, or open a completed job and generate one.' : 'Sent summaries appear here with delivery and view status.'} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
              <ul className="space-y-2" aria-label="Summaries">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => select(r.id)} aria-current={selectedId === r.id} className={`focus-ring w-full rounded-xl border p-3.5 text-left ${selectedId === r.id ? 'border-accent bg-bg-tertiary' : 'border-border bg-bg-secondary hover:bg-bg-tertiary'}`}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">{r.customer_name}</span>
                        <span className="shrink-0 text-xs text-text-secondary">{STATUS_LABELS[r.status]}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-secondary">{r.service_type ?? 'Service visit'}</span>
                      {r.status === 'scheduled' && <span className="mt-1 block text-xs text-accent">{scheduledCountdown(r.scheduled_send_at)}</span>}
                      {r.status === 'draft' && r.warnings.length > 0 && <span className="mt-1 block truncate text-xs text-warning-500">{describeWarnings(r.warnings)[0]}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                {selected ? (
                  <>
                    <p className="mb-3 text-xs text-text-secondary">
                      <Link to={`/dashboard/jobs/${selected.job_id}`} className="text-accent underline">Open job</Link>
                    </p>
                    <JobSummaryEditor key={selected.id} summary={selected} ownerId={ownerId} onChange={replaceRow} />
                  </>
                ) : (
                  <p className="text-sm text-text-secondary">Select a summary to review it.</p>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </DashboardLayout>
  );
}
