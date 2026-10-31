import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PlugZap } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useCanManageDataPlatform } from '@/lib/dataPlatform';
import { AccessTab } from '@/components/bi-connectors/AccessTab';
import { ExportsTab } from '@/components/bi-connectors/ExportsTab';
import { GuidesTab } from '@/components/bi-connectors/GuidesTab';
import { useBiData } from '@/components/bi-connectors/useBiData';
import { ErrorBanner, NoAccess, Skeleton } from '@/components/data-platform/ui';

const TABS = [
  { id: 'access', label: 'Live access' },
  { id: 'exports', label: 'File exports' },
  { id: 'guides', label: 'Connection guides' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function BiConnectorsPage() {
  const { loading: authLoading, profileLoading, isOwner } = useAuth();
  const canManage = useCanManageDataPlatform();
  const [params, setParams] = useSearchParams();
  const pending = authLoading || profileLoading;
  const data = useBiData(canManage);
  const requested = params.get('tab');
  const tab: TabId = useMemo(() => TABS.find((t) => t.id === requested)?.id ?? 'access', [requested]);

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><PlugZap size={22} /></span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">BI Connectors</h1>
        <p className="text-sm text-text-secondary">Read-only access for Power BI, Tableau and Excel, plus scheduled exports to S3 and SFTP.</p>
      </div>
    </div>
  );

  if (pending) {
    return (
      <DashboardLayout activeLabel="BI Connectors">
        {header}
        <Skeleton className="mb-4 h-10 w-full max-w-md rounded-xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </DashboardLayout>
    );
  }
  if (!canManage) {
    return (
      <DashboardLayout activeLabel="BI Connectors">
        {header}
        <NoAccess what="Ask the account owner for the “export data” permission to open BI Connectors." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="BI Connectors">
      {header}
      <div role="tablist" aria-label="BI Connectors sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`bi-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`bi-panel-${t.id}`} type="button" onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`focus-ring -mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`bi-panel-${tab}`} aria-labelledby={`bi-tab-${tab}`}>
        {data.error && tab !== 'guides' && <div className="mb-4"><ErrorBanner message={data.error} onRetry={() => void data.reload()} /></div>}
        {tab === 'guides' ? <GuidesTab /> : data.loading ? (
          <div className="space-y-4"><Skeleton className="h-40 w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>
        ) : tab === 'access' ? <AccessTab data={data} isOwner={isOwner} /> : <ExportsTab data={data} isOwner={isOwner} />}
      </div>
    </DashboardLayout>
  );
}
