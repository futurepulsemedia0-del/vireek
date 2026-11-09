import { useState } from 'react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { usePartsSourcingEnabled } from '@/hooks/usePartsSourcingEnabled';
import { CompareTab } from '@/components/partsSourcing/CompareTab';
import { OrdersTab } from '@/components/partsSourcing/OrdersTab';
import { SpendTab } from '@/components/partsSourcing/SpendTab';
import { SetupTab } from '@/components/partsSourcing/SetupTab';
import { EmptyState, LoadingRow } from '@/components/partsSourcing/shared';

type TabKey = 'compare' | 'orders' | 'spend' | 'setup';

export function PartsSourcingPage() {
  const { enabled, ready } = usePartsSourcingEnabled();
  const { isOwner, teamMember } = useAuth();
  const [tab, setTab] = useState<TabKey>('compare');
  // UI hint only — every RPC and RLS policy re-checks the role on the server.
  const manager = isOwner || teamMember?.role === 'admin';
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'compare', label: 'Compare & order' },
    ...(manager ? ([{ key: 'orders', label: 'Orders' }, { key: 'spend', label: 'Spend' }, { key: 'setup', label: 'Setup' }] as { key: TabKey; label: string }[]) : []),
  ];

  return (
    <DashboardLayout activeLabel="Parts Sourcing">
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Parts sourcing</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Compare truck, branch and supplier options, order against a job, and see whether delivery makes the appointment.
          </p>
        </div>
        {!ready ? (
          <LoadingRow />
        ) : !enabled ? (
          <EmptyState>Parts sourcing is not enabled for this account.</EmptyState>
        ) : (
          <>
            <div role="tablist" aria-label="Parts sourcing sections" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  type="button"
                  id={`ps-tab-${t.key}`}
                  aria-selected={tab === t.key}
                  aria-controls={`ps-panel-${t.key}`}
                  onClick={() => setTab(t.key)}
                  className={`focus-ring min-h-[40px] shrink-0 rounded-lg px-4 text-sm font-semibold ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`ps-panel-${tab}`} aria-labelledby={`ps-tab-${tab}`}>
              {tab === 'compare' && <CompareTab />}
              {tab === 'orders' && manager && <OrdersTab />}
              {tab === 'spend' && manager && <SpendTab />}
              {tab === 'setup' && manager && <SetupTab />}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
