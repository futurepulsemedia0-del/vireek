import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, FileCheck2, FileX } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { CONTRACT_STATUS_COLORS, CONTRACT_STATUS_LABELS } from '@/lib/contracts';
import { AgreementDataError, HEALTH_LABELS, HEALTH_STYLES, deriveAgreement, loadAgreement360, type Agreement360, type AgreementTab } from '@/lib/serviceAgreement';
import { Pill, type TabProps } from '@/components/agreements/AgreementUi';
import { OverviewTab } from '@/components/agreements/OverviewTab';
import { CoverageTab } from '@/components/agreements/CoverageTab';
import { SlaTab } from '@/components/agreements/SlaTab';
import { MaintenanceTab } from '@/components/agreements/MaintenanceTab';
import { VisitsTab } from '@/components/agreements/VisitsTab';
import { PricingTab } from '@/components/agreements/PricingTab';
import { RenewalTab } from '@/components/agreements/RenewalTab';
import { ClaimsTab } from '@/components/agreements/ClaimsTab';
import { ProfitabilityTab } from '@/components/agreements/ProfitabilityTab';

const TABS: { key: AgreementTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'sla', label: 'SLA' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'visits', label: 'Visits' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'renewal', label: 'Renewal' },
  { key: 'claims', label: 'Claims' },
  { key: 'profitability', label: 'Profitability' },
];
const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

const TAB_COMPONENTS: Record<AgreementTab, (p: TabProps) => JSX.Element> = {
  overview: OverviewTab,
  coverage: CoverageTab,
  sla: SlaTab,
  maintenance: MaintenanceTab,
  visits: VisitsTab,
  pricing: PricingTab,
  renewal: RenewalTab,
  claims: ClaimsTab,
  profitability: ProfitabilityTab,
};

export function ServiceAgreementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, teamMember, isOwner, permissions } = useAuth();
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState<Agreement360 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const requestId = useRef(0);

  const canSeeMoney = isOwner || permissions.can_view_billing;
  const canManage = canSeeMoney;
  // RLS keys every row to the ACCOUNT OWNER, so a team member must write with the owner's id.
  const ownerId = teamMember?.account_owner_id ?? user?.id ?? '';

  const rawTab = params.get('tab') ?? 'overview';
  const tab: AgreementTab = TAB_KEYS.has(rawTab) ? (rawTab as AgreementTab) : 'overview';

  const load = useCallback(
    async (silent: boolean) => {
      if (!id) return;
      const mine = ++requestId.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const d = await loadAgreement360(id);
        if (mine !== requestId.current) return; // a newer load superseded this one
        setNotFound(d === null);
        setData(d);
      } catch (e) {
        if (mine !== requestId.current) return;
        setError(e instanceof AgreementDataError ? e.message : 'Could not load this agreement.');
      } finally {
        if (mine === requestId.current) setLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    setData(null);
    setNotFound(false);
    void load(false);
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  const derived = useMemo(() => (data ? deriveAgreement(data) : null), [data]);

  const goTab = useCallback(
    (t: AgreementTab) => {
      const next = new URLSearchParams(params);
      if (t === 'overview') next.delete('tab');
      else next.set('tab', t);
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const TabBody = TAB_COMPONENTS[tab];

  return (
    <DashboardLayout activeLabel="Service Agreements">
      <Link to="/dashboard/agreements" className="focus-ring mb-3 inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} aria-hidden="true" /> All agreements
      </Link>

      {loading && !data ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={2} />
        </div>
      ) : error && !data ? (
        <EmptyState icon={AlertTriangle} title="Couldn’t load this agreement" description={error} action={{ label: 'Try again', onClick: () => void load(false) }} />
      ) : notFound || !data || !derived ? (
        <EmptyState icon={FileX} title="Agreement not found" description="It may have been deleted, or it belongs to another account." />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <FileCheck2 size={24} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-bold text-text-primary">{data.contract.contract_name}</h1>
              <p className="text-sm text-text-secondary">
                {data.customer?.name ?? 'No customer linked'}
                {data.contract.contract_number ? ` · #${data.contract.contract_number}` : ''}
              </p>
            </div>
            <Pill className={CONTRACT_STATUS_COLORS[data.contract.status]}>{CONTRACT_STATUS_LABELS[data.contract.status]}</Pill>
            <Pill className={HEALTH_STYLES[derived.health.grade]}>
              {HEALTH_LABELS[derived.health.grade]} · {derived.health.score}
            </Pill>
          </div>

          {error && <p className="mb-4 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-warning-500" role="alert">{error}</p>}

          <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border pb-px" role="tablist" aria-label="Agreement sections">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`agreement-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls="agreement-tabpanel"
                onClick={() => goTab(t.key)}
                className={`focus-ring -mb-px shrink-0 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div id="agreement-tabpanel" role="tabpanel" aria-labelledby={`agreement-tab-${tab}`}>
            <TabBody data={data} derived={derived} canManage={canManage} canSeeMoney={canSeeMoney} ownerId={ownerId} reload={reload} goTab={goTab} />
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
