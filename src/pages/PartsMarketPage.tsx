/**
 * AI Parts Market — /dashboard/parts-market
 *
 * Real-time supplier intelligence on top of Inventory + Procurement.
 * Pick a job shortage (or any part), and the engine ranks every source —
 * own van, warehouse, vendors, local distributors, nearby contractors,
 * approved substitutes — by ALL-IN expected cost, ETA, on-time probability
 * and margin impact, then recommends BUY vs BORROW vs TRANSFER.
 *
 * All logic lives in src/lib/partsMarket.ts (pure engine + data access);
 * this file is presentation + orchestration only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Clock,
  Handshake,
  Loader2,
  Package,
  Phone,
  Plus,
  Radio,
  RefreshCw,
  Store,
  Truck,
  X,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { formatCents } from '@/lib/priceBook';
import {
  ACTION_LABELS,
  OPTION_KIND_LABELS,
  SOURCE_TYPE_LABELS,
  VERDICT_LABELS,
  createMarketSource,
  evaluateMarket,
  executeOption,
  fetchMarketParts,
  fetchMarketSources,
  fetchRecentDecisions,
  fetchShortJobs,
  formatAge,
  formatEta,
  gatherMarketInput,
  recordDecision,
  resolveDecision,
  subscribeToMarket,
  upsertOffer,
} from '@/lib/partsMarket';
import type {
  Fulfillment,
  MarketDecisionRow,
  MarketInput,
  MarketOption,
  MarketPart,
  MarketSource,
  ShortJobRow,
  SourceType,
  Verdict,
} from '@/lib/partsMarket';

type TabKey = 'compare' | 'sources' | 'history';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'compare', label: 'Compare & decide' },
  { key: 'sources', label: 'Sources & quotes' },
  { key: 'history', label: 'Decision log' },
];

const VERDICT_STYLES: Record<Verdict, string> = {
  buy: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-400',
  borrow: 'bg-violet-100 text-violet-800 dark:bg-violet-500/10 dark:text-violet-400',
  internal: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400',
  none: 'bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-400',
};

const fieldClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
const primaryBtn =
  'focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40';
const secondaryBtn =
  'focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40';

// ---------- small helpers ----------

function dollarsToCents(v: string): number | null {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-bg-primary p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

// ============================================================
// SOURCE MODAL
// ============================================================

function SourceModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<SourceType>('distributor');
  const [phone, setPhone] = useState('');
  const [miles, setMiles] = useState('5');
  const [response, setResponse] = useState('20');
  const [reliability, setReliability] = useState('90');
  const [deliveryFee, setDeliveryFee] = useState('0');
  const [borrowPct, setBorrowPct] = useState('10');
  const [inKind, setInKind] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast('Give the source a name', 'error');
      return;
    }
    setSaving(true);
    try {
      await createMarketSource({
        name: name.trim(),
        source_type: type,
        phone: phone.trim() || null,
        distance_miles: Math.max(0, Number.parseFloat(miles) || 0),
        typical_response_minutes: Math.max(0, Math.round(Number.parseFloat(response) || 0)),
        reliability_score: Math.min(1, Math.max(0, (Number.parseFloat(reliability) || 0) / 100)),
        delivery_fee_cents: dollarsToCents(deliveryFee) ?? 0,
        borrow_fee_pct: type === 'contractor' ? Math.max(0, Number.parseFloat(borrowPct) || 0) : 0,
        return_in_kind: type === 'contractor' ? inKind : true,
      });
      toast('Source added', 'success');
      onSaved();
      onClose();
    } catch {
      toast('Could not add this source', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Add supply source" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type">
          <select className={fieldClass} value={type} onChange={(e) => setType(e.target.value as SourceType)}>
            {(Object.keys(SOURCE_TYPE_LABELS) as SourceType[]).map((t) => (
              <option key={t} value={t}>
                {SOURCE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Distance (miles)">
            <input className={fieldClass} inputMode="decimal" value={miles} onChange={(e) => setMiles(e.target.value)} />
          </Field>
          <Field label="Typical response (min)">
            <input className={fieldClass} inputMode="numeric" value={response} onChange={(e) => setResponse(e.target.value)} />
          </Field>
          <Field label="Reliability (%)">
            <input className={fieldClass} inputMode="numeric" value={reliability} onChange={(e) => setReliability(e.target.value)} />
          </Field>
          {type === 'contractor' ? (
            <Field label="Borrow fee (% of part value)">
              <input className={fieldClass} inputMode="decimal" value={borrowPct} onChange={(e) => setBorrowPct(e.target.value)} />
            </Field>
          ) : (
            <Field label="Delivery fee ($)">
              <input className={fieldClass} inputMode="decimal" value={deliveryFee} onChange={(e) => setDeliveryFee(e.target.value)} />
            </Field>
          )}
        </div>
        {type === 'contractor' && (
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={inKind} onChange={(e) => setInKind(e.target.checked)} />
            Borrowed parts are returned in kind (replacement cost + return trip counted)
          </label>
        )}
        <Field label="Phone (optional)">
          <input className={fieldClass} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add source
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ============================================================
// QUOTE MODAL
// ============================================================

function QuoteModal({
  part,
  sources,
  onClose,
  onSaved,
}: {
  part: MarketPart;
  sources: MarketSource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const active = sources.filter((s) => s.active);
  const [sourceId, setSourceId] = useState(active[0]?.id ?? '');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [eta, setEta] = useState('');
  const [fulfillment, setFulfillment] = useState<Fulfillment>('pickup');
  const [validHours, setValidHours] = useState('24');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const cents = dollarsToCents(price);
    const quantity = Math.max(0, Math.floor(Number.parseFloat(qty) || 0));
    if (!sourceId || cents === null) {
      toast('Choose a source and enter a valid price', 'error');
      return;
    }
    const hours = Number.parseFloat(validHours);
    setSaving(true);
    try {
      await upsertOffer({
        part_id: part.id,
        source_id: sourceId,
        unit_price_cents: cents,
        quantity_available: quantity,
        eta_minutes: eta.trim() === '' ? null : Math.max(0, Math.round(Number.parseFloat(eta) || 0)),
        fulfillment,
        expires_at: Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null,
      });
      toast('Quote saved', 'success');
      onSaved();
      onClose();
    } catch {
      toast('Could not save this quote', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={`Quote — ${part.name}`} onClose={onClose}>
      {active.length === 0 ? (
        <p className="text-sm text-text-secondary">Add a supply source first, then record its quote.</p>
      ) : (
        <div className="space-y-3">
          <Field label="Source">
            <select className={fieldClass} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {SOURCE_TYPE_LABELS[s.source_type]}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit price ($)">
              <input className={fieldClass} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label="Quantity available">
              <input className={fieldClass} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <Field label="ETA (min, blank = auto)">
              <input className={fieldClass} inputMode="numeric" value={eta} onChange={(e) => setEta(e.target.value)} />
            </Field>
            <Field label="Valid for (hours)">
              <input className={fieldClass} inputMode="decimal" value={validHours} onChange={(e) => setValidHours(e.target.value)} />
            </Field>
          </div>
          <Field label="Fulfillment">
            <select className={fieldClass} value={fulfillment} onChange={(e) => setFulfillment(e.target.value as Fulfillment)}>
              <option value="pickup">Pickup</option>
              <option value="delivery">Delivery</option>
              <option value="handoff">Handoff (contractor)</option>
            </select>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={secondaryBtn} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={primaryBtn} onClick={submit} disabled={saving}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save quote
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ============================================================
// CONFIRM MODAL
// ============================================================

function ConfirmModal({
  option,
  quantity,
  isOverride,
  busy,
  onCancel,
  onConfirm,
}: {
  option: MarketOption;
  quantity: number;
  isOverride: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const consequence: Record<MarketOption['action'], string> = {
    use_van_stock: 'No stock movement — the part is already on the technician’s van.',
    transfer_stock: 'An atomic stock transfer into the technician’s van will be posted to the inventory ledger.',
    buy_vendor: 'A purchase request will be created in Vendor & Procurement.',
    buy_distributor: 'A purchase request will be created in Vendor & Procurement.',
    borrow_contractor: 'The decision is recorded. Contact the contractor to arrange the handoff.',
  };
  return (
    <ModalShell title={`${ACTION_LABELS[option.action]} — ${option.label}`} onClose={onCancel}>
      <div className="space-y-3 text-sm text-text-secondary">
        <p>
          <span className="font-semibold text-text-primary">
            {quantity}× {option.partName}
          </span>{' '}
          · ETA {formatEta(option.etaMinutes)} · all-in expected{' '}
          <span className="font-semibold text-text-primary">{formatCents(option.expectedTotalCostCents)}</span>
        </p>
        <p>{consequence[option.action]}</p>
        {isOverride && (
          <p className="rounded-xl bg-amber-100 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-400">
            This differs from the engine’s recommendation and will be logged as an override.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={secondaryBtn} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Confirm
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ============================================================
// PAGE
// ============================================================

export function PartsMarketPage() {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [parts, setParts] = useState<MarketPart[]>([]);
  const [shortJobs, setShortJobs] = useState<ShortJobRow[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [decisions, setDecisions] = useState<MarketDecisionRow[]>([]);
  const [tab, setTab] = useState<TabKey>('compare');

  // request context
  const [partId, setPartId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [deadlineStr, setDeadlineStr] = useState('');
  const [vanId, setVanId] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [allowSubs, setAllowSubs] = useState(true);
  const [revisit, setRevisit] = useState('185');
  const [laborRate, setLaborRate] = useState('65');
  const [billable, setBillable] = useState('');

  // market input
  const [input, setInput] = useState<MarketInput | null>(null);
  const [inputLoading, setInputLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // modals
  const [showSource, setShowSource] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [confirming, setConfirming] = useState<MarketOption | null>(null);
  const [working, setWorking] = useState(false);

  const part = useMemo(() => parts.find((p) => p.id === partId) ?? null, [parts, partId]);

  const loadStatic = useCallback(async () => {
    try {
      const [p, j, s, d] = await Promise.all([
        fetchMarketParts(),
        fetchShortJobs(),
        fetchMarketSources(),
        fetchRecentDecisions(),
      ]);
      setParts(p);
      setShortJobs(j);
      setSources(s);
      setDecisions(d);
    } catch {
      toast('Could not load Parts Market data', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadStatic();
  }, [loadStatic]);

  // live market input for the selected part (+ substitutes)
  useEffect(() => {
    if (!part) {
      setInput(null);
      return;
    }
    let cancelled = false;
    setInputLoading(true);
    gatherMarketInput(part, parts)
      .then((res) => {
        if (cancelled) return;
        setInput(res);
        setUpdatedAt(new Date());
      })
      .catch(() => {
        if (!cancelled) toast('Could not load live supplier data', 'error');
      })
      .finally(() => {
        if (!cancelled) setInputLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [part, parts, tick, toast]);

  // realtime: any offer / stock change refreshes the market
  useEffect(
    () =>
      subscribeToMarket(() => {
        setTick((t) => t + 1);
        void fetchShortJobs().then(setShortJobs).catch(() => undefined);
      }),
    [],
  );

  const vans = useMemo(
    () => (input?.locations ?? []).filter((l) => l.location_type === 'van'),
    [input],
  );
  const van = vans.find((v) => v.id === vanId) ?? null;
  const qtyNum = Math.max(1, Math.floor(Number.parseFloat(quantity) || 1));

  const decision = useMemo(() => {
    if (!input) return null;
    return evaluateMarket(input, {
      quantity: qtyNum,
      deadline: deadlineStr ? new Date(deadlineStr) : null,
      technicianId: van?.assigned_technician_id ?? null,
      allowSubstitutes: allowSubs,
      revisitCostCents: dollarsToCents(revisit) ?? undefined,
      laborRateCentsPerHour: dollarsToCents(laborRate) ?? undefined,
      billableUnitPriceCents: billable.trim() === '' ? null : dollarsToCents(billable),
    });
  }, [input, qtyNum, deadlineStr, van, allowSubs, revisit, laborRate, billable]);

  const pickJob = (row: ShortJobRow) => {
    setPartId(row.part_id);
    setQuantity(String(Math.max(1, row.shortage_quantity)));
    setDeadlineStr(toLocalInput(row.scheduled_datetime));
    setJobId(row.job_id);
    setVanId('');
    setTab('compare');
  };

  // preselect the assigned technician's van once locations are known
  useEffect(() => {
    if (!jobId || vanId || !input) return;
    const job = shortJobs.find((j) => j.job_id === jobId);
    const match = vans.find((v) => v.assigned_technician_id && v.assigned_technician_id === job?.assigned_technician_id);
    if (match) setVanId(match.id);
  }, [jobId, vanId, input, vans, shortJobs]);

  const confirm = async () => {
    if (!confirming || !decision || !decision.recommended || !part) return;
    setWorking(true);
    try {
      const isOverride = confirming.key !== decision.recommended.key;
      const row = await recordDecision({ partId: part.id, jobId, decision });
      const msg = await executeOption({
        option: confirming,
        quantity: qtyNum,
        jobId,
        neededBy: deadlineStr ? new Date(deadlineStr) : null,
        destinationLocationId: van?.id ?? null,
      });
      if (row) await resolveDecision(row.id, isOverride ? 'overridden' : 'accepted', confirming);
      toast(msg, 'success');
      setConfirming(null);
      setTick((t) => t + 1);
      void loadStatic();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not complete this action', 'error');
    } finally {
      setWorking(false);
    }
  };

  const isOverride = !!(confirming && decision?.recommended && confirming.key !== decision.recommended.key);

  return (
    <DashboardLayout activeLabel="AI Parts Market">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Store size={22} /> AI Parts Market
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Where is this part right now, what does each source really cost all-in, and should we buy it,
              transfer it, or borrow it from a nearby contractor?
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary">
              <Radio size={12} className="text-emerald-500" />
              Live{updatedAt ? ` · ${updatedAt.toLocaleTimeString()}` : ''}
            </span>
            <button type="button" className={secondaryBtn} onClick={() => setTick((t) => t + 1)} disabled={inputLoading}>
              <RefreshCw size={13} className={inputLoading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${
                tab === t.key
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-text-secondary" size={22} />
          </div>
        ) : (
          <>
            {tab === 'compare' && (
              <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
                {/* ---- left: at-risk jobs + request ---- */}
                <div className="space-y-4">
                  <div className="rounded-2xl border border-border bg-bg-secondary p-3">
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      Jobs short on parts
                    </h2>
                    {shortJobs.length === 0 ? (
                      <p className="py-3 text-xs text-text-secondary">No upcoming job is short on parts.</p>
                    ) : (
                      <ul className="max-h-56 space-y-1.5 overflow-y-auto">
                        {shortJobs.map((j) => (
                          <li key={j.requirement_id}>
                            <button
                              type="button"
                              onClick={() => pickJob(j)}
                              className={`focus-ring w-full rounded-xl border p-2 text-left text-xs ${
                                jobId === j.job_id && partId === j.part_id
                                  ? 'border-accent bg-accent/10'
                                  : 'border-border hover:border-accent/50'
                              }`}
                            >
                              <span className="block font-semibold text-text-primary">{j.part_name}</span>
                              <span className="block text-text-secondary">
                                {j.customer_name} · short {j.shortage_quantity}
                                {j.scheduled_datetime ? ` · ${new Date(j.scheduled_datetime).toLocaleString()}` : ''}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Part request</h2>
                    <Field label="Part">
                      <select
                        className={fieldClass}
                        value={partId}
                        onChange={(e) => {
                          setPartId(e.target.value);
                          setJobId(null);
                          setVanId('');
                        }}
                      >
                        <option value="">Select a part…</option>
                        {parts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.part_number ? ` (${p.part_number})` : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Quantity">
                        <input className={fieldClass} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                      </Field>
                      <Field label="Technician van">
                        <select className={fieldClass} value={vanId} onChange={(e) => setVanId(e.target.value)}>
                          <option value="">None</option>
                          {vans.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <Field label="Needed by (appointment)">
                      <input type="datetime-local" className={fieldClass} value={deadlineStr} onChange={(e) => setDeadlineStr(e.target.value)} />
                    </Field>
                    <label className="flex items-center gap-2 text-xs text-text-secondary">
                      <input type="checkbox" checked={allowSubs} onChange={(e) => setAllowSubs(e.target.checked)} />
                      Consider approved substitutes
                    </label>
                    <details className="text-xs text-text-secondary">
                      <summary className="cursor-pointer font-medium">Cost model</summary>
                      <div className="mt-2 grid grid-cols-2 gap-3">
                        <Field label="Revisit cost ($)">
                          <input className={fieldClass} inputMode="decimal" value={revisit} onChange={(e) => setRevisit(e.target.value)} />
                        </Field>
                        <Field label="Labor ($/h)">
                          <input className={fieldClass} inputMode="decimal" value={laborRate} onChange={(e) => setLaborRate(e.target.value)} />
                        </Field>
                        <Field label="Billed per unit ($)">
                          <input className={fieldClass} inputMode="decimal" value={billable} onChange={(e) => setBillable(e.target.value)} placeholder="auto" />
                        </Field>
                      </div>
                    </details>
                  </div>
                </div>

                {/* ---- right: decision ---- */}
                <div className="min-w-0 space-y-4">
                  {!part && (
                    <p className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-text-secondary">
                      Select a job shortage or a part to compare every source in real time.
                    </p>
                  )}
                  {part && !decision && (
                    <div className="flex justify-center py-16">
                      <Loader2 className="animate-spin text-text-secondary" size={22} />
                    </div>
                  )}
                  {part && decision && (
                    <>
                      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${VERDICT_STYLES[decision.buyVsBorrow.verdict]}`}>
                              {VERDICT_LABELS[decision.buyVsBorrow.verdict]}
                            </span>
                            <p className="mt-2 text-base font-semibold text-text-primary">{decision.buyVsBorrow.headline}</p>
                          </div>
                          <div className="text-right text-xs text-text-secondary">
                            <p>Confidence</p>
                            <p className="text-lg font-bold text-text-primary">{Math.round(decision.confidence * 100)}%</p>
                          </div>
                        </div>
                        <ul className="mt-3 space-y-1 text-xs leading-relaxed text-text-secondary">
                          {decision.rationale.map((r) => (
                            <li key={r}>• {r}</li>
                          ))}
                        </ul>
                        {decision.recommended && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" className={primaryBtn} onClick={() => decision.recommended && setConfirming(decision.recommended)}>
                              <Check size={13} /> {ACTION_LABELS[decision.recommended.action]} — {decision.recommended.label}
                            </button>
                            <button type="button" className={secondaryBtn} onClick={() => setShowQuote(true)}>
                              <Plus size={13} /> Add quote
                            </button>
                          </div>
                        )}
                        {!decision.recommended && (
                          <button type="button" className={`${secondaryBtn} mt-3`} onClick={() => setShowQuote(true)}>
                            <Plus size={13} /> Add quote
                          </button>
                        )}
                      </div>

                      {/* three paths */}
                      <div className="grid gap-3 sm:grid-cols-3">
                        {(
                          [
                            { title: 'Own stock', icon: Package, opt: decision.buyVsBorrow.bestInternal },
                            { title: 'Buy', icon: Truck, opt: decision.buyVsBorrow.bestBuy },
                            { title: 'Borrow', icon: Handshake, opt: decision.buyVsBorrow.bestBorrow },
                          ] as const
                        ).map(({ title, icon: Icon, opt }) => (
                          <div
                            key={title}
                            className={`rounded-2xl border p-3 ${opt && opt.key === decision.recommended?.key ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}
                          >
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
                              <Icon size={13} /> {title}
                            </p>
                            {opt ? (
                              <>
                                <p className="mt-1 text-sm font-semibold text-text-primary">{opt.label}</p>
                                <p className="text-xs text-text-secondary">
                                  {formatCents(opt.expectedTotalCostCents)} all-in · {formatEta(opt.etaMinutes)}
                                </p>
                              </>
                            ) : (
                              <p className="mt-1 text-xs text-text-secondary">No source covers {decision.quantity} units.</p>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* ranked table */}
                      <div className="overflow-x-auto rounded-2xl border border-border">
                        <table className="w-full min-w-[820px] text-left text-xs">
                          <thead className="bg-bg-secondary text-text-secondary">
                            <tr>
                              {['#', 'Source', 'Part', 'Unit', 'Qty', 'ETA', 'On time', 'All-in', 'Margin erosion', 'Fresh', ''].map((h) => (
                                <th key={h} scope="col" className="px-3 py-2 font-medium">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {decision.options.length === 0 && (
                              <tr>
                                <td colSpan={11} className="px-3 py-8 text-center text-text-secondary">
                                  No sources yet. Add a supply source and record a quote to build the market.
                                </td>
                              </tr>
                            )}
                            {decision.options.map((o) => (
                              <tr key={o.key} className={`border-t border-border ${o.meetsQuantity ? '' : 'opacity-60'}`}>
                                <td className="px-3 py-2 text-text-secondary">{o.rank ?? '—'}</td>
                                <td className="px-3 py-2">
                                  <p className="font-semibold text-text-primary">{o.label}</p>
                                  <p className="text-text-secondary">{OPTION_KIND_LABELS[o.kind]}</p>
                                  {o.flags.map((f) => (
                                    <p key={f} className="text-[11px] text-amber-700 dark:text-amber-400">
                                      {f}
                                    </p>
                                  ))}
                                </td>
                                <td className="px-3 py-2 text-text-secondary">
                                  {o.partName}
                                  {o.isSubstitute && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] dark:bg-slate-500/10">SUB</span>}
                                </td>
                                <td className="px-3 py-2">{formatCents(o.unitPriceCents)}</td>
                                <td className="px-3 py-2">{o.quantityAvailable}</td>
                                <td className="px-3 py-2">
                                  <span className="flex items-center gap-1">
                                    <Clock size={11} /> {formatEta(o.etaMinutes)}
                                  </span>
                                </td>
                                <td className="px-3 py-2">{Math.round(o.onTimeProbability * 100)}%</td>
                                <td className="px-3 py-2 font-semibold text-text-primary">{formatCents(o.expectedTotalCostCents)}</td>
                                <td className={`px-3 py-2 ${o.marginErosionCents > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                  {formatCents(o.marginErosionCents)}
                                </td>
                                <td className="px-3 py-2 text-text-secondary">{formatAge(o.freshnessMinutes)}</td>
                                <td className="px-3 py-2 text-right">
                                  <div className="flex justify-end gap-1.5">
                                    {o.phone && (
                                      <a
                                        href={`tel:${o.phone}`}
                                        aria-label={`Call ${o.label}`}
                                        className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary"
                                      >
                                        <Phone size={12} />
                                      </a>
                                    )}
                                    {o.meetsQuantity && (
                                      <button type="button" className={secondaryBtn} onClick={() => setConfirming(o)}>
                                        Choose
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {decision.splitPlan && (
                        <p className="rounded-xl bg-sky-100 p-3 text-xs text-sky-800 dark:bg-sky-500/10 dark:text-sky-400">
                          Split plan: {decision.splitPlan.map((s) => `${s.quantity}× ${s.label}`).join(' + ')}
                        </p>
                      )}
                      {decision.excluded.length > 0 && (
                        <p className="text-xs text-text-secondary">
                          Excluded: {decision.excluded.map((e) => `${e.label} (${e.reason})`).join(' · ')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === 'sources' && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button type="button" className={primaryBtn} onClick={() => setShowSource(true)}>
                    <Plus size={13} /> Supply source
                  </button>
                  <button type="button" className={secondaryBtn} onClick={() => setShowQuote(true)} disabled={!part}>
                    <Plus size={13} /> Quote{part ? ` for ${part.name}` : ''}
                  </button>
                </div>
                {sources.length === 0 && (
                  <p className="py-10 text-center text-sm text-text-secondary">
                    No supply sources yet. Add vendors, local distributors and trusted nearby contractors.
                  </p>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {sources.map((s) => (
                    <div key={s.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                      <p className="text-sm font-semibold text-text-primary">{s.name}</p>
                      <p className="text-xs text-text-secondary">
                        {SOURCE_TYPE_LABELS[s.source_type]} · {s.distance_miles} mi · responds in {s.typical_response_minutes} min ·{' '}
                        {Math.round(s.reliability_score * 100)}% reliable
                        {s.source_type === 'contractor' ? ` · ${s.borrow_fee_pct}% borrow fee` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'history' && (
              <div className="space-y-2">
                {decisions.length === 0 && (
                  <p className="py-10 text-center text-sm text-text-secondary">No decisions recorded yet.</p>
                )}
                {decisions.map((d) => (
                  <div key={d.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-text-primary">
                        {d.quantity}× {parts.find((p) => p.id === d.part_id)?.name ?? 'Part'} — {d.chosen_label ?? d.recommended_label}
                      </p>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${VERDICT_STYLES[d.verdict]}`}>
                        {VERDICT_LABELS[d.verdict]} · {d.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {new Date(d.created_at).toLocaleString()} · expected {formatCents(d.expected_total_cost_cents)} · confidence{' '}
                      {Math.round(d.confidence * 100)}%
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {showSource && <SourceModal onClose={() => setShowSource(false)} onSaved={() => void loadStatic()} />}
      {showQuote && part && (
        <QuoteModal part={part} sources={sources} onClose={() => setShowQuote(false)} onSaved={() => setTick((t) => t + 1)} />
      )}
      {confirming && (
        <ConfirmModal
          option={confirming}
          quantity={qtyNum}
          isOverride={isOverride}
          busy={working}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </DashboardLayout>
  );
}
