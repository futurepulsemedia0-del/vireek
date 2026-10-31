import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { AuditPanel } from '@/components/workorderguard/AuditPanel';
import { DepositsPanel } from '@/components/workorderguard/DepositsPanel';
import { ImportPanel } from '@/components/workorderguard/ImportPanel';
import { OrdersPanel } from '@/components/workorderguard/OrdersPanel';
import { ProfilePanel } from '@/components/workorderguard/ProfilePanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import type { WorkOrder } from '@/lib/workOrderGuard';
import { createDefaultProfile, listOrders, listProfiles, type PortalProfile } from '@/lib/workOrderGuardApi';

const PAGE = 'Work-Order Guard';
type Tab = 'orders' | 'audit' | 'import' | 'deposits' | 'rules';
const TABS: { id: Tab; label: string }[] = [
  { id: 'orders', label: 'Orders' }, { id: 'audit', label: 'Quarter Audit' }, { id: 'import', label: 'Import' },
  { id: 'deposits', label: 'Deposits' }, { id: 'rules', label: 'Rules' },
];

export function WorkOrderGuardPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  // Everything is keyed by the ACCOUNT OWNER's id (differs from user.id for team members).
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('orders');
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [profiles, setProfiles] = useState<PortalProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [creating, setCreating] = useState(false);

  const active = profiles.find((p) => p.id === activeId) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;

  const loadOrders = useCallback(async (pid: string) => {
    if (!ownerId) return;
    try { setOrders(await listOrders(ownerId, pid)); setStatus('ready'); } catch { setStatus('error'); }
  }, [ownerId]);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setStatus('loading');
    try {
      const ps = await listProfiles(ownerId);
      setProfiles(ps);
      const current = ps.find((p) => p.id === activeId) ?? ps.find((p) => p.isDefault) ?? ps[0];
      if (current) { setActiveId(current.id); await loadOrders(current.id); } else setStatus('ready');
    } catch { setStatus('error'); }
  }, [ownerId, activeId, loadOrders]);

  useEffect(() => { if (ownerId && canAccess) void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ownerId, canAccess]);

  if (authLoading || profileLoading) {
    return <DashboardLayout activeLabel={PAGE}><div className="mx-auto w-full max-w-5xl"><SkeletonCardList count={3} rows={2} /></div></DashboardLayout>;
  }
  if (!canAccess || !ownerId) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <div className="mx-auto w-full max-w-3xl">
          <EmptyState icon={ShieldCheck} title="Work-Order Guard is limited to account managers" description="Ask the account owner for billing access to review portal work orders." />
        </div>
      </DashboardLayout>
    );
  }

  const createFirst = async () => {
    setCreating(true);
    try { const p = await createDefaultProfile(); setProfiles([p]); setActiveId(p.id); setOrders([]); setStatus('ready'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not create the profile.', 'error'); }
    finally { setCreating(false); }
  };

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><ShieldCheck className="text-accent" size={24} /> Work-Order Guard</h1>
          <p className="mt-1 text-sm text-text-secondary">Catch the portal rules that void or reject your invoices — before they cost you. You import files; nothing logs in to or submits anything on your portal.</p>
        </header>

        {status === 'loading' ? (
          <SkeletonCardList count={3} rows={2} />
        ) : status === 'error' ? (
          <EmptyStateError icon={ShieldCheck} title="Could not load Work-Order Guard" onRetry={() => void load()} />
        ) : !active ? (
          <EmptyState icon={ShieldCheck} title="Set up your first portal" description="Start from the ServiceChannel defaults. You can edit every rule afterwards."
            action={{ label: creating ? 'Creating…' : 'Create ServiceChannel profile', onClick: () => { if (!creating) void createFirst(); } }} />
        ) : (
          <>
            {profiles.length > 1 && (
              <label className="block text-xs font-medium text-text-secondary">Portal profile
                <select value={active.id} onChange={(e) => { setActiveId(e.target.value); setStatus('loading'); void loadOrders(e.target.value); }}
                  className="focus-ring mt-1 block w-full max-w-xs rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary">
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Work-Order Guard sections">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                  className={`focus-ring min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-medium ${tab === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{t.label}</button>
              ))}
            </div>
            {tab === 'orders' && <OrdersPanel orders={orders} rules={active.rules} timezone={active.timezone} />}
            {tab === 'audit' && <AuditPanel saved={orders} rules={active.rules} timezone={active.timezone} />}
            {tab === 'import' && <ImportPanel profileId={active.id} timezone={active.timezone} onImported={() => { setStatus('loading'); void loadOrders(active.id); }} />}
            {tab === 'deposits' && <DepositsPanel ownerId={ownerId} profile={active} orders={orders} />}
            {tab === 'rules' && (
              <ProfilePanel key={active.id + active.timezone} profile={active} canDelete={profiles.length > 1}
                onSaved={(p) => setProfiles((xs) => xs.map((x) => (x.id === p.id ? p : x)))}
                onDeleted={() => { setActiveId(null); void load(); }} />
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
