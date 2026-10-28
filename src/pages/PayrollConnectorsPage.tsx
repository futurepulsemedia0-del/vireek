import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldAlert, Unplug } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { LoadError, useLoader } from '@/components/commissions/shared';
import { ExportTab } from '@/components/payroll-connectors/ExportTab';
import { ConnectionsTab } from '@/components/payroll-connectors/ConnectionsTab';
import { MappingTab } from '@/components/payroll-connectors/MappingTab';
import { HistoryTab } from '@/components/payroll-connectors/HistoryTab';
import { useToast } from '@/contexts/ToastContext';
import { listConnections, useCanManagePayrollConnectors, usePayrollOwnerId, type PayrollProvider } from '@/lib/payrollConnectors';

type TabId = 'export' | 'connections' | 'mapping' | 'history';
const TABS: { id: TabId; label: string }[] = [
  { id: 'export', label: 'Export' },
  { id: 'history', label: 'History' },
  { id: 'mapping', label: 'Employee mapping' },
  { id: 'connections', label: 'Connections' },
];

const OAUTH_REASONS: Record<string, string> = {
  access_denied: 'Gusto access was not granted.',
  invalid_state: 'The connection link expired. Please try again.',
  not_configured: 'Gusto isn’t configured on the server yet. Ask your administrator.',
  exchange_failed: 'Gusto could not be connected. Please try again.',
  no_refresh_token: 'Gusto did not return a long-lived connection. Please try again.',
  missing_code: 'Gusto did not return an authorization code. Please try again.',
};

export function PayrollConnectorsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canManage = useCanManagePayrollConnectors();
  const ownerId = usePayrollOwnerId() ?? null;

  const [tab, setTab] = useState<TabId>('export');
  const [mappingProvider, setMappingProvider] = useState<PayrollProvider | null>(null);
  const [openExport, setOpenExport] = useState<string | null>(null);

  const connections = useLoader(async () => (ownerId && canManage ? listConnections(ownerId) : []), [ownerId, canManage]);

  // Returning from Gusto's consent screen: show the outcome once, then clean the URL.
  useEffect(() => {
    const result = params.get('gusto');
    if (!result) return;
    if (result === 'connected') {
      toast('Gusto connected. Choose a company if asked, then map your employees.', 'success');
      setTab('connections');
    } else {
      toast(OAUTH_REASONS[params.get('reason') ?? ''] ?? 'Gusto could not be connected.', 'error');
      setTab('connections');
    }
    params.delete('gusto');
    params.delete('reason');
    setParams(params, { replace: true });
    connections.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const header = (
    <header className="flex items-start gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Unplug size={20} />
      </span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Payroll connectors</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Hand approved hours, commissions and tips to Gusto, ADP, Paychex or Rippling. Every export reserves its items so nothing is paid twice, and can be voided.
        </p>
      </div>
    </header>
  );

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Payroll Connectors">
        <div className="mx-auto max-w-6xl space-y-6 px-1 py-4 sm:px-4">
          {header}
          <EmptyState icon={ShieldAlert} title="Payroll connectors are restricted" description="Only account owners and team members with billing access can export payroll data. Ask your account owner to grant access." />
        </div>
      </DashboardLayout>
    );
  }

  const conns = connections.data ?? [];

  return (
    <DashboardLayout activeLabel="Payroll Connectors">
      <div className="mx-auto max-w-6xl space-y-6 px-1 py-4 sm:px-4">
        {header}

        <div role="tablist" aria-label="Payroll connector sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`pc-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`pc-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`focus-ring -mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`pc-panel-${tab}`} aria-labelledby={`pc-tab-${tab}`}>
          {!ownerId || connections.loading ? (
            <SkeletonCardList count={3} rows={2} />
          ) : connections.error ? (
            <LoadError message={connections.error} onRetry={connections.reload} />
          ) : tab === 'export' ? (
            <ExportTab
              ownerId={ownerId}
              connections={conns}
              onCreated={(id) => { setOpenExport(id); setTab('history'); }}
              onGoToConnections={() => setTab('connections')}
              onGoToMapping={(p) => { setMappingProvider(p); setTab('mapping'); }}
            />
          ) : tab === 'history' ? (
            <HistoryTab ownerId={ownerId} connections={conns} openId={openExport} onOpenedChange={setOpenExport} onGoToExport={() => setTab('export')} />
          ) : tab === 'mapping' ? (
            <MappingTab connections={conns} provider={mappingProvider} onProviderChange={setMappingProvider} onGoToConnections={() => setTab('connections')} />
          ) : (
            <ConnectionsTab connections={conns} onChanged={connections.reload} onGoToMapping={(p) => { setMappingProvider(p); setTab('mapping'); }} />
          )}
        </div>

        <p className="text-xs text-text-secondary">
          Payroll taxes, withholding and payments are handled by your provider. Looking for Vireek’s own pay runs?{' '}
          <button type="button" className="focus-ring font-medium text-accent hover:underline" onClick={() => navigate('/dashboard/payroll')}>Open Payroll</button>.
        </p>
      </div>
    </DashboardLayout>
  );
}
