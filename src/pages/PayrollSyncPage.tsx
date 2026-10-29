import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plug, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { LoadError, SelectField, useLoader } from '@/components/commissions/shared';
import { ActivityTab } from '@/components/payrollSync/ActivityTab';
import { BatchesTab } from '@/components/payrollSync/BatchesTab';
import { ConnectionTab } from '@/components/payrollSync/ConnectionTab';
import { EmployeesTab } from '@/components/payrollSync/EmployeesTab';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchConnections, useCanManagePayrollSync } from '@/lib/payrollSync';

type TabId = 'batches' | 'employees' | 'connection' | 'activity';
const TABS: { id: TabId; label: string }[] = [
  { id: 'batches', label: 'Batches' },
  { id: 'employees', label: 'Employees' },
  { id: 'connection', label: 'Connection' },
  { id: 'activity', label: 'Activity' },
];
const REASONS: Record<string, string> = {
  invalid_state: 'The connection link expired. Please try again.',
  access_denied: 'The connection was cancelled.',
  no_company: 'We could not find a company you administer in that account.',
  company_in_use: 'That company is already connected to another Vireek account.',
  not_configured: 'The payroll provider is not configured on the server yet.',
};

export function PayrollSyncPage() {
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const canManage = useCanManagePayrollSync();
  const ownerId = profile?.role === 'owner' ? (user?.id ?? null) : ((profile as { account_owner_id?: string | null } | null)?.account_owner_id ?? user?.id ?? null);
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>('batches');
  const [empConn, setEmpConn] = useState('');

  const connections = useLoader(() => (ownerId && canManage ? fetchConnections(ownerId) : Promise.resolve([])), [ownerId, canManage]);

  useEffect(() => {
    const result = params.get('payroll');
    if (!result) return;
    if (result === 'connected') {
      toast('Payroll provider connected. Link your employees next.', 'success');
      setTab('employees');
      connections.reload();
    } else {
      toast(REASONS[params.get('reason') ?? ''] ?? 'Could not connect the payroll provider.', 'error');
      setTab('connection');
    }
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const header = (
    <header className="flex items-start gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Plug size={20} /></span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Payroll sync</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">Send approved hours, overtime and commissions to your payroll provider as a reviewed, approved batch. Vireek never runs payroll or moves money; you finish it in your provider.</p>
      </div>
    </header>
  );

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Payroll Sync">
        <div className="mx-auto max-w-6xl space-y-6 px-1 py-4 sm:px-4">
          {header}
          <EmptyState icon={ShieldAlert} title="Payroll sync is restricted" description="Only account owners and team members with business-profile and billing access can manage payroll integrations." />
        </div>
      </DashboardLayout>
    );
  }

  const all = connections.data ?? [];
  const live = all.filter((c) => c.status === 'connected');
  const empConnection = live.find((c) => c.id === empConn) ?? live[0];

  return (
    <DashboardLayout activeLabel="Payroll Sync">
      <div className="mx-auto max-w-6xl space-y-6 px-1 py-4 sm:px-4">
        {header}
        <div role="tablist" aria-label="Payroll sync sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`focus-ring shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${tab === t.id ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
          ))}
        </div>
        {connections.error ? <LoadError message={connections.error} onRetry={connections.reload} /> : connections.loading ? <SkeletonCardList count={3} rows={2} /> : !ownerId ? null : (
          <>
            {tab === 'batches' && <BatchesTab ownerId={ownerId} connections={all} onGoToEmployees={() => setTab('employees')} />}
            {tab === 'employees' && (empConnection ? (
              <div className="space-y-4">
                {live.length > 1 && <SelectField label="Provider" value={empConnection.id} onChange={setEmpConn}>{live.map((c) => <option key={c.id} value={c.id}>{c.company_name ?? c.provider}</option>)}</SelectField>}
                <EmployeesTab ownerId={ownerId} connection={empConnection} />
              </div>
            ) : <EmptyState icon={Plug} title="Connect a provider first" description="Open the Connection tab to link your payroll provider." />)}
            {tab === 'connection' && <ConnectionTab connections={all} onChanged={connections.reload} />}
            {tab === 'activity' && <ActivityTab ownerId={ownerId} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
