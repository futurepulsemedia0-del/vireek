import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Package,
  Warehouse,
  ArrowLeftRight,
  Truck,
  Building2,
  Barcode,
  Hash,
  RotateCcw,
  TrendingUp,
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  AlertTriangle,
  MapPin,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { supabase } from '@/lib/supabase';
import {
  InventoryPart,
  InventoryLocation,
  PartsAvailabilityRow,
  LowStockAlert,
  JobReadinessSummary,
  InventoryBinLocation,
  InventoryVendor,
  PartVendorCatalogEntry,
  PurchaseOrderSummaryRow,
  InventoryPurchaseOrderLine,
  PartSubstitute,
  InventorySerial,
  InventoryReservation,
  InventoryReturn,
  OpenCoreReturnRow,
  InventoryForecastRow,
  LocationType,
  TransactionType,
  ReturnType,
  LOCATION_TYPE_LABELS,
  TRANSACTION_TYPE_LABELS,
  STOCKOUT_RISK_LABELS,
  STOCKOUT_RISK_COLORS,
  PURCHASE_ORDER_STATUS_LABELS,
  SERIAL_STATUS_LABELS,
  RESERVATION_STATUS_LABELS,
  RETURN_TYPE_LABELS,
  RETURN_STATUS_LABELS,
  DEMAND_TREND_LABELS,
  formatCents,
  listInventoryParts,
  listInventoryLocations,
  upsertInventoryPart,
  listPartsAvailability,
  listLowStockAlerts,
  listJobReadinessSummary,
  recordInventoryTransaction,
  listBinLocations,
  upsertBinLocation,
  listInventoryVendors,
  upsertInventoryVendor,
  listPartVendorCatalog,
  upsertPartVendorCatalogEntry,
  findPartByBarcode,
  listPurchaseOrders,
  getPurchaseOrderLines,
  createPurchaseOrder,
  addPurchaseOrderLine,
  submitPurchaseOrder,
  cancelPurchaseOrder,
  receivePurchaseOrderLine,
  listPartSubstitutes,
  addPartSubstitute,
  removePartSubstitute,
  listInventorySerials,
  registerInventorySerial,
  updateSerialStatus,
  listInventoryReservations,
  createInventoryReservation,
  releaseInventoryReservation,
  fulfillInventoryReservation,
  listInventoryReturns,
  listOpenCoreReturns,
  createInventoryReturn,
  resolveInventoryReturn,
  listInventoryForecast,
  transferInventoryStock,
} from '@/lib/inventory';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';
const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const btnPrimary =
  'focus-ring flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50';
const btnGhost =
  'focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent';

type TabKey = 'overview' | 'parts' | 'locations' | 'stock' | 'vendors' | 'purchase_orders' | 'serials' | 'reservations' | 'returns';

const TABS: { key: TabKey; label: string; icon: typeof Package }[] = [
  { key: 'overview', label: 'Overview', icon: TrendingUp },
  { key: 'parts', label: 'Parts', icon: Package },
  { key: 'locations', label: 'Locations & Bins', icon: Warehouse },
  { key: 'stock', label: 'Stock & Transfers', icon: ArrowLeftRight },
  { key: 'vendors', label: 'Vendors', icon: Building2 },
  { key: 'purchase_orders', label: 'Purchase Orders', icon: Truck },
  { key: 'serials', label: 'Serials & Lots', icon: Hash },
  { key: 'reservations', label: 'Reservations', icon: Barcode },
  { key: 'returns', label: 'Returns', icon: RotateCcw },
];

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={cardClass}>
      <p className="text-xl font-bold" style={tone ? { color: tone } : undefined}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

function RiskBadge({ risk }: { risk: keyof typeof STOCKOUT_RISK_LABELS }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: `${STOCKOUT_RISK_COLORS[risk]}20`, color: STOCKOUT_RISK_COLORS[risk] }}
    >
      {STOCKOUT_RISK_LABELS[risk]}
    </span>
  );
}

