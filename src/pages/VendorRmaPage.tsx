import { useMemo, useState } from 'react';
import { Download, Lock, PackageX, Plus } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { RmaDetailPanel } from '@/components/rma/RmaDetailPanel';
import { RmaFormPanel } from '@/components/rma/RmaFormPanel';
import { ErrorState, Pill, SelectField, Stat, formatDate, useLoader } from '@/components/vehicles/shared';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { exportToCsv } from '@/lib/csvExport';
import { formatMoney } from '@/lib/currency';
import {
  listInventoryLocations, listInventoryParts, listInventoryVendors,
  type InventoryLocation, type InventoryPart, type InventoryVendor,
} from '@/lib/inventory';
import { fetchRmas } from '@/lib/vendorRmaApi';
import {
  RMA_CSV_COLUMNS, RMA_STATUSES, REASON_LABELS, SHIP_STATUS_LABELS, STATUS_LABELS, STATUS_TONES, awaitingCredit, creditAgeDays,
  filterRmas, summarizeRmas, summarizeCredit, totalUnits, type Rma, type RmaStatusFilter,
} from '@/lib/vendorRma';

interface RmaData {
  rmas: Rma[];
  vendors: InventoryVendor[];
  parts: InventoryPart[];
  locations: InventoryLocation[];
}

const EMPTY: RmaData = { rmas: [], vendors: [], parts: [], locations: [] };

async function loadAll(): Promise<RmaData> {
  const [rmas, vendors, parts, locations] = await Promise.all([
    fetchRmas(), listInventoryVendors(false), listInventoryParts(false), listInventoryLocations(false),
  ]);
  return { rmas, vendors, parts, locations };
}

type Mode = { kind: 'none' } | { kind: 'view'; id: string } | { kind: 'new' } | { kind: 'edit'; id: string };

