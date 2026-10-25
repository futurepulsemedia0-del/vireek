import { useMemo, useState } from 'react';
import { CreditCard, Lock, Upload } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { FuelAnomaliesTab } from '@/components/fuel/FuelAnomaliesTab';
import { FuelCardsTab } from '@/components/fuel/FuelCardsTab';
import { FuelImportPanel } from '@/components/fuel/FuelImportPanel';
import { FuelSettingsPanel } from '@/components/fuel/FuelSettingsPanel';
import { FuelTransactionsTab } from '@/components/fuel/FuelTransactionsTab';
import { ErrorState, SelectField, Stat, useLoader } from '@/components/vehicles/shared';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import { fetchFuelOverview, type FuelOverview } from '@/lib/fuelCardsApi';
import { formatGallons, summarizeAnomalies, summarizeTransactions } from '@/lib/fuelCards';

const EMPTY: FuelOverview = { cards: [], settings: null, vehicles: [], technicians: [], transactions: [], anomalies: [], imports: [] };

const TABS = [
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'cards', label: 'Cards' },
  { id: 'import', label: 'Import' },
  { id: 'settings', label: 'Settings' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const RANGES = [30, 90, 365] as const;

export function FuelCardsPage() {
  const { isOwner, permissions, profile, teamMember } = useAuth();
  const { currency } = useCurrency();

  // Fuel cards expose spend and driver behaviour: owners and team managers only (same gate as Vehicles).
  const canAccess = isOwner || permissions.can_manage_team;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [tab, setTab] = useState<TabId>('anomalies');
  const [days, setDays] = useState<number>(30);

  const overview = useLoader(
    () => (canAccess && accountOwnerId ? fetchFuelOverview(days) : Promise.resolve(EMPTY)),
    `${accountOwnerId ?? 'none'}:${canAccess}:${days}`,
  );
  const data = overview.data ?? EMPTY;
  const money = (n: number) => formatMoney(n, currency);

  const txSummary = useMemo(() => summarizeTransactions(data.transactions), [data.transactions]);
  const anSummary = useMemo(() => summarizeAnomalies(data.anomalies), [data.anomalies]);
  const unknownLast4 = useMemo(
    () => [...new Set(data.transactions.filter((t) => !t.card_id && t.card_last4).map((t) => t.card_last4 as string))].sort(),
    [data.transactions],
  );

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length];
    setTab(target.id);
    document.getElementById(`fuel-tab-${target.id}`)?.focus();
  };

  // --- Permission gate -------------------------------------------------------
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Fuel Cards">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Fuel cards are restricted. Ask your account owner to grant you the "Manage Team" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><CreditCard size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Fuel Cards</h1>
          <p className="text-sm text-text-secondary">Import transactions, match them to vehicles and drivers, and catch misuse early.</p>
        </div>
      </div>
      <Button size="sm" onClick={() => setTab('import')}><Upload size={16} /> Import transactions</Button>
    </div>
  );

  // --- Loading / error -------------------------------------------------------
  if (!accountOwnerId || (overview.loading && !overview.data)) {
    return (
      <DashboardLayout activeLabel="Fuel Cards">
        {header}
        <SkeletonStatGrid className="mb-6" />
        <SkeletonCardList count={4} rows={2} />
      </DashboardLayout>
    );
  }
  if (overview.error && !overview.data) {
    return <DashboardLayout activeLabel="Fuel Cards">{header}<ErrorState message={overview.error} onRetry={overview.reload} /></DashboardLayout>;
  }

  const reload = () => overview.reload();

  return (
    <DashboardLayout activeLabel="Fuel Cards">
      {header}

      {overview.error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>Couldn't refresh: {overview.error}</span>
          <Button size="sm" variant="ghost" onClick={overview.reload}>Retry</Button>
        </div>
      )}

      <div className="mb-3 max-w-xs">
        <SelectField label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((r) => <option key={r} value={r}>Last {r} days</option>)}
        </SelectField>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Fuel spend" value={money(txSummary.spend)} hint={`${txSummary.count.toLocaleString()} purchases · ${formatGallons(txSummary.gallons)}`} />
        <Stat label="Avg price" value={txSummary.avgPrice == null ? '—' : `${money(txSummary.avgPrice)}/gal`} hint="Across fuel purchases" />
        <Stat label="Open anomalies" value={anSummary.open} tone={anSummary.critical ? 'danger' : anSummary.open ? 'warning' : 'success'} hint={`${anSummary.critical} critical · ${anSummary.warning} warnings`} />
        <Stat label="Matched to a vehicle" value={txSummary.matchRate == null ? '—' : `${txSummary.matchRate}%`} tone={txSummary.matchRate != null && txSummary.matchRate < 90 ? 'warning' : 'neutral'} hint={`${data.cards.length} cards registered`} />
      </div>

      <div role="tablist" aria-label="Fuel card sections" onKeyDown={onTabKey} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`fuel-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`fuel-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`focus-ring -mb-px min-h-[44px] whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
            {t.id === 'anomalies' && anSummary.open > 0 && <span className="ms-1.5 rounded-full bg-danger/10 px-1.5 py-0.5 text-xs text-danger">{anSummary.open}</span>}
          </button>
        ))}
      </div>

      <div id={`fuel-panel-${tab}`} role="tabpanel" aria-labelledby={`fuel-tab-${tab}`}>
        {tab === 'anomalies' && <FuelAnomaliesTab anomalies={data.anomalies} vehicles={data.vehicles} onChanged={reload} />}
        {tab === 'transactions' && <FuelTransactionsTab transactions={data.transactions} anomalies={data.anomalies} vehicles={data.vehicles} days={days} onImport={() => setTab('import')} />}
        {tab === 'cards' && <FuelCardsTab cards={data.cards} vehicles={data.vehicles} technicians={data.technicians} unknownLast4={unknownLast4} onChanged={reload} />}
        {tab === 'import' && <FuelImportPanel cards={data.cards} imports={data.imports} onImported={reload} onViewAnomalies={() => setTab('anomalies')} />}
        {tab === 'settings' && <FuelSettingsPanel settings={data.settings} onChanged={reload} />}
      </div>
    </DashboardLayout>
  );
}