function StatusPill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const colors: Record<string, string> = {
    neutral: 'bg-bg-tertiary text-text-secondary',
    good: 'bg-success/10 text-success',
    warn: 'bg-warning/10 text-warning',
    bad: 'bg-danger/10 text-danger',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${colors[tone]}`}>{text}</span>;
}

// ============================================================
// MAIN PAGE
// ============================================================

export function InventoryPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // Reference data shared across tabs
  const [parts, setParts] = useState<InventoryPart[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [vendors, setVendors] = useState<InventoryVendor[]>([]);
  const [refLoading, setRefLoading] = useState(true);

  const loadReferenceData = useCallback(async () => {
    setRefLoading(true);
    try {
      const [p, l, v] = await Promise.all([listInventoryParts(), listInventoryLocations(), listInventoryVendors()]);
      setParts(p);
      setLocations(l);
      setVendors(v);
    } catch {
      toast('Could not load your parts catalog', 'error');
    } finally {
      setRefLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) loadReferenceData();
  }, [user, loadReferenceData]);

  const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);
  const locationsById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const vendorsById = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);

  return (
    <DashboardLayout activeLabel="Parts & Inventory">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Package size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Parts & Inventory</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Multi-location stock, purchase orders, serial/lot tracking, and job-readiness — all in one place.
            </p>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap gap-1.5 border-b border-border pb-3">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`focus-ring flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                }`}
              >
                <Icon size={13} /> {tab.label}
              </button>
            );
          })}
        </div>

        {refLoading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            {activeTab === 'overview' && <OverviewTab parts={parts} locations={locations} />}
            {activeTab === 'parts' && (
              <PartsTab parts={parts} vendors={vendors} onChanged={loadReferenceData} toast={toast} />
            )}
            {activeTab === 'locations' && (
              <LocationsTab locations={locations} onChanged={loadReferenceData} toast={toast} />
            )}
            {activeTab === 'stock' && (
              <StockTab parts={parts} locations={locations} toast={toast} />
            )}
            {activeTab === 'vendors' && (
              <VendorsTab
                vendors={vendors}
                parts={parts}
                onChanged={loadReferenceData}
                toast={toast}
              />
            )}
            {activeTab === 'purchase_orders' && (
              <PurchaseOrdersTab vendors={vendors} parts={parts} locations={locations} toast={toast} />
            )}
            {activeTab === 'serials' && (
              <SerialsTab parts={parts} locations={locations} partsById={partsById} toast={toast} />
            )}
            {activeTab === 'reservations' && (
              <ReservationsTab parts={parts} locations={locations} partsById={partsById} toast={toast} />
            )}
            {activeTab === 'returns' && (
              <ReturnsTab
                parts={parts}
                locations={locations}
                vendors={vendors}
                partsById={partsById}
                vendorsById={vendorsById}
                toast={toast}
              />
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// OVERVIEW
// ============================================================

function OverviewTab({ parts, locations }: { parts: InventoryPart[]; locations: InventoryLocation[] }) {
  const [alerts, setAlerts] = useState<LowStockAlert[]>([]);
  const [readiness, setReadiness] = useState<JobReadinessSummary[]>([]);
  const [forecast, setForecast] = useState<InventoryForecastRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [a, r, f] = await Promise.all([listLowStockAlerts(), listJobReadinessSummary(true), listInventoryForecast()]);
        if (!cancelled) {
          setAlerts(a);
          setReadiness(r);
          setForecast(f);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rising = forecast.filter((f) => f.demand_trend === 'rising').slice(0, 6);

  if (loading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-bg-tertiary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active parts" value={parts.filter((p) => p.active).length} />
        <StatCard label="Locations" value={locations.filter((l) => l.active).length} />
        <StatCard label="Low / out of stock" value={alerts.length} tone={alerts.length ? '#ef4444' : undefined} />
        <StatCard label="Jobs at risk" value={readiness.length} tone={readiness.length ? '#f59e0b' : undefined} />
      </div>

      <div className={cardClass}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <AlertTriangle size={15} className="text-danger" /> Reorder now
        </h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-text-secondary">Every part is above its reorder point. Nothing to order.</p>
        ) : (
          <div className="space-y-2">
            {alerts.slice(0, 8).map((a) => (
              <div key={`${a.part_id}-${a.location_id}`} className="flex items-center justify-between gap-3 rounded-xl bg-bg-tertiary/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">{a.part_name}</p>
                  <p className="text-xs text-text-secondary">
                    {a.location_name} · {a.quantity_available} on hand (reorder at {a.reorder_point})
                  </p>
                </div>
                <div className="text-right">
                  <RiskBadge risk={a.stockout_risk} />
                  <p className="mt-1 text-xs text-text-secondary">
                    Order {a.suggested_reorder_quantity} · {formatCents(a.estimated_reorder_cost_cents)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={cardClass}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <TrendingUp size={15} className="text-accent" /> Rising demand (forecast)
        </h2>
        {rising.length === 0 ? (
          <p className="text-sm text-text-secondary">No parts trending up over the last 30 days.</p>
        ) : (
          <div className="space-y-2">
            {rising.map((f) => (
              <div key={`${f.part_id}-${f.location_id}`} className="flex items-center justify-between gap-3 rounded-xl bg-bg-tertiary/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">{f.part_name}</p>
                  <p className="text-xs text-text-secondary">{f.location_name} · {f.avg_daily_usage_30d.toFixed(2)}/day now vs 90d avg {f.avg_daily_usage_90d.toFixed(2)}/day</p>
                </div>
                <div className="text-right text-xs text-text-secondary">
                  <StatusPill text={DEMAND_TREND_LABELS[f.demand_trend]} tone="warn" />
                  <p className="mt-1 font-semibold text-accent">Par {f.suggested_par_level}</p>
                  <p>{f.estimated_days_of_stock != null ? `${f.estimated_days_of_stock}d left` : '—'}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={cardClass}>
        <h2 className="mb-3 text-sm font-semibold text-text-primary">Jobs at risk of missing parts</h2>
        {readiness.length === 0 ? (
          <p className="text-sm text-text-secondary">Every upcoming job has what it needs.</p>
        ) : (
          <div className="space-y-2">
            {readiness.slice(0, 8).map((r) => (
              <div key={r.job_id} className="flex items-center justify-between gap-3 rounded-xl bg-bg-tertiary/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">{r.customer_name}</p>
                  <p className="text-xs text-text-secondary">
                    {r.scheduled_datetime ? new Date(r.scheduled_datetime).toLocaleString() : 'Unscheduled'}
                  </p>
                </div>
                <StatusPill text={`${r.parts_short_count} short of ${r.parts_required_count}`} tone="warn" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PARTS
// ============================================================

interface PartFormState {
  name: string;
  part_number: string;
  barcode: string;
  category: string;
  unit_label: string;
  unit_cost_cents: string;
  reorder_point: string;
  reorder_quantity: string;
  preferred_vendor: string;
}

const EMPTY_PART_FORM: PartFormState = {
  name: '',
  part_number: '',
  barcode: '',
  category: '',
  unit_label: '',
  unit_cost_cents: '',
  reorder_point: '0',
  reorder_quantity: '0',
  preferred_vendor: '',
};

function partToForm(p: InventoryPart): PartFormState {
  return {
    name: p.name,
    part_number: p.part_number ?? '',
    barcode: p.barcode ?? '',
    category: p.category ?? '',
    unit_label: p.unit_label ?? '',
    unit_cost_cents: String(p.unit_cost_cents),
    reorder_point: String(p.reorder_point),
    reorder_quantity: String(p.reorder_quantity),
    preferred_vendor: p.preferred_vendor ?? '',
  };
}

function PartForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: PartFormState;
  onCancel: () => void;
  onSave: (form: PartFormState) => void;
}) {
  const [form, setForm] = useState(initial);
  return (
    <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Name *</label>
          <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="1/2 HP Condenser Fan Motor" />
        </div>
        <div>
          <label className={labelClass}>Part number</label>
          <input className={inputClass} value={form.part_number} onChange={(e) => setForm({ ...form, part_number: e.target.value })} />
        </div>
        <div>
          <label className={labelClass}>Barcode / QR value</label>
          <input className={inputClass} value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder="Scan or type" />
        </div>
        <div>
          <label className={labelClass}>Category</label>
          <input className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="HVAC / Electrical / Plumbing" />
        </div>
        <div>
          <label className={labelClass}>Unit label</label>
          <input className={inputClass} value={form.unit_label} onChange={(e) => setForm({ ...form, unit_label: e.target.value })} placeholder="each, ft, box" />
        </div>
        <div>
          <label className={labelClass}>Unit cost ($)</label>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            value={form.unit_cost_cents ? (Number(form.unit_cost_cents) / 100).toString() : ''}
            onChange={(e) => setForm({ ...form, unit_cost_cents: String(Math.round(Number(e.target.value || 0) * 100)) })}
          />
        </div>
        <div>
          <label className={labelClass}>Reorder point</label>
          <input type="number" className={inputClass} value={form.reorder_point} onChange={(e) => setForm({ ...form, reorder_point: e.target.value })} />
        </div>
        <div>
          <label className={labelClass}>Reorder quantity</label>
          <input type="number" className={inputClass} value={form.reorder_quantity} onChange={(e) => setForm({ ...form, reorder_quantity: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Preferred vendor (free text — or manage via the Vendors tab)</label>
          <input className={inputClass} value={form.preferred_vendor} onChange={(e) => setForm({ ...form, preferred_vendor: e.target.value })} />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">
          Cancel
        </button>
        <button
          type="button"
          disabled={!form.name.trim()}
          onClick={() => onSave(form)}
          className={btnPrimary}
        >
          <Check size={14} /> Save part
        </button>
      </div>
    </div>
  );
}

function SubstitutesPanel({ part, parts, toast }: { part: InventoryPart; parts: InventoryPart[]; toast: (m: string, t?: 'success' | 'error' | 'info') => void }) {
  const [subs, setSubs] = useState<PartSubstitute[]>([]);
  const [picking, setPicking] = useState('');

  const load = useCallback(async () => {
    try {
      setSubs(await listPartSubstitutes(part.id));
    } catch {
      toast('Could not load substitutes', 'error');
    }
  }, [part.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const options = parts.filter((p) => p.id !== part.id && !subs.some((s) => s.substitute_part_id === p.id));

  return (
    <div className="mt-3 rounded-xl bg-bg-tertiary/50 p-3">
      <p className="mb-2 text-xs font-semibold text-text-secondary">Approved substitutes</p>
      {subs.length === 0 && <p className="mb-2 text-xs text-text-secondary/70">No substitutes on file yet.</p>}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {subs.map((s) => {
          const sp = parts.find((p) => p.id === s.substitute_part_id);
          return (
            <span key={s.id} className="flex items-center gap-1 rounded-full bg-bg-secondary px-2 py-1 text-xs text-text-primary">
              {sp?.name ?? 'Unknown part'}
              <button
                type="button"
                onClick={async () => {
                  await removePartSubstitute(s.id);
                  load();
                }}
                className="text-text-secondary hover:text-danger"
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
      </div>
      <div className="flex gap-2">
        <select className={inputClass} value={picking} onChange={(e) => setPicking(e.target.value)}>
          <option value="">Add a substitute part…</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!picking}
          onClick={async () => {
            await addPartSubstitute(part.id, picking);
            setPicking('');
            load();
          }}
          className="focus-ring shrink-0 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function PartsTab({
  parts,
  vendors,
  onChanged,
  toast,
}: {
  parts: InventoryPart[];
  vendors: InventoryVendor[];
  onChanged: () => void;
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const { user } = useAuth();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [scan, setScan] = useState('');
  const [search, setSearch] = useState('');

  const handleSave = async (form: PartFormState, partId?: string) => {
    if (!user) return;
    try {
      await upsertInventoryPart({
        ...(partId ? { id: partId } : {}),
        user_id: user.id,
        name: form.name.trim(),
        part_number: form.part_number.trim() || null,
        barcode: form.barcode.trim() || null,
        category: form.category.trim() || null,
        unit_label: form.unit_label.trim() || null,
        unit_cost_cents: Number(form.unit_cost_cents || 0),
        reorder_point: Number(form.reorder_point || 0),
        reorder_quantity: Number(form.reorder_quantity || 0),
        preferred_vendor: form.preferred_vendor.trim() || null,
      } as Partial<InventoryPart> & { name: string });
      toast('Part saved', 'success');
      setAdding(false);
      setEditingId(null);
      onChanged();
    } catch {
      toast('Could not save this part', 'error');
    }
  };

  const handleToggleActive = async (part: InventoryPart) => {
    try {
      await upsertInventoryPart({ id: part.id, name: part.name, active: !part.active } as Partial<InventoryPart> & { name: string });
      onChanged();
    } catch {
      toast('Could not update this part', 'error');
    }
  };

  const handleScan = async () => {
    if (!scan.trim()) return;
    const found = await findPartByBarcode(scan.trim());
    if (found) {
      setExpandedId(found.id);
      setSearch('');
      toast(`Found: ${found.name}`, 'success');
    } else {
      toast('No part matches that barcode', 'info');
    }
    setScan('');
  };

  const filtered = parts.filter(
    (p) =>
      !search.trim() ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.part_number ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="Search parts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex items-center gap-1.5">
          <Barcode size={14} className="text-text-secondary" />
          <input
            className={`${inputClass} max-w-[200px]`}
            placeholder="Scan barcode…"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleScan()}
          />
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={btnGhost}>
            <Plus size={14} /> Add part
          </button>
        )}
      </div>

      {adding && <PartForm initial={EMPTY_PART_FORM} onCancel={() => setAdding(false)} onSave={(f) => handleSave(f)} />}

      {filtered.length === 0 && !adding ? (
        <EmptyState icon={Package} title="No parts yet" description="Add your first part to start tracking stock." />
      ) : (
        <div className="space-y-2">
          {filtered.map((part) =>
            editingId === part.id ? (
              <PartForm key={part.id} initial={partToForm(part)} onCancel={() => setEditingId(null)} onSave={(f) => handleSave(f, part.id)} />
            ) : (
              <motion.div
                key={part.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className={`rounded-xl border p-4 ${part.active ? 'border-border bg-bg-secondary' : 'border-border/50 bg-bg-secondary/50 opacity-60'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      {part.name}
                      {part.part_number && <span className="ml-2 font-normal text-text-secondary">#{part.part_number}</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {part.category || 'Uncategorized'} · {formatCents(part.unit_cost_cents)} {part.unit_label && `/ ${part.unit_label}`} · reorder at {part.reorder_point}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => setExpandedId(expandedId === part.id ? null : part.id)} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
                      Substitutes
                    </button>
                    <button type="button" onClick={() => handleToggleActive(part)} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
                      {part.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button type="button" onClick={() => setEditingId(part.id)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Edit part">
                      <Pencil size={14} />
                    </button>
                    <button type="button" onClick={() => setDeletingId(part.id)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger" aria-label="Delete part">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {expandedId === part.id && <SubstitutesPanel part={part} parts={parts} toast={toast} />}
              </motion.div>
            ),
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Deactivate this part?"
        description="It will stop appearing as an option for new stock, POs, or job requirements. Existing history is kept."
        confirmLabel="Yes, deactivate"
        onConfirm={async () => {
          const part = parts.find((p) => p.id === deletingId);
          if (part) await handleToggleActive(part);
          setDeletingId(null);
        }}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  );
}

// ============================================================
// LOCATIONS & BINS
// ============================================================

function BinsPanel({ location, toast }: { location: InventoryLocation; toast: (m: string, t?: 'success' | 'error' | 'info') => void }) {
  const [bins, setBins] = useState<InventoryBinLocation[]>([]);
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    try {
      setBins(await listBinLocations(location.id));
    } catch {
      toast('Could not load bin locations', 'error');
    }
  }, [location.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!code.trim()) return;
    try {
      await upsertBinLocation({ location_id: location.id, code: code.trim(), description: description.trim() || null });
      setCode('');
      setDescription('');
      load();
    } catch {
      toast('Could not add that bin — the code may already exist here', 'error');
    }
  };

  return (
    <div className="mt-3 rounded-xl bg-bg-tertiary/50 p-3">
      <p className="mb-2 text-xs font-semibold text-text-secondary">Bin locations</p>
      {bins.length === 0 && <p className="mb-2 text-xs text-text-secondary/70">No bins set up here yet.</p>}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {bins.map((b) => (
          <span key={b.id} className="rounded-full bg-bg-secondary px-2 py-1 text-xs text-text-primary" title={b.description ?? ''}>
            <MapPin size={10} className="mr-1 inline" />
            {b.code}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={`${inputClass} max-w-[120px]`} placeholder="Bin code (A1)" value={code} onChange={(e) => setCode(e.target.value)} />
        <input className={inputClass} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button type="button" onClick={handleAdd} disabled={!code.trim()} className="focus-ring shrink-0 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
          Add
        </button>
      </div>
    </div>
  );
}

interface LocationFormState {
  name: string;
  location_type: LocationType;
}

function LocationsTab({
  locations,
  onChanged,
  toast,
}: {
  locations: InventoryLocation[];
  onChanged: () => void;
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const { user } = useAuth();
  const [form, setForm] = useState<LocationFormState>({ name: '', location_type: 'warehouse' });
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Warehouses, technician vans, and job sites — each with its own stock and bins.</p>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={btnGhost}>
            <Plus size={14} /> Add location
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Name *</label>
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main Warehouse, Van 3…" />
            </div>
            <div>
              <label className={labelClass}>Type</label>
              <select className={inputClass} value={form.location_type} onChange={(e) => setForm({ ...form, location_type: e.target.value as LocationType })}>
                {(Object.keys(LOCATION_TYPE_LABELS) as LocationType[]).map((t) => (
                  <option key={t} value={t}>
                    {LOCATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">
              Cancel
            </button>
            <button
              type="button"
              disabled={!form.name.trim()}
              onClick={async () => {
                if (!user) return;
                const { error } = await supabase.from('inventory_locations').insert({ user_id: user.id, name: form.name.trim(), location_type: form.location_type });
                if (error) {
                  toast('Could not add this location', 'error');
                  return;
                }
                toast('Location added', 'success');
                setForm({ name: '', location_type: 'warehouse' });
                setAdding(false);
                onChanged();
              }}
              className={btnPrimary}
            >
              <Check size={14} /> Save location
            </button>
          </div>
        </div>
      )}

      {locations.length === 0 && !adding ? (
        <EmptyState icon={Warehouse} title="No locations yet" description="Add your warehouse and any technician vans to start tracking where parts live." />
      ) : (
        <div className="space-y-2">
          {locations.map((loc) => (
            <div key={loc.id} className={`rounded-xl border p-4 ${loc.active ? 'border-border bg-bg-secondary' : 'border-border/50 bg-bg-secondary/50 opacity-60'}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{loc.name}</p>
                  <p className="text-xs text-text-secondary">{LOCATION_TYPE_LABELS[loc.location_type]}</p>
                </div>
                <button type="button" onClick={() => setExpandedId(expandedId === loc.id ? null : loc.id)} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
                  Bins
                </button>
              </div>
              {expandedId === loc.id && <BinsPanel location={loc} toast={toast} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// STOCK & TRANSFERS
// ============================================================

function StockTab({
  parts,
  locations,
  toast,
}: {
  parts: InventoryPart[];
  locations: InventoryLocation[];
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const [rows, setRows] = useState<PartsAvailabilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTxnForm, setShowTxnForm] = useState(false);
  const [showTransferForm, setShowTransferForm] = useState(false);

  const [txn, setTxn] = useState({ part_id: '', location_id: '', transaction_type: 'receipt' as TransactionType, quantity: '1', note: '' });
  const [transfer, setTransfer] = useState({ part_id: '', from: '', to: '', quantity: '1', note: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listPartsAvailability());
    } catch {
      toast('Could not load stock levels', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRecordTxn = async () => {
    if (!txn.part_id || !txn.location_id || !Number(txn.quantity)) return;
    const magnitude = Math.abs(Number(txn.quantity));
    const negative: TransactionType[] = ['usage', 'transfer_out'];
    try {
      await recordInventoryTransaction({
        part_id: txn.part_id,
        location_id: txn.location_id,
        transaction_type: txn.transaction_type,
        quantity_delta: negative.includes(txn.transaction_type) ? -magnitude : magnitude,
        note: txn.note.trim() || null,
      });
      toast('Transaction recorded', 'success');
      setShowTxnForm(false);
      setTxn({ part_id: '', location_id: '', transaction_type: 'receipt', quantity: '1', note: '' });
      load();
    } catch {
      toast('Could not record that transaction', 'error');
    }
  };

  const handleTransfer = async () => {
    if (!transfer.part_id || !transfer.from || !transfer.to || !Number(transfer.quantity)) return;
    try {
      await transferInventoryStock({
        partId: transfer.part_id,
        fromLocationId: transfer.from,
        toLocationId: transfer.to,
        quantity: Math.abs(Number(transfer.quantity)),
        note: transfer.note.trim() || undefined,
      });
      toast('Stock transferred', 'success');
      setShowTransferForm(false);
      setTransfer({ part_id: '', from: '', to: '', quantity: '1', note: '' });
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not complete that transfer', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setShowTxnForm((v) => !v)} className={btnGhost}>
          <Plus size={14} /> Record transaction
        </button>
        <button type="button" onClick={() => setShowTransferForm((v) => !v)} className={btnGhost}>
          <ArrowLeftRight size={14} /> Transfer stock
        </button>
      </div>

      {showTxnForm && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select className={inputClass} value={txn.part_id} onChange={(e) => setTxn({ ...txn, part_id: e.target.value })}>
              <option value="">Part…</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select className={inputClass} value={txn.location_id} onChange={(e) => setTxn({ ...txn, location_id: e.target.value })}>
              <option value="">Location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <select className={inputClass} value={txn.transaction_type} onChange={(e) => setTxn({ ...txn, transaction_type: e.target.value as TransactionType })}>
              {(Object.keys(TRANSACTION_TYPE_LABELS) as TransactionType[]).map((t) => (
                <option key={t} value={t}>{TRANSACTION_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <input type="number" className={inputClass} placeholder="Quantity" value={txn.quantity} onChange={(e) => setTxn({ ...txn, quantity: e.target.value })} />
          </div>
          <input className={`${inputClass} mt-3`} placeholder="Note (optional)" value={txn.note} onChange={(e) => setTxn({ ...txn, note: e.target.value })} />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setShowTxnForm(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" onClick={handleRecordTxn} className={btnPrimary}><Check size={14} /> Record</button>
          </div>
        </div>
      )}

      {showTransferForm && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select className={inputClass} value={transfer.part_id} onChange={(e) => setTransfer({ ...transfer, part_id: e.target.value })}>
              <option value="">Part…</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select className={inputClass} value={transfer.from} onChange={(e) => setTransfer({ ...transfer, from: e.target.value })}>
              <option value="">From…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <select className={inputClass} value={transfer.to} onChange={(e) => setTransfer({ ...transfer, to: e.target.value })}>
              <option value="">To…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <input type="number" className={inputClass} placeholder="Quantity" value={transfer.quantity} onChange={(e) => setTransfer({ ...transfer, quantity: e.target.value })} />
          </div>
          <p className="mt-2 text-xs text-text-secondary">Logged as one atomic transfer_out + transfer_in pair — the source location's available stock is checked before it goes through.</p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setShowTransferForm(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" onClick={handleTransfer} className={btnPrimary}><Check size={14} /> Transfer</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ArrowLeftRight} title="No stock recorded yet" description="Record a receipt to start tracking on-hand quantities." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg-tertiary text-xs text-text-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Part</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">On hand</th>
                <th className="px-3 py-2 font-medium">Reserved</th>
                <th className="px-3 py-2 font-medium">Available</th>
                <th className="px-3 py-2 font-medium">Days left</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.stock_level_id}>
                  <td className="px-3 py-2 text-text-primary">{r.part_name}</td>
                  <td className="px-3 py-2 text-text-secondary">{r.location_name}</td>
                  <td className="px-3 py-2 text-text-primary">{r.quantity_on_hand}</td>
                  <td className="px-3 py-2 text-text-secondary">{r.quantity_reserved}</td>
                  <td className="px-3 py-2 font-medium text-text-primary">{r.quantity_available}</td>
                  <td className="px-3 py-2 text-text-secondary">{r.estimated_days_of_stock ?? '—'}</td>
                  <td className="px-3 py-2"><RiskBadge risk={r.stockout_risk} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// VENDORS & VENDOR CATALOG
// ============================================================

function VendorCatalogPanel({ part, vendors, toast }: { part: InventoryPart; vendors: InventoryVendor[]; toast: (m: string, t?: 'success' | 'error' | 'info') => void }) {
  const [entries, setEntries] = useState<PartVendorCatalogEntry[]>([]);
  const [form, setForm] = useState({ vendor_id: '', vendor_sku: '', unit_cost: '', lead_time_days: '', is_preferred: false });

  const load = useCallback(async () => {
    try {
      setEntries(await listPartVendorCatalog(part.id));
    } catch {
      toast('Could not load the vendor catalog for this part', 'error');
    }
  }, [part.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!form.vendor_id) return;
    try {
      await upsertPartVendorCatalogEntry({
        part_id: part.id,
        vendor_id: form.vendor_id,
        vendor_sku: form.vendor_sku.trim() || null,
        unit_cost_cents: Math.round(Number(form.unit_cost || 0) * 100),
        lead_time_days: form.lead_time_days ? Number(form.lead_time_days) : null,
        is_preferred: form.is_preferred,
      });
      setForm({ vendor_id: '', vendor_sku: '', unit_cost: '', lead_time_days: '', is_preferred: false });
      load();
    } catch {
      toast('Could not save this vendor catalog entry', 'error');
    }
  };

  return (
    <div className="mt-3 rounded-xl bg-bg-tertiary/50 p-3">
      <p className="mb-2 text-xs font-semibold text-text-secondary">Vendor catalog for {part.name}</p>
      {entries.length === 0 && <p className="mb-2 text-xs text-text-secondary/70">No vendors linked to this part yet.</p>}
      <div className="mb-2 space-y-1.5">
        {entries.map((e) => {
          const v = vendors.find((vv) => vv.id === e.vendor_id);
          return (
            <div key={e.id} className="flex items-center justify-between rounded-lg bg-bg-secondary px-2.5 py-1.5 text-xs">
              <span className="text-text-primary">
                {v?.name ?? 'Vendor'} {e.is_preferred && <StatusPill text="Preferred" tone="good" />}
              </span>
              <span className="text-text-secondary">
                {e.vendor_sku ? `SKU ${e.vendor_sku} · ` : ''}
                {formatCents(e.unit_cost_cents)} {e.lead_time_days != null ? `· ${e.lead_time_days}d lead` : ''}
              </span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <select className={inputClass} value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}>
          <option value="">Vendor…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
        <input className={inputClass} placeholder="Vendor SKU" value={form.vendor_sku} onChange={(e) => setForm({ ...form, vendor_sku: e.target.value })} />
        <input type="number" step="0.01" className={inputClass} placeholder="Cost $" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
        <input type="number" className={inputClass} placeholder="Lead days" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} />
        <button type="button" onClick={handleAdd} disabled={!form.vendor_id} className="focus-ring rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
          Add
        </button>
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
        <input type="checkbox" checked={form.is_preferred} onChange={(e) => setForm({ ...form, is_preferred: e.target.checked })} />
        Preferred vendor for this part
      </label>
    </div>
  );
}

function VendorsTab({
  vendors,
  parts,
  onChanged,
  toast,
}: {
  vendors: InventoryVendor[];
  parts: InventoryPart[];
  onChanged: () => void;
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', contact_name: '', email: '', phone: '', default_lead_time_days: '7' });
  const [catalogPartId, setCatalogPartId] = useState('');

  const handleAdd = async () => {
    if (!form.name.trim()) return;
    try {
      await upsertInventoryVendor({
        name: form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        default_lead_time_days: Number(form.default_lead_time_days || 7),
      });
      toast('Vendor added', 'success');
      setForm({ name: '', contact_name: '', email: '', phone: '', default_lead_time_days: '7' });
      setAdding(false);
      onChanged();
    } catch {
      toast('Could not save this vendor', 'error');
    }
  };

  const catalogPart = parts.find((p) => p.id === catalogPartId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Your suppliers — with per-part SKU, cost, and lead time in the vendor catalog below.</p>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={btnGhost}>
            <Plus size={14} /> Add vendor
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input className={inputClass} placeholder="Vendor name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className={inputClass} placeholder="Contact name" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
            <input className={inputClass} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input className={inputClass} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input type="number" className={inputClass} placeholder="Default lead time (days)" value={form.default_lead_time_days} onChange={(e) => setForm({ ...form, default_lead_time_days: e.target.value })} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" disabled={!form.name.trim()} onClick={handleAdd} className={btnPrimary}><Check size={14} /> Save vendor</button>
          </div>
        </div>
      )}

      {vendors.length === 0 && !adding ? (
        <EmptyState icon={Building2} title="No vendors yet" description="Add a vendor to start building your parts catalog and purchase orders." />
      ) : (
        <div className="space-y-2">
          {vendors.map((v) => (
            <div key={v.id} className="rounded-xl border border-border bg-bg-secondary p-4">
              <p className="text-sm font-semibold text-text-primary">{v.name}</p>
              <p className="text-xs text-text-secondary">
                {v.contact_name && `${v.contact_name} · `}{v.email} {v.phone && `· ${v.phone}`} · {v.default_lead_time_days}d default lead time
              </p>
            </div>
          ))}
        </div>
      )}

      <div className={cardClass}>
        <p className="mb-2 text-sm font-semibold text-text-primary">Vendor catalog by part</p>
        <select className={`${inputClass} max-w-sm`} value={catalogPartId} onChange={(e) => setCatalogPartId(e.target.value)}>
          <option value="">Choose a part to view/edit its vendors…</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {catalogPart && <VendorCatalogPanel part={catalogPart} vendors={vendors} toast={toast} />}
      </div>
    </div>
  );
}

// ============================================================
// PURCHASE ORDERS
// ============================================================

function POLinesPanel({
  po,
  parts,
  locations,
  toast,
  onChanged,
}: {
  po: PurchaseOrderSummaryRow;
  parts: InventoryPart[];
  locations: InventoryLocation[];
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
  onChanged: () => void;
}) {
  const [lines, setLines] = useState<InventoryPurchaseOrderLine[]>([]);
  const [newLine, setNewLine] = useState({ part_id: '', quantity: '1', unit_cost: '' });
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [receiveLocation, setReceiveLocation] = useState(po.destination_location_id ?? '');

  const load = useCallback(async () => {
    try {
      setLines(await getPurchaseOrderLines(po.purchase_order_id));
    } catch {
      toast('Could not load PO lines', 'error');
    }
  }, [po.purchase_order_id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddLine = async () => {
    if (!newLine.part_id || !Number(newLine.quantity)) return;
    try {
      await addPurchaseOrderLine({
        purchase_order_id: po.purchase_order_id,
        part_id: newLine.part_id,
        quantity_ordered: Number(newLine.quantity),
        unit_cost_cents: Math.round(Number(newLine.unit_cost || 0) * 100),
      });
      setNewLine({ part_id: '', quantity: '1', unit_cost: '' });
      load();
      onChanged();
    } catch {
      toast('Could not add that line', 'error');
    }
  };

  const handleReceive = async (line: InventoryPurchaseOrderLine) => {
    const qty = Number(receiveQty[line.id] || 0);
    if (!qty || !receiveLocation) {
      toast('Choose a receiving location and quantity first', 'info');
      return;
    }
    try {
      await receivePurchaseOrderLine({ lineId: line.id, quantity: qty, locationId: receiveLocation });
      toast('Received into stock', 'success');
      setReceiveQty({ ...receiveQty, [line.id]: '' });
      load();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not receive that quantity', 'error');
    }
  };

  return (
    <div className="mt-3 space-y-2 rounded-xl bg-bg-tertiary/50 p-3">
      {po.status !== 'draft' && po.status !== 'cancelled' && po.status !== 'received' && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-secondary">Receive into:</label>
          <select className={`${inputClass} max-w-[200px]`} value={receiveLocation} onChange={(e) => setReceiveLocation(e.target.value)}>
            <option value="">Location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      )}
      {lines.map((l) => {
        const part = parts.find((p) => p.id === l.part_id);
        const remaining = l.quantity_ordered - l.quantity_received;
        return (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-secondary px-2.5 py-1.5 text-xs">
            <span className="text-text-primary">{part?.name ?? 'Part'} · {l.quantity_received}/{l.quantity_ordered} received · {formatCents(l.unit_cost_cents)} ea</span>
            {remaining > 0 && po.status !== 'draft' && po.status !== 'cancelled' && (
              <div className="flex items-center gap-1.5">
                <input type="number" max={remaining} className={`${inputClass} w-20`} placeholder={`≤${remaining}`} value={receiveQty[l.id] ?? ''} onChange={(e) => setReceiveQty({ ...receiveQty, [l.id]: e.target.value })} />
                <button type="button" onClick={() => handleReceive(l)} className="rounded-lg bg-accent px-2 py-1 font-semibold text-white">Receive</button>
              </div>
            )}
          </div>
        );
      })}
      {po.status === 'draft' && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select className={inputClass} value={newLine.part_id} onChange={(e) => setNewLine({ ...newLine, part_id: e.target.value })}>
            <option value="">Part…</option>
            {parts.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input type="number" className={inputClass} placeholder="Qty" value={newLine.quantity} onChange={(e) => setNewLine({ ...newLine, quantity: e.target.value })} />
          <input type="number" step="0.01" className={inputClass} placeholder="Unit cost $" value={newLine.unit_cost} onChange={(e) => setNewLine({ ...newLine, unit_cost: e.target.value })} />
          <button type="button" onClick={handleAddLine} className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white">Add line</button>
        </div>
      )}
    </div>
  );
}

function PurchaseOrdersTab({
  vendors,
  parts,
  locations,
  toast,
}: {
  vendors: InventoryVendor[];
  parts: InventoryPart[];
  locations: InventoryLocation[];
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const [pos, setPos] = useState<PurchaseOrderSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ vendor_id: '', po_number: '', destination_location_id: '', expected_date: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPos(await listPurchaseOrders());
    } catch {
      toast('Could not load purchase orders', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!form.vendor_id) return;
    try {
      await createPurchaseOrder({
        vendor_id: form.vendor_id,
        po_number: form.po_number.trim() || null,
        destination_location_id: form.destination_location_id || null,
        expected_date: form.expected_date || null,
      });
      toast('Purchase order created — add lines, then submit', 'success');
      setForm({ vendor_id: '', po_number: '', destination_location_id: '', expected_date: '' });
      setCreating(false);
      load();
    } catch {
      toast('Could not create that purchase order — check the PO number is unique', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Draft → submit → receive. Receiving a line logs the stock straight into the ledger.</p>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} className={btnGhost}>
            <Plus size={14} /> New purchase order
          </button>
        )}
      </div>

      {creating && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select className={inputClass} value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}>
              <option value="">Vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <input className={inputClass} placeholder="PO number (optional)" value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} />
            <select className={inputClass} value={form.destination_location_id} onChange={(e) => setForm({ ...form, destination_location_id: e.target.value })}>
              <option value="">Destination…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <input type="date" className={inputClass} value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setCreating(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" disabled={!form.vendor_id} onClick={handleCreate} className={btnPrimary}><Check size={14} /> Create PO</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : pos.length === 0 ? (
        <EmptyState icon={Truck} title="No purchase orders yet" description="Create one to start ordering from a vendor." />
      ) : (
        <div className="space-y-2">
          {pos.map((po) => (
            <div key={po.purchase_order_id} className="rounded-xl border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    {po.po_number || 'Untitled PO'} — {po.vendor_name}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {po.line_count} line{po.line_count === 1 ? '' : 's'} · {po.total_quantity_received}/{po.total_quantity_ordered} received · {formatCents(po.total_cost_cents)}
                    {po.expected_date && ` · expected ${po.expected_date}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill
                    text={PURCHASE_ORDER_STATUS_LABELS[po.status]}
                    tone={po.status === 'received' ? 'good' : po.status === 'cancelled' ? 'bad' : po.status === 'draft' ? 'neutral' : 'warn'}
                  />
                  {po.status === 'draft' && (
                    <button type="button" onClick={async () => { await submitPurchaseOrder(po.purchase_order_id); load(); }} className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                      Submit
                    </button>
                  )}
                  {(po.status === 'draft' || po.status === 'submitted') && (
                    <button type="button" onClick={async () => { await cancelPurchaseOrder(po.purchase_order_id); load(); }} className="rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10">
                      Cancel
                    </button>
                  )}
                  <button type="button" onClick={() => setExpandedId(expandedId === po.purchase_order_id ? null : po.purchase_order_id)} className="rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">
                    {expandedId === po.purchase_order_id ? 'Hide lines' : 'View lines'}
                  </button>
                </div>
              </div>
              {expandedId === po.purchase_order_id && (
                <POLinesPanel po={po} parts={parts} locations={locations} toast={toast} onChanged={load} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// SERIALS & LOTS
// ============================================================

function SerialsTab({
  parts,
  locations,
  partsById,
  toast,
}: {
  parts: InventoryPart[];
  locations: InventoryLocation[];
  partsById: Map<string, InventoryPart>;
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPartId, setFilterPartId] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ part_id: '', serial_number: '', lot_number: '', location_id: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSerials(await listInventorySerials(filterPartId ? { partId: filterPartId } : {}));
    } catch {
      toast('Could not load serials/lots', 'error');
    } finally {
      setLoading(false);
    }
  }, [filterPartId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!form.part_id || (!form.serial_number.trim() && !form.lot_number.trim())) {
      toast('Enter a serial number or a lot number', 'info');
      return;
    }
    try {
      await registerInventorySerial({
        part_id: form.part_id,
        serial_number: form.serial_number.trim() || undefined,
        lot_number: form.lot_number.trim() || undefined,
        location_id: form.location_id || undefined,
      });
      toast('Registered', 'success');
      setForm({ part_id: '', serial_number: '', lot_number: '', location_id: '' });
      setAdding(false);
      load();
    } catch {
      toast('Could not register that serial — it may already exist', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select className={`${inputClass} max-w-xs`} value={filterPartId} onChange={(e) => setFilterPartId(e.target.value)}>
          <option value="">All parts</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={btnGhost}>
            <Plus size={14} /> Register serial / lot
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select className={inputClass} value={form.part_id} onChange={(e) => setForm({ ...form, part_id: e.target.value })}>
              <option value="">Part…</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input className={inputClass} placeholder="Serial number" value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} />
            <input className={inputClass} placeholder="Lot number" value={form.lot_number} onChange={(e) => setForm({ ...form, lot_number: e.target.value })} />
            <select className={inputClass} value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
              <option value="">Location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" onClick={handleAdd} className={btnPrimary}><Check size={14} /> Register</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : serials.length === 0 ? (
        <EmptyState icon={Hash} title="No serials or lots tracked yet" description="Register a serial number or lot for parts you need unit-level traceability on." />
      ) : (
        <div className="space-y-2">
          {serials.map((s) => {
            const part = partsById.get(s.part_id);
            const loc = locations.find((l) => l.id === s.location_id);
            return (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-3">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {part?.name ?? 'Part'} {s.serial_number && <span className="text-text-secondary">· SN {s.serial_number}</span>}
                    {s.lot_number && <span className="text-text-secondary"> · Lot {s.lot_number}</span>}
                  </p>
                  <p className="text-xs text-text-secondary">{loc?.name ?? 'No location'} · received {new Date(s.received_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill
                    text={SERIAL_STATUS_LABELS[s.status]}
                    tone={s.status === 'installed' ? 'good' : s.status === 'scrapped' || s.status === 'returned' ? 'bad' : 'neutral'}
                  />
                  {s.status === 'in_stock' && (
                    <button type="button" onClick={async () => { await updateSerialStatus(s.id, 'installed'); load(); }} className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                      Mark installed
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RESERVATIONS
// ============================================================

function ReservationsTab({
  parts,
  locations,
  partsById,
  toast,
}: {
  parts: InventoryPart[];
  locations: InventoryLocation[];
  partsById: Map<string, InventoryPart>;
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const [reservations, setReservations] = useState<InventoryReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ part_id: '', location_id: '', quantity: '1', job_id: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReservations(await listInventoryReservations());
    } catch {
      toast('Could not load reservations', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!form.part_id || !form.location_id || !Number(form.quantity)) return;
    try {
      await createInventoryReservation({
        part_id: form.part_id,
        location_id: form.location_id,
        quantity: Number(form.quantity),
        job_id: form.job_id.trim() || undefined,
      });
      toast('Reserved', 'success');
      setForm({ part_id: '', location_id: '', quantity: '1', job_id: '' });
      setAdding(false);
      load();
    } catch {
      toast('Could not create that reservation', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Soft-hold stock for a job so it can't be picked for anything else.</p>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={btnGhost}>
            <Plus size={14} /> Reserve stock
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select className={inputClass} value={form.part_id} onChange={(e) => setForm({ ...form, part_id: e.target.value })}>
              <option value="">Part…</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select className={inputClass} value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
              <option value="">Location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <input type="number" className={inputClass} placeholder="Quantity" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            <input className={inputClass} placeholder="Job ID (optional)" value={form.job_id} onChange={(e) => setForm({ ...form, job_id: e.target.value })} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" onClick={handleAdd} className={btnPrimary}><Check size={14} /> Reserve</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : reservations.length === 0 ? (
        <EmptyState icon={Barcode} title="No reservations yet" description="Reserve stock for an upcoming job so it's held aside." />
      ) : (
        <div className="space-y-2">
          {reservations.map((r) => {
            const part = partsById.get(r.part_id);
            const loc = locations.find((l) => l.id === r.location_id);
            return (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-3">
                <div>
                  <p className="text-sm font-medium text-text-primary">{part?.name ?? 'Part'} × {r.quantity}</p>
                  <p className="text-xs text-text-secondary">{loc?.name ?? 'Location'} {r.job_id && `· job ${r.job_id.slice(0, 8)}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill text={RESERVATION_STATUS_LABELS[r.status]} tone={r.status === 'fulfilled' ? 'good' : r.status === 'released' ? 'neutral' : 'warn'} />
                  {r.status === 'active' && (
                    <>
                      <button
                        type="button"
                        disabled={!r.job_id}
                        onClick={async () => { if (r.job_id) { await fulfillInventoryReservation(r, r.job_id); load(); } }}
                        className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
                      >
                        Fulfill
                      </button>
                      <button type="button" onClick={async () => { await releaseInventoryReservation(r.id); load(); }} className="rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">
                        Release
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RETURNS & CORE RETURNS
// ============================================================

function ReturnsTab({
  parts,
  locations,
  vendors,
  partsById,
  vendorsById,
  toast,
}: {
  parts: InventoryPart[];
  locations: InventoryLocation[];
  vendors: InventoryVendor[];
  partsById: Map<string, InventoryPart>;
  vendorsById: Map<string, InventoryVendor>;
  toast: (m: string, t?: 'success' | 'error' | 'info') => void;
}) {
  const [returns, setReturns] = useState<InventoryReturn[]>([]);
  const [openCore, setOpenCore] = useState<OpenCoreReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    return_type: 'customer_return' as ReturnType,
    part_id: '',
    location_id: '',
    quantity: '1',
    reason: '',
    vendor_id: '',
    core_credit: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([listInventoryReturns(), listOpenCoreReturns()]);
      setReturns(r);
      setOpenCore(c);
    } catch {
      toast('Could not load returns', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const totalExpectedCredit = openCore.reduce((sum, r) => sum + r.total_expected_credit_cents, 0);

  const handleAdd = async () => {
    if (!form.part_id || !form.location_id || !Number(form.quantity)) return;
    if (form.return_type === 'core_return' && !form.vendor_id) {
      toast('A core return needs a vendor to credit', 'info');
      return;
    }
    try {
      await createInventoryReturn({
        return_type: form.return_type,
        part_id: form.part_id,
        location_id: form.location_id,
        quantity: Number(form.quantity),
        reason: form.reason.trim() || undefined,
        vendor_id: form.return_type === 'core_return' ? form.vendor_id : undefined,
        core_credit_cents: form.core_credit ? Math.round(Number(form.core_credit) * 100) : undefined,
      });
      toast('Return logged', 'success');
      setForm({ return_type: 'customer_return', part_id: '', location_id: '', quantity: '1', reason: '', vendor_id: '', core_credit: '' });
      setAdding(false);
      load();
    } catch {
      toast('Could not log that return', 'error');
    }
  };

  return (
    <div className="space-y-4">
      {openCore.length > 0 && (
        <div className={cardClass}>
          <p className="text-sm font-semibold text-text-primary">Open core returns awaiting vendor credit</p>
          <p className="mt-1 text-xs text-text-secondary">{openCore.length} pending · {formatCents(totalExpectedCredit)} expected credit</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Customer returns put stock back on the shelf. Core returns track credit owed by the vendor for the old failed part.</p>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={btnGhost}>
            <Plus size={14} /> Log a return
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-accent/30 bg-bg-secondary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <select className={inputClass} value={form.return_type} onChange={(e) => setForm({ ...form, return_type: e.target.value as ReturnType })}>
              {(Object.keys(RETURN_TYPE_LABELS) as ReturnType[]).map((t) => (
                <option key={t} value={t}>{RETURN_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <select className={inputClass} value={form.part_id} onChange={(e) => setForm({ ...form, part_id: e.target.value })}>
              <option value="">Part…</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select className={inputClass} value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
              <option value="">Location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <input type="number" className={inputClass} placeholder="Quantity" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            {form.return_type === 'core_return' && (
              <>
                <select className={inputClass} value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}>
                  <option value="">Vendor to credit…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <input type="number" step="0.01" className={inputClass} placeholder="Expected credit $ / unit" value={form.core_credit} onChange={(e) => setForm({ ...form, core_credit: e.target.value })} />
              </>
            )}
            <input className={inputClass} placeholder="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="focus-ring rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary">Cancel</button>
            <button type="button" onClick={handleAdd} className={btnPrimary}><Check size={14} /> Log return</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : returns.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No returns logged yet" description="Customer returns and vendor core returns will show up here." />
      ) : (
        <div className="space-y-2">
          {returns.map((r) => {
            const part = partsById.get(r.part_id);
            const vendor = r.vendor_id ? vendorsById.get(r.vendor_id) : undefined;
            return (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-3">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {part?.name ?? 'Part'} × {r.quantity} <span className="text-text-secondary">— {RETURN_TYPE_LABELS[r.return_type]}</span>
                  </p>
                  <p className="text-xs text-text-secondary">
                    {r.reason || 'No reason given'} {vendor && `· ${vendor.name}`} {r.core_credit_cents != null && `· ${formatCents(r.core_credit_cents)}/unit credit`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill text={RETURN_STATUS_LABELS[r.status]} tone={r.status === 'credited' ? 'good' : r.status === 'rejected' ? 'bad' : 'warn'} />
                  {r.status === 'pending' && (
                    <button type="button" onClick={async () => { await resolveInventoryReturn(r, 'received'); load(); }} className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                      Mark received
                    </button>
                  )}
                  {r.status === 'received' && r.return_type === 'core_return' && (
                    <button type="button" onClick={async () => { await resolveInventoryReturn(r, 'credited'); load(); }} className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                      Mark credited
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
