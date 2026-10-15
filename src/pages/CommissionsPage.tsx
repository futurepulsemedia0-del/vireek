import { useState } from 'react';
import { Coins, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { LoadError, currentMonthRange, useLoader } from '@/components/commissions/shared';
import { OverviewTab } from '@/components/commissions/OverviewTab';
import { RulesTab } from '@/components/commissions/RulesTab';
import { OverridesTab } from '@/components/commissions/OverridesTab';
import { StatementsTab } from '@/components/commissions/StatementsTab';
import { useAuth } from '@/contexts/AuthContext';
import { fetchCommissionEmployees, fetchCommissionPlans, type CommissionEmployee, type CommissionPlan } from '@/lib/commissions';

type TabId = 'overview' | 'rules' | 'overrides' | 'statements';
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'rules', label: 'Rules & tiers' },
  { id: 'overrides', label: 'Job overrides' },
  { id: 'statements', label: 'Statements & payroll' },
];

export function CommissionsPage() {
  const { user, profile, isOwner, permissions } = useAuth();
  // Same gate as the SQL side (can_manage_commissions): owner or billing access.
  const canManage = isOwner || permissions.can_view_billing;
  const ownerId = profile?.role === 'owner' ? (user?.id ?? null) : ((profile as { account_owner_id?: string | null } | null)?.account_owner_id ?? user?.id ?? null);

  const [tab, setTab] = useState<TabId>('overview');
  const [range, setRange] = useState(currentMonthRange);

  const refs = useLoader<{ employees: CommissionEmployee[]; plans: CommissionPlan[] }>(
    async () => {
      if (!ownerId || !canManage) return { employees: [], plans: [] };
      const [employees, plans] = await Promise.all([fetchCommissionEmployees(), fetchCommissionPlans(ownerId)]);
      return { employees, plans };
    },
    [ownerId, canManage],
  );

  const header = (
    <header className="flex items-start gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Coins size={20} />
      </span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Commissions</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Pay technicians on collected revenue with tiered plans and per-job overrides, review every statement before it is approved, then pay through a Vireek pay run or export to your payroll provider.
        </p>
      </div>
    </header>
  );

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Commissions">
        <div className="mx-auto max-w-6xl space-y-6 px-1 py-4 sm:px-4">
          {header}
          <EmptyState icon={ShieldAlert} title="Commissions are restricted" description="Only account owners and team members with billing access can view or manage commissions. Ask your account owner to grant access." />
        </div>
      </DashboardLayout>
    );
  }

  const employees = refs.data?.employees ?? [];
  const plans = refs.data?.plans ?? [];

  return (
    <DashboardLayout activeLabel="Commissions">
      <div className="mx-auto max-w-6xl space-y-6 px-1 py-4 sm:px-4">
        {header}

        <div role="tablist" aria-label="Commission sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`commission-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`commission-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`focus-ring -mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`commission-panel-${tab}`} aria-labelledby={`commission-tab-${tab}`}>
          {!ownerId || (refs.loading && !refs.data) ? (
            <SkeletonCardList count={3} rows={2} />
          ) : refs.error && !refs.data ? (
            <LoadError message={refs.error} onRetry={refs.reload} />
          ) : tab === 'overview' ? (
            <OverviewTab ownerId={ownerId} employees={employees} range={range} onRangeChange={setRange} />
          ) : tab === 'rules' ? (
            <RulesTab plans={plans} employees={employees} loading={refs.loading && !refs.data} error={refs.error} onReload={refs.reload} />
          ) : tab === 'overrides' ? (
            <OverridesTab ownerId={ownerId} employees={employees} />
          ) : (
            <StatementsTab ownerId={ownerId} employees={employees} range={range} onRangeChange={setRange} />
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
