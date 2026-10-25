import { useMemo, useState } from 'react';
import { Receipt, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import type { FuelVehicle } from '@/lib/fuelCardsApi';
import { ANOMALY_META, formatGallons, humanize, maskCard, type FuelAnomaly, type FuelTransaction } from '@/lib/fuelCards';
import { Pill, SelectField, formatDateTime } from '@/components/vehicles/shared';

type Filter = 'all' | 'flagged' | 'unmatched';
const PAGE = 100;

interface Props {
  transactions: FuelTransaction[];
  anomalies: FuelAnomaly[];
  vehicles: FuelVehicle[];
  days: number;
  onImport: () => void;
}

export function FuelTransactionsTab({ transactions, anomalies, vehicles, days, onImport }: Props) {
  const { currency } = useCurrency();
  const money = (n: number) => formatMoney(n, currency);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE);

  const vehicleNames = useMemo(() => new Map(vehicles.map((v) => [v.id, v.label])), [vehicles]);
  const openByTxn = useMemo(() => {
    const m = new Map<string, FuelAnomaly[]>();
    for (const a of anomalies) if (a.status === 'open') m.set(a.transaction_id, [...(m.get(a.transaction_id) ?? []), a]);
    return m;
  }, [anomalies]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (filter === 'flagged' && !openByTxn.has(t.id)) return false;
      if (filter === 'unmatched' && t.vehicle_id) return false;
      if (!q) return true;
      const vehicle = t.vehicle_id ? vehicleNames.get(t.vehicle_id) : null;
      return [t.merchant, t.city, t.card_last4, t.plate, vehicle, t.technician_name].some((x) => x?.toLowerCase().includes(q));
    });
  }, [transactions, filter, search, openByTxn, vehicleNames]);

  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title={`No transactions in the last ${days} days`}
        description="Import a CSV export from your fuel card provider to see every purchase matched to a vehicle and driver."
        action={{ label: 'Import transactions', onClick: onImport }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Search" icon={Search} placeholder="Station, card, vehicle or driver" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }} />
        <SelectField label="Show" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setLimit(PAGE); }}>
          <option value="all">All transactions</option>
          <option value="flagged">With open anomalies</option>
          <option value="unmatched">No vehicle matched</option>
        </SelectField>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Search} title="No transactions match" description="Try a different search or filter." action={{ label: 'Clear filters', onClick: () => { setSearch(''); setFilter('all'); } }} />
      ) : (
        <>
          <ul className="space-y-2" aria-label="Fuel transactions">
            {visible.slice(0, limit).map((t) => {
              const flags = openByTxn.get(t.id) ?? [];
              const vehicle = t.vehicle_id ? vehicleNames.get(t.vehicle_id) : null;
              return (
                <li key={t.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">{t.merchant ?? 'Unknown station'}</p>
                      <p className="truncate text-xs text-text-secondary">
                        {[formatDateTime(t.transaction_at), [t.city, t.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="text-sm font-bold text-text-primary">{money(t.amount)}</p>
                      <p className="text-xs text-text-secondary">{t.gallons > 0 ? `${formatGallons(t.gallons)}${t.unit_price ? ` · ${money(t.unit_price)}/gal` : ''}` : humanize(t.product)}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                    <span>{maskCard(t.card_last4)}</span>
                    <span>{vehicle ?? 'No vehicle'}</span>
                    <span>{t.technician_name ?? 'No driver'}</span>
                    {t.gallons > 0 && <span>{humanize(t.product)}</span>}
                  </div>
                  {flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {flags.map((a) => <Pill key={a.id} tone={a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'info'}>{ANOMALY_META[a.rule].label}</Pill>)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {visible.length > limit && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE)}>Show more ({visible.length - limit} left)</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
