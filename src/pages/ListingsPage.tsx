import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, MapPin, Store } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { ActivityPanel } from '@/components/listings/ActivityPanel';
import { ChannelsPanel } from '@/components/listings/ChannelsPanel';
import { LocationsPanel } from '@/components/listings/LocationsPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { buildLocationRows, canManageListings, fetchListings, overallHealth, type ListingsOverview } from '@/lib/listings';

type Tab = 'locations' | 'channels' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'locations', label: 'Locations' },
  { key: 'channels', label: 'Directories & settings' },
  { key: 'activity', label: 'Activity' },
];

const CONNECT_ERRORS: Record<string, string> = {
  denied: 'The connection was cancelled.',
  no_pages_found: 'No Facebook Pages were found on that account.',
  invalid_state: 'That connection link expired. Please try again.',
};

// Scoping note: every read/write goes through the listings edge function, which
// resolves the ACCOUNT OWNER id server-side, so team members with the permission
// work on the same listings as the owner.
export function ListingsPage() {
  const { isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const allowed = canManageListings(isOwner, permissions);

  const [data, setData] = useState<ListingsOverview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('locations');

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setData(await fetchListings());
      setStatus('ready');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : undefined);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // Result of the Facebook OAuth round trip (?connect=ok|error).
  useEffect(() => {
    const result = params.get('connect');
    if (!result) return;
    if (result === 'ok') toast(`Connected ${params.get('count') ?? ''} Facebook Page(s). Link them to a location to start syncing.`.replace('  ', ' '), 'success');
    else toast(CONNECT_ERRORS[params.get('reason') ?? ''] ?? "We couldn't finish connecting. Please try again.", 'error');
    setTab('channels');
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  if (authLoading || profileLoading) {
    return (
      <DashboardLayout activeLabel="Listings">
        <SkeletonCard rows={3} />
      </DashboardLayout>
    );
  }

  if (!allowed) {
    return (
      <DashboardLayout activeLabel="Listings">
        <EmptyState icon={Lock} title="You don't have access to listings" description="Listings speak for the business on Apple Maps, Bing, Yelp and Facebook. Ask the account owner to give you business-profile access." />
      </DashboardLayout>
    );
  }

  const attention = data ? buildLocationRows(data).reduce((n, r) => n + (r.links.length > 0 && r.health.attention > 0 ? 1 : 0), 0) : 0;
  const health = data ? overallHealth(data) : null;

  return (
    <DashboardLayout activeLabel="Listings">
      <div className="mx-auto max-w-4xl pb-16">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <MapPin size={22} aria-hidden="true" /> Listings
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Keep your name, address, phone and hours identical on Apple Maps, Bing, Yelp and Facebook — one source of truth, checked every day.
          </p>
          {health && health.total > 0 && (
            <p className="mt-2 text-sm font-medium text-text-primary" aria-live="polite">
              {health.synced} of {health.total} listings in sync ({health.percent}%)
            </p>
          )}
        </div>

        {status === 'loading' && (
          <div className="space-y-4" aria-busy="true" aria-label="Loading listings">
            <Skeleton className="h-10 w-full rounded-xl" />
            <SkeletonCard rows={3} />
            <SkeletonCard rows={3} />
          </div>
        )}

        {status === 'error' && <EmptyStateError icon={Store} title="Couldn't load your listings" description={errorText} onRetry={load} />}

        {status === 'ready' && data && (
          <>
            <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Listings sections">
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
                  {t.key === 'locations' && attention > 0 && <span className="ml-2 rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">{attention}</span>}
                </button>
              ))}
            </div>

            {tab === 'locations' && <LocationsPanel data={data} isOwner={isOwner} onChange={setData} onOpenChannels={() => setTab('channels')} />}
            {tab === 'channels' && <ChannelsPanel data={data} isOwner={isOwner} onChange={setData} />}
            {tab === 'activity' && <ActivityPanel data={data} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

export default ListingsPage;
