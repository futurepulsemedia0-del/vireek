import { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { CampaignsPanel } from '@/components/directmail/CampaignsPanel';
import { ResultsPanel } from '@/components/directmail/ResultsPanel';
import { SetupPanel } from '@/components/directmail/SetupPanel';
import { useAuth } from '@/contexts/AuthContext';
import type { DirectMailSettings } from '@/lib/directMail';
import { fetchSettings } from '@/lib/directMailApi';

const PAGE = 'Direct Mail';
type Tab = 'campaigns' | 'results' | 'setup';
const TABS: { id: Tab; label: string }[] = [
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'results', label: 'Results' },
  { id: 'setup', label: 'Setup' },
];

export function DirectMailPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  // Everything is keyed by the ACCOUNT OWNER's id (differs from user.id for team members).
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('campaigns');
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [settings, setSettings] = useState<DirectMailSettings | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setSettings(await fetchSettings());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => { if (ownerId && canAccess) void load(); }, [ownerId, canAccess, load]);

  if (authLoading || profileLoading) {
    return <DashboardLayout activeLabel={PAGE}><div className="mx-auto w-full max-w-5xl"><SkeletonCardList count={3} rows={2} /></div></DashboardLayout>;
  }

  if (!canAccess || !ownerId) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <div className="mx-auto w-full max-w-3xl">
          <EmptyState icon={Mail} title="Direct mail is limited to account managers"
            description="Ask the account owner for billing access to send postcards or see their results." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><Mail size={22} className="text-accent" /> Direct mail</h1>
          <p className="mt-1 text-sm text-text-secondary">Postcards with a unique QR code and offer code per household, tracked from mailbox to booked job.</p>
        </header>

        <div role="tablist" aria-label="Direct mail sections" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`dm-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`dm-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`focus-ring shrink-0 rounded-lg px-4 py-2 text-sm font-medium ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {status === 'loading' && <SkeletonCardList count={3} rows={2} />}
        {status === 'error' && <EmptyStateError icon={Mail} title="Couldn't load direct mail" onRetry={() => void load()} />}

        {status === 'ready' && settings && (
          <div role="tabpanel" id={`dm-panel-${tab}`} aria-labelledby={`dm-tab-${tab}`}>
            {tab === 'campaigns' && <CampaignsPanel ownerId={ownerId} settings={settings} />}
            {tab === 'results' && <ResultsPanel />}
            {tab === 'setup' && <SetupPanel settings={settings} onChange={(s) => (s ? setSettings(s) : void load())} onReload={() => void load()} />}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

export default DirectMailPage;