export function VendorRmaPage() {
  const { isOwner, permissions, profile, teamMember } = useAuth();
  const { currency } = useCurrency();
  const money = (cents: number) => formatMoney(cents / 100, currency);

  // Credits and stock movements: owners and managers only (the database enforces the same rule).
  const canAccess = isOwner || permissions.can_manage_team;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [status, setStatus] = useState<RmaStatusFilter>('active');
  const [vendorId, setVendorId] = useState('');
  const [query, setQuery] = useState('');

  const loader = useLoader(
    () => (canAccess && accountOwnerId ? loadAll() : Promise.resolve(EMPTY)),
    `${accountOwnerId ?? 'none'}:${canAccess}`,
  );
  const data = loader.data ?? EMPTY;

  const now = useMemo(() => new Date(), [loader.data]);
  const summary = useMemo(() => summarizeRmas(data.rmas, now), [data.rmas, now]);
  const visible = useMemo(() => filterRmas(data.rmas, { status, vendorId, query }), [data.rmas, status, vendorId, query]);
  const selected = mode.kind === 'view' || mode.kind === 'edit' ? data.rmas.find((r) => r.id === mode.id) ?? null : null;

  const refresh = async () => { await loader.reload(); };

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><PackageX size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Vendor Returns (RMA)</h1>
          <p className="text-sm text-text-secondary">Send parts back, track the shipment and the credit, and keep stock accurate.</p>
        </div>
      </div>
      {canAccess && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={visible.length === 0} onClick={() => exportToCsv(visible, RMA_CSV_COLUMNS, `vendor-returns-${new Date().toISOString().slice(0, 10)}.csv`)}>
            <Download size={16} /> Export
          </Button>
          <Button size="sm" onClick={() => setMode({ kind: 'new' })}><Plus size={16} /> New return</Button>
        </div>
      )}
    </div>
  );

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Vendor Returns">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Vendor returns move stock and money. Ask your account owner to grant you the "Manage Team" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  if (!accountOwnerId || (loader.loading && !loader.data)) {
    return (
      <DashboardLayout activeLabel="Vendor Returns">
        {header}
        <SkeletonStatGrid className="mb-6" />
        <SkeletonCardList count={4} rows={2} />
      </DashboardLayout>
    );
  }

  if (loader.error && !loader.data) {
    return <DashboardLayout activeLabel="Vendor Returns">{header}<ErrorState message={loader.error} onRetry={loader.reload} /></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Vendor Returns">
      {header}

      {loader.error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>Couldn't refresh: {loader.error}</span>
          <Button size="sm" variant="ghost" onClick={loader.reload}>Retry</Button>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open returns" value={summary.active} hint={`${summary.drafts} draft · ${summary.inTransit} in transit`} />
        <Stat label="Credit still owed" value={money(summary.outstandingCents)} tone={summary.overdue ? 'danger' : summary.outstandingCents ? 'warning' : 'neutral'} hint={`${summary.awaitingCredit} return(s) waiting on credit`} />
        <Stat label="Overdue credit" value={summary.overdue} tone={summary.overdue ? 'danger' : 'success'} hint="Over 30 days since the vendor got it" />
        <Stat label="Credit received" value={money(summary.receivedCents)} tone="success" hint="Across all returns" />
      </div>

      {mode.kind === 'new' || (mode.kind === 'edit' && selected) ? (
        <div className="mb-6">
          <RmaFormPanel
            key={mode.kind === 'edit' ? mode.id : 'new'}
            vendors={data.vendors}
            parts={data.parts}
            locations={data.locations}
            editing={mode.kind === 'edit' ? selected : null}
            onCancel={() => setMode(mode.kind === 'edit' ? { kind: 'view', id: mode.id } : { kind: 'none' })}
            onSaved={async (id) => { await refresh(); setMode({ kind: 'view', id }); }}
          />
        </div>
      ) : mode.kind === 'view' && selected ? (
        <div className="mb-6">
          <RmaDetailPanel
            key={selected.id}
            rma={selected}
            locations={data.locations}
            canManage={canAccess}
            onChanged={refresh}
            onEdit={() => setMode({ kind: 'edit', id: selected.id })}
            onClose={() => setMode({ kind: 'none' })}
          />
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as RmaStatusFilter)}>
          <option value="active">Open</option>
          <option value="all">All</option>
          {RMA_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </SelectField>
        <SelectField label="Vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          <option value="">All vendors</option>
          {data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </SelectField>
        <Input label="Search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="RMA #, part, tracking, PO…" />
      </div>

      {data.rmas.length === 0 ? (
        <EmptyState
          icon={PackageX}
          title="No vendor returns yet"
          description="When a part arrives defective, wrong or damaged, create a return here to track the RMA, the shipment and the credit."
          action={{ label: 'New return', onClick: () => setMode({ kind: 'new' }) }}
        />
      ) : visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-secondary">No returns match these filters.</p>
      ) : (
        <ul className="space-y-2" aria-label="Vendor returns">
          {visible.map((r) => {
            const credit = summarizeCredit(r.credit_expected_cents, r.credit_received_cents, r.resolution);
            const age = awaitingCredit(r) ? creditAgeDays(r, now) : null;
            const active = mode.kind !== 'none' && mode.kind !== 'new' && mode.id === r.id;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setMode({ kind: 'view', id: r.id })}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? 'border-accent' : 'border-border'}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text-primary">{r.rma_number}</span>
                      <Pill tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Pill>
                      {r.ship_status === 'exception' && <Pill tone="danger">{SHIP_STATUS_LABELS.exception}</Pill>}
                      {age != null && age > 30 && <Pill tone="danger">{age} days waiting</Pill>}
                    </div>
                    <p className="mt-1 truncate text-sm text-text-secondary">
                      {r.vendor?.name ?? 'Vendor'} · {REASON_LABELS[r.reason_code]} · {totalUnits(r.lines)} unit(s)
                      {r.vendor_rma_number ? ` · ${r.vendor_rma_number}` : ''}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-medium text-text-primary">
                      {r.resolution === 'replacement' ? 'Replacement' : `${money(credit.received)} / ${money(credit.expected)}`}
                    </p>
                    <p className="text-xs text-text-secondary">{formatDate(r.created_at.slice(0, 10))}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardLayout>
  );
}
