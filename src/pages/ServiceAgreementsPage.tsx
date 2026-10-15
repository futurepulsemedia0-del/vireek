import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Coins, FileCheck2, FileWarning, Gauge, HeartPulse, RefreshCcw, Search } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Input } from '@/components/ui/Input';
import { CONTRACT_STATUS_COLORS, CONTRACT_STATUS_LABELS } from '@/lib/contracts';
import {
  AgreementDataError,
  HEALTH_LABELS,
  HEALTH_STYLES,
  formatDate,
  formatMoney,
  loadPortfolio,
  portfolioKpis,
  type PortfolioRow,
} from '@/lib/serviceAgreement';
import { Pill, StatTile } from '@/components/agreements/AgreementUi';

type Filter = 'all' | 'attention' | 'renewals' | 'unhealthy';

const RISK_ORDER = { lapsed: 0, urgent: 1, watch: 2, none: 3, secured: 4 } as const;

export function ServiceAgreementsPage() {
  const { isOwner, permissions } = useAuth();
  const canSeeMoney = isOwner || permissions.can_view_billing;

  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await loadPortfolio();
      setRows(p.rows);
      setMigrationMissing(p.migrationMissing);
    } catch (e) {
      setError(e instanceof AgreementDataError ? e.message : 'Could not load agreements.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kpis = useMemo(() => portfolioKpis(rows), [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (q && !`${r.contract.contract_name} ${r.customerName} ${r.contract.contract_number ?? ''}`.toLowerCase().includes(q)) return false;
        if (filter === 'attention') return r.unresolvedBreaches > 0 || r.overduePm > 0 || r.openClaims > 0;
        if (filter === 'renewals') return r.renewalState.risk === 'urgent' || r.renewalState.risk === 'lapsed' || r.renewalState.risk === 'watch';
        if (filter === 'unhealthy') return r.health.grade === 'at_risk' || r.health.grade === 'critical';
        return true;
      })
      .sort((a, b) => a.health.score - b.health.score || RISK_ORDER[a.renewalState.risk] - RISK_ORDER[b.renewalState.risk]);
  }, [rows, filter, query]);

  return (
    <DashboardLayout activeLabel="Service Agreements">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <FileCheck2 size={24} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Service Agreements</h1>
          <p className="text-sm text-text-secondary">Every agreement’s coverage, SLA, maintenance, pricing, renewal, claims and profit in one place.</p>
        </div>
        <Link to="/dashboard/contracts" className="focus-ring ml-auto shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          Commercial Contracts →
        </Link>
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={4} rows={2} />
        </div>
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Couldn’t load agreements" description={error} action={{ label: 'Try again', onClick: () => void load() }} />
      ) : migrationMissing ? (
        <EmptyState icon={AlertTriangle} title="One database update is pending" description="Apply the Service Agreement OS migration (20270410000000_service_agreement_os.sql), then reload this page." />
      ) : rows.length === 0 ? (
        <EmptyState icon={FileCheck2} title="No agreements yet" description="Create a commercial contract first — it becomes a full agreement view here." action={{ label: 'Open Commercial Contracts', onClick: () => window.location.assign('/dashboard/contracts') }} />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
            <StatTile label="Live agreements" value={kpis.live} icon={FileCheck2} />
            {canSeeMoney && <StatTile label="Annual recurring value" value={formatMoney(kpis.annualRecurringCents)} icon={Coins} tone="text-success-500" />}
            <StatTile label="Renewals at risk" value={kpis.atRiskRenewals} icon={RefreshCcw} tone={kpis.atRiskRenewals ? 'text-warning-500' : 'text-success-500'} />
            <StatTile label="Unresolved SLA breaches" value={kpis.unresolvedBreaches} icon={Gauge} tone={kpis.unresolvedBreaches ? 'text-danger' : 'text-success-500'} />
            <StatTile label="Overdue maintenance" value={kpis.overduePm} icon={CalendarClock} tone={kpis.overduePm ? 'text-warning-500' : 'text-success-500'} />
            <StatTile label="Average health" value={kpis.avgHealth ?? '—'} icon={HeartPulse} />
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-72">
              <Input icon={Search} placeholder="Search agreement or customer" aria-label="Search agreements" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1 sm:ml-auto" role="group" aria-label="Filter agreements">
              {([['all', `All (${rows.length})`], ['attention', 'Needs attention'], ['renewals', 'Renewals'], ['unhealthy', 'At risk']] as [Filter, string][]).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${filter === key ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState icon={FileWarning} title="Nothing matches" description="Try a different filter or search term." />
          ) : (
            <ul className="space-y-3">
              {visible.map((r) => (
                <li key={r.contract.id}>
                  <Link to={`/dashboard/agreements/${r.contract.id}`} className="focus-ring block rounded-xl border border-border bg-bg-secondary p-4 transition-colors hover:border-accent/40">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary">{r.contract.contract_name}</p>
                      <Pill className={CONTRACT_STATUS_COLORS[r.contract.status]}>{CONTRACT_STATUS_LABELS[r.contract.status]}</Pill>
                      <Pill className={HEALTH_STYLES[r.health.grade]}>
                        {HEALTH_LABELS[r.health.grade]} · {r.health.score}
                      </Pill>
                    </div>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      {r.customerName} · {formatDate(r.contract.start_date)} → {r.contract.end_date ? formatDate(r.contract.end_date) : 'open-ended'}
                      {canSeeMoney && r.annualValueCents !== null ? ` · ${formatMoney(r.annualValueCents)}/yr` : ''}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
                      <span>{r.assetCount} covered asset{r.assetCount === 1 ? '' : 's'}</span>
                      <span className={r.overduePm ? 'font-medium text-warning-500' : ''}>{r.activePm} PM plan{r.activePm === 1 ? '' : 's'}{r.overduePm ? `, ${r.overduePm} overdue` : ''}</span>
                      <span className={r.unresolvedBreaches ? 'font-medium text-danger' : ''}>{r.unresolvedBreaches} open breach{r.unresolvedBreaches === 1 ? '' : 'es'}</span>
                      <span className={r.openClaims ? 'font-medium text-warning-500' : ''}>{r.openClaims} open claim{r.openClaims === 1 ? '' : 's'}</span>
                      <span className={r.renewalState.risk === 'urgent' || r.renewalState.risk === 'lapsed' ? 'font-medium text-warning-500' : ''}>{r.renewalState.headline}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </DashboardLayout>
  );
}
