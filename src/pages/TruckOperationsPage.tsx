import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  ClipboardCheck,
  Gauge,
  PackageCheck,
  RefreshCw,
  Settings,
  ShieldAlert,
  Truck,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { TransferLineConfirm } from '@/components/technician/TransferLineConfirm';
import { TONE_CLASSES, type Tone } from '@/lib/truckStock';
import { formatCents, listInventoryParts, type InventoryPart } from '@/lib/inventory';
import {
  ALERT_TYPE_LABELS,
  AUDIT_STATUS_META,
  CONFIDENCE_LABELS,
  DEFAULT_TRUCK_OPS_SETTINGS,
  FORECAST_REASON_LABELS,
  SEVERITY_TONE,
  TRANSFER_STATUS_META,
  URGENCY_META,
  VARIANCE_KIND_LABELS,
  cancelTransfer,
  canComplete,
  canShip,
  completeTransfer,
  createTransfer,
  createTransfersFromForecast,
  describeStatus,
  describeVariance,
  forecastUrgency,
  getSettings,
  getVarianceSummary,
  groupForecastByTruck,
  isOk,
  listAlerts,
  listForecast,
  listLocations,
  listTransfers,
  listVanAudits,
  listVariance,
  opsErrorMessage,
  runTruckOpsScan,
  saveSettings,
  setAlertStatus,
  setVarianceStatus,
  shipTransfer,
  startVanAudit,
  transferProgress,
  validateSettings,
  type ForecastRow,
  type TransferOrder,
  type TransferStatus,
  type TruckAlert,
  type TruckOpsSettings,
  type VanAuditRow,
  type VarianceEvent,
  type VarianceSummaryRow,
} from '@/lib/truckOps';

const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const btnPrimary =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50';
const btnGhost =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50';

type TabKey = 'forecast' | 'transfers' | 'audits' | 'variance' | 'alerts' | 'settings';

const TABS: { key: TabKey; label: string; icon: typeof Truck }[] = [
  { key: 'forecast', label: 'Restock forecast', icon: Gauge },
  { key: 'transfers', label: 'Transfers', icon: ArrowRightLeft },
  { key: 'audits', label: 'Van audits', icon: ClipboardCheck },
  { key: 'variance', label: 'Shrinkage', icon: ShieldAlert },
  { key: 'alerts', label: 'Alerts', icon: Bell },
  { key: 'settings', label: 'Settings', icon: Settings },
];

