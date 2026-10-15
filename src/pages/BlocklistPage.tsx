import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCardList } from '@/components/Skeleton';
import { OverviewPanel } from '@/components/blocklist/OverviewPanel';
import { NumberListPanel } from '@/components/blocklist/NumberListPanel';
import { AutoBlockRules } from '@/components/blocklist/AutoBlockRules';
import { OverridesPanel } from '@/components/blocklist/OverridesPanel';

type TabId = 'overview' | 'blocklist' | 'dnc' | 'rules' | 'overrides';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'blocklist', label: 'Blocklist' },
  { id: 'dnc', label: 'Do Not Call' },
  { id: 'rules', label: 'Auto-block rules' },
  { id: 'overrides', label: 'Overrides' },
];

const PAGE_LABEL = 'Blocklist & DNC';

export function BlocklistPage() {
  const navigate = useNavigate();
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const [tab, setTab] = useState<TabId>('overview');
  // Bumped after any change so the Overview KPIs and the Overrides list stay truthful.
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Every list is keyed by the ACCOUNT OWNER's id (that is what the call path and the
  // outbound dialer query) — never by a team member's own user id.
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_manage_numbers;

  if (profileLoading || !profile) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <SkeletonCardList count={3} rows={3} />
      </DashboardLayout>
    );
  }

  if (!canAccess || !ownerId || !user) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">The blocklist and Do-Not-Call list are restricted. Ask your account owner to grant you number management access.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={PAGE_LABEL}>
      <div className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Blocklist &amp; Do Not Call</h1>
          <p className="mt-1 text-sm text-text-secondary">Stop spam and robocalls at the door, and keep a clean record of who you must never contact.</p>
        </div>
      </div>

      <div role="tablist" aria-label="Blocklist sections" className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`focus-ring -mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.id ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <OverviewPanel ownerId={ownerId} userId={user.id} refreshKey={refreshKey} onChanged={bump} />}
        {tab === 'blocklist' && <NumberListPanel kind="blocklist" ownerId={ownerId} userId={user.id} onChanged={bump} />}
        {tab === 'dnc' && <NumberListPanel kind="dnc" ownerId={ownerId} userId={user.id} onChanged={bump} />}
        {tab === 'rules' && <AutoBlockRules ownerId={ownerId} userId={user.id} onChanged={bump} />}
        {tab === 'overrides' && <OverridesPanel ownerId={ownerId} userId={user.id} refreshKey={refreshKey} onChanged={bump} />}
      </div>
    </DashboardLayout>
  );
}
