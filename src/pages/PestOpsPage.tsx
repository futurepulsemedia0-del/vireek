import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useAccountOwnerId } from '@/lib/customFieldsApi';
import { usePestOpsAccess } from '@/hooks/usePestOpsAccess';
import { PlansPanel } from '@/components/pestOps/PlansPanel';
import { CallbacksPanel } from '@/components/pestOps/CallbacksPanel';
import { NoticesPanel } from '@/components/pestOps/NoticesPanel';
import { StockPanel } from '@/components/pestOps/StockPanel';
import { RegionPanel } from '@/components/pestOps/RegionPanel';

type Tab = 'plans' | 'callbacks' | 'notices' | 'stock' | 'rules';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'plans', label: 'Plans & routes' },
  { key: 'callbacks', label: 'Callbacks' },
  { key: 'notices', label: 'Notices & reports' },
  { key: 'stock', label: 'Stock' },
  { key: 'rules', label: 'Record rules' },
];

export function PestOpsPage() {
  const { isOwner, permissions, teamMember } = useAuth();
  const ownerId = useAccountOwnerId();
  const access = usePestOpsAccess();
  const [tab, setTab] = useState<Tab>('plans');
  const canManage = isOwner || permissions.can_edit_business_profile || teamMember?.role === 'admin';

  if (!access.ready || !ownerId) return <div className="p-6"><Skeleton className="h-48 w-full" /></div>;
  if (!access.enabled) {
    return (
      <div className="p-6">
        <EmptyState variant="no-permission" title="Pest Ops is not enabled" description="This module is not part of your account yet. Contact support to turn it on." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text-primary">Pest Ops</h1>
        <p className="text-sm text-text-secondary">
          Service plans, guarantees, customer notices, product stock and record rules for your Pest Control pack.{' '}
          <Link to="/dashboard/trade-packs" className="text-accent hover:underline">Trade Packs</Link>
        </p>
      </header>
      <div role="tablist" aria-label="Pest Ops sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            id={`pest-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`pest-panel-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`focus-ring min-h-11 whitespace-nowrap px-3 text-sm font-medium ${tab === t.key ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`pest-panel-${tab}`} aria-labelledby={`pest-tab-${tab}`}>
        {tab === 'plans' && <PlansPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'callbacks' && <CallbacksPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'notices' && <NoticesPanel ownerId={ownerId} />}
        {tab === 'stock' && <StockPanel ownerId={ownerId} canManage={canManage} />}
        {tab === 'rules' && <RegionPanel ownerId={ownerId} canManage={canManage} />}
      </div>
    </div>
  );
}
