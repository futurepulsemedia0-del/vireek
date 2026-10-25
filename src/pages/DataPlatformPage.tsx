import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Database } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useCanManageDataPlatform, useCanViewMetrics } from '@/lib/dataPlatform';
import { MetricsTab } from '@/components/data-platform/MetricsTab';
import { WarehouseTab } from '@/components/data-platform/WarehouseTab';
import { ReverseEtlTab } from '@/components/data-platform/ReverseEtlTab';
import { EmbedsTab } from '@/components/data-platform/EmbedsTab';
import { SchemaTab } from '@/components/data-platform/SchemaTab';
import { useDestinationData } from '@/components/data-platform/useDestinationData';
import { ErrorBanner, NoAccess, Skeleton } from '@/components/data-platform/ui';

const TABS = [
  { id: 'metrics', label: 'Metrics' },
  { id: 'warehouse', label: 'Warehouse' },
  { id: 'reverse', label: 'Reverse ETL' },
  { id: 'embeds', label: 'Embeds' },
  { id: 'schema', label: 'Schema' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function DataPlatformPage() {
  const { loading: authLoading, profileLoading } = useAuth();
  const canManage = useCanManageDataPlatform();
  const canMetrics = useCanViewMetrics();
  const [params, setParams] = useSearchParams();
  const pending = authLoading || profileLoading;

  const visible = useMemo(() => TABS.filter((t) => (t.id === 'metrics' ? canMetrics : t.id === 'schema' ? canManage || canMetrics : canManage)), [canManage, canMetrics]);
  const requested = params.get('tab');
  const tab: TabId = (visible.find((t) => t.id === requested)?.id ?? visible[0]?.id ?? 'metrics') as TabId;

  // Only people who manage the platform load destinations, runs and embeds.
  const data = useDestinationData(canManage);

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Database size={22} />
      </span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Data Platform</h1>
        <p className="text-sm text-text-secondary">One set of metric definitions, your data in your warehouse, and analytics you can embed.</p>
      </div>
    </div>
  );

  if (pending) {
    return (
      <DashboardLayout activeLabel="Data Platform">
        {header}
        <Skeleton className="mb-4 h-10 w-full max-w-md rounded-xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </DashboardLayout>
    );
  }

  if (!visible.length) {
    return (
      <DashboardLayout activeLabel="Data Platform">
        {header}
        <NoAccess what="Ask the account owner for the “export data” or “view billing” permission to open the Data Platform." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Data Platform">
      {header}
      <div role="tablist" aria-label="Data Platform sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {visible.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`dp-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`dp-panel-${t.id}`}
            type="button"
            onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`focus-ring -mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`dp-panel-${tab}`} aria-labelledby={`dp-tab-${tab}`}>
        {data.error && tab !== 'metrics' && tab !== 'schema' && <div className="mb-4"><ErrorBanner message={data.error} onRetry={() => void data.reload()} /></div>}
        {tab === 'metrics' && <MetricsTab />}
        {tab === 'schema' && <SchemaTab />}
        {tab !== 'metrics' && tab !== 'schema' && data.loading ? (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        ) : (
          <>
            {tab === 'warehouse' && <WarehouseTab data={data} />}
            {tab === 'reverse' && <ReverseEtlTab data={data} />}
            {tab === 'embeds' && <EmbedsTab data={data} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
