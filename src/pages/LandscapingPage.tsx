import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { useAccountOwnerId } from '@/lib/customFieldsApi';
import { useLandscapingAccess } from '@/lib/landscapingApi';
import { LANDSCAPING_PACK } from '@/lib/tradePacks/landscaping/index';
import { BillingPanel } from '@/components/landscaping/BillingPanel';
import { ContractsPanel } from '@/components/landscaping/ContractsPanel';
import { CrewsPanel } from '@/components/landscaping/CrewsPanel';
import { PerformancePanel } from '@/components/landscaping/PerformancePanel';
import { PropertiesPanel } from '@/components/landscaping/PropertiesPanel';
import { RouteBoardPanel } from '@/components/landscaping/RouteBoardPanel';

type TabKey = 'today' | 'contracts' | 'properties' | 'crews' | 'billing' | 'performance';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'today', label: 'Route board' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'properties', label: 'Properties' },
  { key: 'crews', label: 'Crews & equipment' },
  { key: 'billing', label: 'Billing' },
  { key: 'performance', label: 'Performance' },
];

/**
 * Landscaping workspace. Gated twice: feature flag `landscaping_pack` + account entitlement `packs:landscaping`
 * (UI gate only — every table and RPC re-checks both on the server). Without access this renders a neutral
 * “not available” state and loads nothing.
 */
export function LandscapingPage() {
  const { isOwner, permissions, teamMember } = useAuth();
  const ownerId = useAccountOwnerId();
  const access = useLandscapingAccess();
  const [tab, setTab] = useState<TabKey>('today');
  const canManage = Boolean(isOwner || permissions?.can_edit_business_profile || teamMember?.role === 'admin');

  if (access.loading) {
    return (
      <div className="mx-auto max-w-5xl p-4" aria-busy="true" aria-live="polite">
        <SkeletonCard rows={3} />
      </div>
    );
  }
  if (!access.allowed || !ownerId) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <EmptyState variant="no-permission" title="Landscaping is not available on this account" description="Ask your Vireek contact to enable the Landscaping module." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold text-text-primary">{LANDSCAPING_PACK.name}</h1>
        <p className="mt-1 text-sm text-text-secondary">{LANDSCAPING_PACK.tagline}</p>
        <p className="mt-1 text-xs text-text-secondary">Pack settings (custom fields, forms, pricing models) live in <Link className="text-accent underline" to="/dashboard/trade-packs">Trade Packs</Link>.</p>
      </header>

      <div role="tablist" aria-label="Landscaping sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            id={`ls-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`ls-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.key === tab);
              if (e.key === 'ArrowRight') setTab(TABS[(i + 1) % TABS.length].key);
              if (e.key === 'ArrowLeft') setTab(TABS[(i - 1 + TABS.length) % TABS.length].key);
            }}
            className={`focus-ring min-h-[44px] whitespace-nowrap px-3 text-sm font-medium ${tab === t.key ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`ls-panel-${tab}`} aria-labelledby={`ls-tab-${tab}`}>
        {tab === 'today' && <RouteBoardPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'contracts' && <ContractsPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'properties' && <PropertiesPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'crews' && <CrewsPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'billing' && <BillingPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'performance' && <PerformancePanel />}
      </div>
    </div>
  );
}

export default LandscapingPage;
