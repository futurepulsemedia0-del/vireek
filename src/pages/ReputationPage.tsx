import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, MessageSquareText, Star } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { ConnectionsPanel } from '@/components/reputation/ConnectionsPanel';
import { ReviewInbox } from '@/components/reputation/ReviewInbox';
import { TrendsPanel } from '@/components/reputation/TrendsPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { canManageReputation, fetchOverview, type Overview } from '@/lib/reputation';

type Tab = 'inbox' | 'trends' | 'sources';
const TABS: { key: Tab; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'trends', label: 'Trends' },
  { key: 'sources', label: 'Sources & alerts' },
];

const CONNECT_ERRORS: Record<string, string> = {
  denied: 'The connection was cancelled.',
  no_refresh_token: "Google didn't grant ongoing access. Try again and approve every permission.",
  no_locations_found: 'No business locations were found on that Google account.',
  no_pages_found: 'No Facebook Pages were found on that account.',
  invalid_state: 'That connection link expired. Please try again.',
};

// Scoping note: every read/write goes through the reputation edge function, which
// resolves the ACCOUNT OWNER id (accountOwnerId) server-side, so team members with
// the permission work on the same inbox as the owner.
export function ReputationPage() {
  const { isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const allowed = canManageReputation(isOwner, permissions);

  const [data, setData] = useState<Overview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('inbox');

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setData(await fetchOverview());
      setStatus('ready');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : undefined);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // Result of the Google / Facebook OAuth round trip (?connect=ok|error).
  useEffect(() => {
    const result = params.get('connect');
    if (!result) return;
    if (result === 'ok') toast(`Connected ${params.get('count') ?? ''} listing(s). Reviews are syncing.`.replace('  ', ' '), 'success');
    else toast(CONNECT_ERRORS[params.get('reason') ?? ''] ?? "We couldn't finish connecting. Please try again.", 'error');
    setTab('sources');
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  if (authLoading || profileLoading) {
    return (
      <DashboardLayout activeLabel="Reputation">
        <SkeletonCard rows={3} />
      </DashboardLayout>
    );
  }

  if (!allowed) {
    return (
      <DashboardLayout activeLabel="Reputation">
        <EmptyState icon={Lock} title="You don't have access to reputation management" description="Replying to reviews speaks for the business. Ask the account owner to give you business-profile access." />
      </DashboardLayout>
    );
  }

  const open = data?.reviews.filter((r) => r.status === 'new').length ?? 0;

  return (
    <DashboardLayout activeLabel="Reputation">
      <div className="mx-auto max-w-4xl pb-16">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Star size={22} aria-hidden="true" /> Reputation
          </h1>
          <p className="mt-1 text-sm text-text-secondary">One inbox for your Google, Yelp and Facebook reviews — with AI-drafted replies, low-rating alerts and rating trends.</p>
        </div>

        {status === 'loading' && (
          <div className="space-y-4" aria-busy="true" aria-label="Loading reviews">
            <Skeleton className="h-10 w-full rounded-xl" />
            <SkeletonCard rows={3} />
            <SkeletonCard rows={3} />
          </div>
        )}

        {status === 'error' && <EmptyStateError icon={MessageSquareText} title="Couldn't load your reviews" description={errorText} onRetry={load} />}

        {status === 'ready' && data && (
          <>
            <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Reputation sections">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`focus-ring -mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                >
                  {t.label}
                  {t.key === 'inbox' && open > 0 && <span className="ml-2 rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">{open}</span>}
                </button>
              ))}
            </div>

            {tab === 'inbox' && <ReviewInbox data={data} onChange={setData} />}
            {tab === 'trends' && <TrendsPanel data={data} />}
            {tab === 'sources' && <ConnectionsPanel data={data} isOwner={isOwner} onChange={setData} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