function isTab(v: string | null): v is TabKey {
  return TABS.some((t) => t.key === v);
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>{children}</span>;
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: Tone }) {
  return (
    <div className={cardClass}>
      <p className={`text-2xl font-bold ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary'}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function Loading() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState icon={AlertTriangle} title="Couldn't load this section" description={message} action={{ label: 'Try again', onClick: onRetry }} />
  );
}

/** Small loader hook: one fetch, explicit reload, no stale state after unmount. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(opsErrorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

// ============================================================
// PAGE
// ============================================================

export function TruckOperationsPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = isTab(params.get('tab')) ? (params.get('tab') as TabKey) : 'forecast';
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_manage_team;
  const [scanning, setScanning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const alerts = useLoad(() => listAlerts(), [refreshKey]);
  const open = alerts.data ?? [];
  const critical = open.filter((a) => a.severity === 'critical' && a.status === 'open').length;

  const runScan = async () => {
    setScanning(true);
    try {
      const result = await runTruckOpsScan();
      if (isOk(result)) {
        toast(
          `Scan done: ${result.stockouts as number} out of stock, ${result.low_stock as number} low, ${result.jobs_at_risk as number} jobs at risk, ${result.variance_new as number} new variance flags.`,
          'success',
        );
        setRefreshKey((k) => k + 1);
      } else {
        toast(describeStatus(result), 'error');
      }
    } catch (err) {
      toast(opsErrorMessage(err), 'error');
    } finally {
      setScanning(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Truck Operations">
      <div className="mx-auto max-w-6xl space-y-5 px-0 py-2 sm:px-2">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Truck Operations</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Restock trucks before jobs run short, move stock with scan confirmation, audit vans and catch shrinkage early.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnGhost} onClick={() => setRefreshKey((k) => k + 1)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </button>
            <button type="button" className={btnPrimary} onClick={() => void runScan()} disabled={scanning}>
              <Bell className="h-4 w-4" aria-hidden /> {scanning ? 'Scanning…' : 'Run scan now'}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Critical alerts" value={critical} tone={critical ? 'danger' : undefined} />
          <Stat label="Open alerts" value={open.length} tone={open.length ? 'warning' : undefined} />
        </div>

        <div role="tablist" aria-label="Truck operations sections" className="flex flex-wrap gap-1.5">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setParams({ tab: key })}
              className={`focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
              {key === 'alerts' && open.length > 0 && <span className="ml-1 rounded-full bg-white/20 px-1.5 text-[10px]">{open.length}</span>}
            </button>
          ))}
        </div>

        <div role="tabpanel">
          {tab === 'forecast' && <ForecastTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
          {tab === 'transfers' && <TransfersTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
          {tab === 'audits' && <AuditsTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
          {tab === 'variance' && <VarianceTab refreshKey={refreshKey} canManage={canManage} onChanged={() => setRefreshKey((k) => k + 1)} />}
          {tab === 'alerts' && <AlertsTab alerts={alerts.data} loading={alerts.loading} error={alerts.error} onRetry={alerts.reload} onChanged={() => setRefreshKey((k) => k + 1)} />}
          {tab === 'settings' && <SettingsTab ownerId={ownerId ?? null} canManage={canManage} />}
        </div>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// FORECAST
// ============================================================

function ForecastTab({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const { toast } = useToast();
  const { data, error, loading, reload } = useLoad(listForecast, [refreshKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const groups = useMemo(() => groupForecastByTruck(data ?? []), [data]);

  const create = async (ids?: string[], key = 'all') => {
    setBusy(key);
    try {
      const result = await createTransfersFromForecast(ids);
      if (isOk(result)) {
        const n = result.transfers as number;
        toast(n > 0 ? `${n} transfer order(s) created — pick them in the Transfers tab.` : 'Nothing to create: the warehouse has no free stock for these parts.', n > 0 ? 'success' : 'info');
        onChanged();
        reload();
      } else {
        toast(describeStatus(result), 'error');
      }
    } catch (err) {
      toast(opsErrorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={PackageCheck}
        title="Every truck is stocked for what's coming"
        description="No truck is projected to fall below its minimum, or run short for a job scheduled in the forecast window. Set minimum/target levels per truck under Parts & Inventory."
      />
    );
  }
  const totalShortfall = groups.reduce((s, g) => s + g.totalShortfall, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">
          Based on each truck's minimum/target levels plus the parts upcoming jobs need (job part lists first, then the average used on past jobs of the same service).
        </p>
        <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => void create(undefined, 'all')}>
          <ArrowRightLeft className="h-4 w-4" aria-hidden /> {busy === 'all' ? 'Creating…' : 'Create transfers for all trucks'}
        </button>
      </div>

      {totalShortfall > 0 && (
        <p role="status" className="rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
          {totalShortfall} unit(s) can't be covered from your warehouses. Order them under{' '}
          <Link to="/dashboard/inventory" className="font-semibold underline">
            Parts &amp; Inventory
          </Link>
          .
        </p>
      )}

      {groups.map((g) => (
        <section key={g.location_id} className={cardClass} aria-label={g.location_name}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Truck className="h-4 w-4 text-text-secondary" aria-hidden />
              <h2 className="text-base font-semibold text-text-primary">{g.location_name}</h2>
              <Badge tone="neutral">{g.rows.length} part(s)</Badge>
            </div>
            <button type="button" className={btnGhost} disabled={busy !== null || g.totalFulfillable === 0} onClick={() => void create([g.location_id], g.location_id)}>
              {busy === g.location_id ? 'Creating…' : `Create transfer (${g.totalFulfillable} units, ${formatCents(g.valueCents)})`}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-text-secondary">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Part</th>
                  <th className="px-2 py-1.5 font-medium">Have</th>
                  <th className="px-2 py-1.5 font-medium">Min / target</th>
                  <th className="px-2 py-1.5 font-medium">Jobs need</th>
                  <th className="px-2 py-1.5 font-medium">On the way</th>
                  <th className="px-2 py-1.5 font-medium">After jobs</th>
                  <th className="px-2 py-1.5 font-medium">Restock</th>
                  <th className="px-2 py-1.5 font-medium">Warehouse</th>
                  <th className="py-1.5 pl-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <ForecastRowView key={r.part_id} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function ForecastRowView({ row: r }: { row: ForecastRow }) {
  const urgency = forecastUrgency(r);
  return (
    <tr className="border-t border-border align-top">
      <td className="py-2 pr-3">
        <p className="font-medium text-text-primary">{r.part_name}</p>
        {r.part_number && <p className="text-xs text-text-secondary">{r.part_number}</p>}
      </td>
      <td className="px-2 py-2">{r.available}</td>
      <td className="px-2 py-2 text-text-secondary">{r.min_quantity ?? '—'} / {r.target_quantity ?? '—'}</td>
      <td className="px-2 py-2" title={`${r.explicit_demand} from job part lists, ${r.statistical_demand} expected from history`}>
        {r.forecast_demand} <span className="text-xs text-text-secondary">({r.upcoming_jobs} job{r.upcoming_jobs === 1 ? '' : 's'})</span>
      </td>
      <td className="px-2 py-2">{r.inbound}</td>
      <td className={`px-2 py-2 font-medium ${r.projected < 0 ? 'text-danger' : 'text-text-primary'}`}>{r.projected}</td>
      <td className="px-2 py-2 font-semibold text-text-primary">+{r.suggested_qty}</td>
      <td className="px-2 py-2">
        {r.fulfillable_qty}
        {r.order_shortfall > 0 && <span className="ml-1 text-xs text-warning-500">(short {r.order_shortfall})</span>}
      </td>
      <td className="py-2 pl-2">
        <div className="flex flex-wrap gap-1">
          <Badge tone={URGENCY_META[urgency].tone}>{URGENCY_META[urgency].label}</Badge>
          <span className="text-xs text-text-secondary">{FORECAST_REASON_LABELS[r.reason]}</span>
        </div>
        {r.forecast_demand > 0 && <p className="mt-0.5 text-[11px] text-text-secondary">{CONFIDENCE_LABELS[r.confidence]}</p>}
      </td>
    </tr>
  );
}

// ============================================================
// TRANSFERS
// ============================================================

type TransferFilter = 'active' | 'completed' | 'cancelled';
const FILTER_STATUSES: Record<TransferFilter, TransferStatus[]> = {
  active: ['open', 'in_transit'],
  completed: ['completed'],
  cancelled: ['cancelled'],
};

function TransfersTab({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [filter, setFilter] = useState<TransferFilter>('active');
  const [showNew, setShowNew] = useState(false);
  const { data, error, loading, reload } = useLoad(() => listTransfers({ statuses: FILTER_STATUSES[filter] }), [filter, refreshKey]);
  const refresh = () => {
    reload();
    onChanged();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Filter transfers">
          {(['active', 'completed', 'cancelled'] as TransferFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium capitalize ${filter === f ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
            >
              {f}
            </button>
          ))}
        </div>
        <button type="button" className={btnPrimary} onClick={() => setShowNew((s) => !s)} aria-expanded={showNew}>
          {showNew ? 'Close' : 'New transfer'}
        </button>
      </div>

      {showNew && (
        <NewTransferForm
          onCreated={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          icon={ArrowRightLeft}
          title={filter === 'active' ? 'No transfers in progress' : `No ${filter} transfers`}
          description="Create transfers from the Restock forecast tab, or start one by hand."
        />
      ) : (
        <ul className="space-y-3">
          {(data ?? []).map((o) => (
            <TransferCard key={o.id} order={o} onChanged={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TransferCard({ order, onChanged }: { order: TransferOrder; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const progress = transferProgress(order);
  const meta = TRANSFER_STATUS_META[order.status];
  const stage = order.status === 'open' ? 'pick' : order.status === 'in_transit' ? 'receive' : null;

  const act = async (fn: () => Promise<{ status: string }>, okStatuses: string[], success: string) => {
    setBusy(true);
    try {
      const result = await fn();
      if (isOk(result, ...okStatuses)) {
        toast(success, 'success');
        onChanged();
      } else {
        toast(describeStatus(result), 'error');
      }
    } catch (err) {
      toast(opsErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            {order.transfer_number} <Badge tone={meta.tone}>{meta.label}</Badge>
            {order.has_variance && <span className="ml-1"><Badge tone="warning">Arrived short</Badge></span>}
          </p>
          <p className="text-xs text-text-secondary">
            {order.from_location?.name ?? 'Source'} → {order.to_location?.name ?? 'Destination'} · created {formatWhen(order.created_at)}
          </p>
        </div>
        <div className="text-right text-xs text-text-secondary">
          {order.status === 'open' && `${progress.confirmed}/${progress.lines} lines picked`}
          {order.status === 'in_transit' && `${progress.confirmed}/${progress.lines} lines received`}
          {order.status === 'completed' && `${progress.unitsReceived} of ${progress.unitsPicked} units received`}
          {order.status === 'cancelled' && (order.cancel_reason ?? 'Cancelled')}
        </div>
      </div>

      {stage ? (
        <ul className="mt-3 grid gap-2 md:grid-cols-2">
          {order.lines
            .filter((l) => (stage === 'receive' ? l.qty_picked > 0 : true))
            .map((l) => (
              <TransferLineConfirm key={`${l.id}-${stage}-${l.picked_at ?? ''}-${l.received_at ?? ''}`} line={l} stage={stage} onConfirmed={onChanged} />
            ))}
        </ul>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {order.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-3 text-text-secondary">
              <span className="truncate">{l.part?.name ?? 'Part'}</span>
              <span className={l.qty_received < l.qty_picked ? 'text-warning-500' : undefined}>
                {order.status === 'completed' ? `${l.qty_received}/${l.qty_picked}` : l.qty_planned}
              </span>
            </li>
          ))}
        </ul>
      )}

      {(order.status === 'open' || order.status === 'in_transit') && (
        <div className="mt-3 flex flex-wrap gap-2">
          {order.status === 'open' && (
            <button type="button" className={btnPrimary} disabled={busy || !canShip(order)} onClick={() => void act(() => shipTransfer(order.id), ['in_transit'], 'Shipped — stock left the source.')}>
              Ship ({progress.unitsPicked} units)
            </button>
          )}
          {order.status === 'in_transit' && (
            <button type="button" className={btnPrimary} disabled={busy || !canComplete(order)} onClick={() => void act(() => completeTransfer(order.id), ['completed'], 'Transfer received.')}>
              Complete receipt
            </button>
          )}
          <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirmCancel(true)}>
            Cancel transfer
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this transfer?"
        description={
          order.status === 'in_transit'
            ? 'The stock already left the source. Cancelling puts the shipped units back at the source.'
            : 'Nothing has left the source yet, so no stock changes.'
        }
        confirmLabel="Yes, cancel it"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={async () => {
          setConfirmCancel(false);
          await act(() => cancelTransfer(order.id, 'Cancelled from Truck Operations'), ['cancelled'], 'Transfer cancelled.');
        }}
      />
    </li>
  );
}

function NewTransferForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const { data: locations } = useLoad(listLocations, []);
  const { data: parts } = useLoad<InventoryPart[]>(() => listInventoryParts(true), []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<{ part_id: string; qty: string }[]>([{ part_id: '', qty: '1' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const lines = rows
      .filter((r) => r.part_id)
      .map((r) => ({ part_id: r.part_id, quantity: Number(r.qty) }));
    if (!from || !to || from === to) return setError('Choose two different locations.');
    if (lines.length === 0 || lines.some((l) => !Number.isInteger(l.quantity) || l.quantity <= 0)) {
      return setError('Add at least one part, each with a whole quantity above zero.');
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createTransfer({ fromLocationId: from, toLocationId: to, lines });
      if (isOk(result, 'created')) {
        toast(`Transfer ${result.transfer_number as string} created.`, 'success');
        onCreated();
      } else {
        setError(describeStatus(result));
      }
    } catch (err) {
      setError(opsErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${cardClass} space-y-3`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-text-secondary">
          From
          <select className={`${inputClass} mt-1`} value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Choose…</option>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.location_type})</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-text-secondary">
          To
          <select className={`${inputClass} mt-1`} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose…</option>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.location_type})</option>
            ))}
          </select>
        </label>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <select
            aria-label={`Part ${i + 1}`}
            className={inputClass}
            value={r.part_id}
            onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, part_id: e.target.value } : x)))}
          >
            <option value="">Choose a part…</option>
            {(parts ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.part_number ? ` (${p.part_number})` : ''}</option>
            ))}
          </select>
          <input
            aria-label={`Quantity ${i + 1}`}
            inputMode="numeric"
            className={`${inputClass} w-24`}
            value={r.qty}
            onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
          />
          {rows.length > 1 && (
            <button type="button" className={btnGhost} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
              Remove
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnGhost} disabled={rows.length >= 50} onClick={() => setRows((rs) => [...rs, { part_id: '', qty: '1' }])}>
          Add part
        </button>
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create transfer'}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

// ============================================================
// VAN AUDITS
// ============================================================

function AuditsTab({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const { toast } = useToast();
  const { data, error, loading, reload } = useLoad(listVanAudits, [refreshKey]);
  const [busy, setBusy] = useState<string | null>(null);

  const start = async (row: VanAuditRow) => {
    setBusy(row.location_id);
    try {
      const result = await startVanAudit(row.location_id);
      if (isOk(result, 'started', 'already_open')) {
        toast(result.status === 'started' ? 'Blind audit started. The technician counts on their phone; you approve it in Cycle Counts.' : 'An audit is already open for this truck.', 'success');
        onChanged();
        reload();
      } else {
        toast(describeStatus(result), 'error');
      }
    } catch (err) {
      toast(opsErrorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if ((data ?? []).length === 0) {
    return <EmptyState icon={ClipboardCheck} title="No trucks yet" description="Add a truck location and assign it to a technician under Parts & Inventory → Locations." />;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        Audits are blind counts: the technician counts what is on the truck without seeing the expected numbers. Approved differences are posted to the ledger and flagged as shrinkage.
      </p>
      <div className={`${cardClass} overflow-x-auto p-0`}>
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-text-secondary">
            <tr>
              <th className="px-4 py-2 font-medium">Truck</th>
              <th className="px-2 py-2 font-medium">Technician</th>
              <th className="px-2 py-2 font-medium">Last audit</th>
              <th className="px-2 py-2 font-medium">Accuracy</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((a) => {
              const meta = AUDIT_STATUS_META[a.audit_status];
              return (
                <tr key={a.location_id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium text-text-primary">{a.location_name}</td>
                  <td className="px-2 py-2">{a.technician_name ?? '—'}</td>
                  <td className="px-2 py-2">{a.last_audit_at ? formatWhen(a.last_audit_at) : 'Never'}</td>
                  <td className="px-2 py-2">{a.last_accuracy_pct === null ? '—' : `${Number(a.last_accuracy_pct)}%`}</td>
                  <td className="px-2 py-2">
                    <Badge tone={meta.tone}>{meta.label}{a.audit_status === 'overdue' && a.days_overdue > 0 ? ` · ${a.days_overdue}d` : ''}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {a.open_count_id ? (
                      <Link to={`/dashboard/inventory/counts?count=${a.open_count_id}`} className="text-xs font-semibold text-accent hover:underline">
                        Open count
                      </Link>
                    ) : (
                      <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => void start(a)}>
                        {busy === a.location_id ? 'Starting…' : 'Start audit'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// VARIANCE / SHRINKAGE
// ============================================================

function VarianceTab({ refreshKey, canManage, onChanged }: { refreshKey: number; canManage: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const summary = useLoad<VarianceSummaryRow[]>(() => getVarianceSummary(30), [refreshKey]);
  const events = useLoad<VarianceEvent[]>(() => listVariance(), [refreshKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});

  const update = async (id: string, status: 'acknowledged' | 'resolved' | 'dismissed') => {
    setBusy(id);
    try {
      const result = await setVarianceStatus(id, status, note[id]);
      if (isOk(result)) {
        onChanged();
        events.reload();
      } else {
        toast(describeStatus(result), 'error');
      }
    } catch (err) {
      toast(opsErrorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <section className={`${cardClass} overflow-x-auto p-0`} aria-label="Shrinkage by truck, last 30 days">
        <h2 className="px-4 pt-3 text-sm font-semibold text-text-primary">Last 30 days by truck</h2>
        {summary.loading && !summary.data ? (
          <div className="p-4"><Loading /></div>
        ) : summary.error ? (
          <div className="p-4"><ErrorBox message={summary.error} onRetry={summary.reload} /></div>
        ) : (
          <table className="mt-2 w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-text-secondary">
              <tr>
                <th className="px-4 py-2 font-medium">Truck</th>
                <th className="px-2 py-2 font-medium">Technician</th>
                <th className="px-2 py-2 font-medium">Used</th>
                <th className="px-2 py-2 font-medium">Lost</th>
                <th className="px-2 py-2 font-medium">Loss rate</th>
                <th className="px-2 py-2 font-medium">Open flags</th>
                <th className="px-4 py-2 font-medium">Last audit accuracy</th>
              </tr>
            </thead>
            <tbody>
              {(summary.data ?? []).map((r) => (
                <tr key={r.location_id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium text-text-primary">{r.location_name}</td>
                  <td className="px-2 py-2">{r.technician_name ?? '—'}</td>
                  <td className="px-2 py-2">{formatCents(r.usage_value_cents)}</td>
                  <td className="px-2 py-2">{formatCents(r.shrink_value_cents)}</td>
                  <td className="px-2 py-2">{r.shrink_rate_pct}%</td>
                  <td className="px-2 py-2">
                    {r.open_events > 0 ? <Badge tone={r.critical_events > 0 ? 'danger' : 'warning'}>{r.open_events}</Badge> : '—'}
                  </td>
                  <td className="px-4 py-2">{r.last_accuracy_pct === null ? '—' : `${r.last_accuracy_pct}%`}</td>
                </tr>
              ))}
              {(summary.data ?? []).length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-text-secondary">No trucks to report on yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Variance flags" className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Flags to review</h2>
        {events.loading && !events.data ? (
          <Loading />
        ) : events.error ? (
          <ErrorBox message={events.error} onRetry={events.reload} />
        ) : (events.data ?? []).length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No shrinkage flags" description="Flags appear after approved van audits, short transfers, negative stock and unusual usage." />
        ) : (
          <ul className="space-y-2">
            {(events.data ?? []).map((e) => (
              <li key={e.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary">
                      <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge> {VARIANCE_KIND_LABELS[e.kind]}
                      {e.part?.name ? ` · ${e.part.name}` : ''}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {e.location?.name ?? 'Unknown location'} · {formatWhen(e.detected_at)}
                      {e.quantity ? ` · ${e.quantity} unit(s)` : ''} · {formatCents(Number(e.value_cents))}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">{describeVariance(e)}</p>
                  </div>
                  {e.status === 'acknowledged' && <Badge tone="accent">Acknowledged</Badge>}
                </div>
                {canManage && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      aria-label="Note"
                      className={`${inputClass} max-w-xs`}
                      placeholder="Note (optional)"
                      maxLength={500}
                      value={note[e.id] ?? ''}
                      onChange={(ev) => setNote((n) => ({ ...n, [e.id]: ev.target.value }))}
                    />
                    {e.status === 'open' && (
                      <button type="button" className={btnGhost} disabled={busy === e.id} onClick={() => void update(e.id, 'acknowledged')}>Acknowledge</button>
                    )}
                    <button type="button" className={btnGhost} disabled={busy === e.id} onClick={() => void update(e.id, 'resolved')}>Resolve</button>
                    <button type="button" className={btnGhost} disabled={busy === e.id} onClick={() => void update(e.id, 'dismissed')}>Dismiss</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ============================================================
// ALERTS
// ============================================================

function AlertsTab({
  alerts,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  alerts: TruckAlert[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const update = async (id: string, status: 'acknowledged' | 'resolved') => {
    setBusy(id);
    try {
      const result = await setAlertStatus(id, status);
      if (isOk(result)) onChanged();
      else toast(describeStatus(result), 'error');
    } catch (err) {
      toast(opsErrorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !alerts) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={onRetry} />;
  if (!alerts || alerts.length === 0) {
    return <EmptyState icon={Bell} title="No open alerts" description="Low stock, stock-outs, jobs that will run short of parts and overdue audits show up here and in your notifications." />;
  }
  return (
    <ul className="space-y-2">
      {alerts.map((a) => (
        <li key={a.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">
              <Badge tone={SEVERITY_TONE[a.severity]}>{ALERT_TYPE_LABELS[a.alert_type]}</Badge>{' '}
              {a.status === 'acknowledged' && <Badge tone="accent">Acknowledged</Badge>}
            </p>
            <p className="mt-1 text-sm text-text-secondary">{a.message}</p>
            <p className="text-xs text-text-secondary">First seen {formatWhen(a.first_seen_at)}</p>
          </div>
          <div className="flex gap-2">
            {a.status === 'open' && (
              <button type="button" className={btnGhost} disabled={busy === a.id} onClick={() => void update(a.id, 'acknowledged')}>Acknowledge</button>
            )}
            <button type="button" className={btnGhost} disabled={busy === a.id} onClick={() => void update(a.id, 'resolved')}>Resolve</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// SETTINGS
// ============================================================

const SETTING_FIELDS: { key: keyof TruckOpsSettings; label: string; hint: string; step?: string }[] = [
  { key: 'forecast_horizon_days', label: 'Forecast window (days)', hint: 'How far ahead scheduled jobs count toward restocking.' },
  { key: 'history_days', label: 'History used (days)', hint: 'Past completed jobs used to estimate what each service type consumes.' },
  { key: 'safety_factor', label: 'Safety factor', hint: 'Multiplier on estimated (not job-listed) demand. 1.2 = 20% buffer.', step: '0.05' },
  { key: 'audit_interval_days', label: 'Van audit every (days)', hint: 'A truck becomes "overdue" after this long without an approved audit.' },
  { key: 'shrink_alert_pct', label: 'Loss-rate alert (%)', hint: 'Flag a truck when lost value is at least this share of what it used.', step: '0.5' },
  { key: 'alert_cooldown_hours', label: 'Re-alert critical after (hours)', hint: 'How often a still-open critical alert notifies dispatch again.' },
];

function SettingsTab({ ownerId, canManage }: { ownerId: string | null; canManage: boolean }) {
  const { toast } = useToast();
  const { data, error, loading, reload } = useLoad(getSettings, []);
  const [form, setForm] = useState<TruckOpsSettings>(DEFAULT_TRUCK_OPS_SETTINGS);
  const [minValue, setMinValue] = useState('20');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) {
      setForm(data);
      setMinValue(String(data.shrink_min_value_cents / 100));
    }
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const submit = async () => {
    const dollars = Number(minValue);
    const next: TruckOpsSettings = { ...form, shrink_min_value_cents: Number.isFinite(dollars) ? Math.round(dollars * 100) : Number.NaN };
    const found = validateSettings(next);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (!ownerId) return void toast("We couldn't find your account.", 'error');
    setBusy(true);
    try {
      await saveSettings(ownerId, next);
      toast('Settings saved.', 'success');
      reload();
    } catch (err) {
      toast(opsErrorMessage(err, 'Could not save settings. Only owners and admins can change them.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${cardClass} space-y-4`}>
      {!canManage && <p className="text-sm text-text-secondary">Only owners and admins can change these settings.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {SETTING_FIELDS.map((f) => (
          <label key={f.key} className="text-xs font-medium text-text-secondary">
            {f.label}
            <input
              type="number"
              step={f.step ?? '1'}
              disabled={!canManage}
              className={`${inputClass} mt-1`}
              value={Number.isNaN(form[f.key] as number) ? '' : String(form[f.key])}
              onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value === '' ? Number.NaN : Number(e.target.value) }))}
            />
            <span className="mt-1 block font-normal">{f.hint}</span>
            {errors[f.key] && <span role="alert" className="block text-danger">{errors[f.key]}</span>}
          </label>
        ))}
        <label className="text-xs font-medium text-text-secondary">
          Ignore losses under ($)
          <input type="number" step="1" min="0" disabled={!canManage} className={`${inputClass} mt-1`} value={minValue} onChange={(e) => setMinValue(e.target.value)} />
          <span className="mt-1 block font-normal">Smaller differences are recorded but not raised as warnings.</span>
          {errors.shrink_min_value_cents && <span role="alert" className="block text-danger">{errors.shrink_min_value_cents}</span>}
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" disabled={!canManage} checked={form.low_stock_alerts_enabled} onChange={(e) => setForm((s) => ({ ...s, low_stock_alerts_enabled: e.target.checked }))} />
        Alert dispatch the moment a truck drops to its minimum
      </label>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" disabled={!canManage} checked={form.require_scan} onChange={(e) => setForm((s) => ({ ...s, require_scan: e.target.checked }))} />
        Require a barcode scan (or a written reason) to confirm transfer lines
      </label>
      {canManage && (
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      )}
    </div>
  );
}
