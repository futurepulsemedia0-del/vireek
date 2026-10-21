import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink, Loader2, PackageSearch, ShoppingCart, Truck, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { JobSection, Pill } from '@/components/jobs/detail/JobSection';
import { receivePurchaseOrder, setPurchaseOrderStatus } from '@/lib/truckStock';
import {
  addToCart,
  createOrdersFromCart,
  getJobPartsOrders,
  listCart,
  listLocations,
  removeFromCart,
  searchSupplierCatalog,
  setCartQuantity,
  updateShipment,
  type LocationOption,
} from '@/lib/partsOrderingApi';
import {
  SHIPMENT_LABEL,
  SHIPMENT_STATUSES,
  clampQty,
  deliveryState,
  formatEta,
  formatMoney,
  groupCartByVendor,
  holdMessage,
  jobPartsHeadline,
  lineIsOrderable,
  priceDelta,
  roundOrderQty,
  safeTrackingUrl,
  stockBadge,
  type CartLine,
  type CatalogHit,
  type DeliveryTone,
  type JobPartOrder,
} from '@/lib/partsOrdering';

const TONE: Record<DeliveryTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-blue-500/10 text-blue-500',
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
};

const CLOSED = new Set(['completed', 'cancelled', 'no_show']);
const WORKFLOW = new Set(['on_hold', 'waiting_on_parts', 'waiting_on_customer', 'needs_follow_up', 'return_visit_needed']);
const SEARCH_DELAY_MS = 300;

export interface JobPartsOrderingPanelProps {
  job: { id: string; customer_name: string; job_status: string; assigned_technician_id: string | null };
  /** Owner / admin: may place, approve, receive and track purchase orders. */
  canManage: boolean;
  /** May add parts to the job's order list. */
  canEdit: boolean;
  /** Called after anything that can change the job (hold, resume, requirements). */
  onChanged: () => void;
}

/**
 * Parts & ordering for one job: search supplier catalogs, add to the job or a truck, create purchase
 * orders, follow delivery, and let receiving release the job automatically (database trigger).
 */
export function JobPartsOrderingPanel({ job, canManage, canEdit, onChanged }: JobPartsOrderingPanelProps) {
  const { toast } = useToast();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<JobPartOrder[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [query, setQuery] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [hits, setHits] = useState<CatalogHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [truckId, setTruckId] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [holdJob, setHoldJob] = useState(true);
  const [poNote, setPoNote] = useState('');
  const [trackingFor, setTrackingFor] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const jobClosed = CLOSED.has(job.job_status);
  const holdAllowed = !jobClosed && !WORKFLOW.has(job.job_status);
  const vans = useMemo(() => locations.filter((l) => l.location_type === 'van'), [locations]);
  const techVan = useMemo(() => vans.find((v) => v.assigned_technician_id && v.assigned_technician_id === job.assigned_technician_id), [vans, job.assigned_technician_id]);

  const load = useCallback(async () => {
    try {
      const [c, o, l] = await Promise.all([listCart(job.id), getJobPartsOrders(job.id), listLocations()]);
      setCart(c);
      setOrders(o);
      setLocations(l);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [job.id]);

  useEffect(() => void load(), [load]);
  useEffect(() => setTruckId((cur) => cur || techVan?.id || vans[0]?.id || ''), [techVan, vans]);
  useEffect(() => setHoldJob(holdAllowed), [holdAllowed]);

  // Debounced search; stale responses are dropped.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchSupplierCatalog(q, { inStockOnly })
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setHits(r);
          setSearchError(null);
        })
        .catch((e: Error) => {
          if (seq !== searchSeq.current) return;
          setSearchError(e.message);
          setHits(null);
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [query, inStockOnly]);

  async function run(key: string, fn: () => Promise<void>, errorFallback: string) {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : errorFallback, 'error');
    } finally {
      setBusyKey(null);
    }
  }

  const qtyFor = (h: CatalogHit) => clampQty(qtyById[h.id] ?? '1');

  function add(h: CatalogHit, target: 'job' | 'truck') {
    if (target === 'truck' && !truckId) return void toast('Choose a truck first', 'error');
    void run(`add-${target}-${h.id}`, async () => {
      await addToCart({
        catalogItemId: h.id,
        quantity: qtyFor(h),
        jobId: job.id,
        destinationLocationId: target === 'truck' ? truckId : null,
        addRequirement: target === 'job',
      });
      const rounded = roundOrderQty(qtyFor(h), h.min_order_qty, h.pack_size);
      toast(`${h.name} × ${rounded} added to this job's order list${rounded !== qtyFor(h) ? ' (rounded to the supplier pack)' : ''}`, 'success');
      await load();
      if (target === 'job') onChanged();
    }, 'Could not add this part.');
  }

  function changeQty(line: CartLine, raw: string) {
    const next = clampQty(raw);
    if (next === line.quantity) return;
    void run(`qty-${line.id}`, async () => {
      await setCartQuantity(line.id, next);
      await load();
    }, 'Could not update the quantity.');
  }

  function removeLine(line: CartLine) {
    void run(`rm-${line.id}`, async () => {
      await removeFromCart(line.id);
      await load();
    }, 'Could not remove this line.');
  }

  function placeOrders() {
    void run('order', async () => {
      const res = await createOrdersFromCart({ jobId: job.id, holdJob: holdJob && holdAllowed, notes: poNote });
      const n = res.orders.length;
      const pending = res.orders.filter((o) => o.status === 'pending_approval').length;
      toast(`${n} purchase order${n === 1 ? '' : 's'} created${pending ? ` (${pending} need approval)` : ''}`, 'success');
      const msg = holdMessage(res);
      if (msg) toast(msg, 'info');
      if (res.skipped.length) toast(`${res.skipped.length} unavailable item(s) were left in the list`, 'error');
      setPoNote('');
      await load();
      onChanged();
    }, 'Could not create the purchase order.');
  }

  function sendOrder(poId: string) {
    void run(`send-${poId}`, async () => {
      await setPurchaseOrderStatus(poId, 'sent');
      toast('Order marked as sent', 'success');
      await load();
    }, 'Could not send the order.');
  }

  function receiveOrder(poId: string) {
    void run(`recv-${poId}`, async () => {
      const res = await receivePurchaseOrder(poId);
      const status = (res as { status?: string }).status;
      if (status === 'received' || status === 'partially_received') {
        toast(status === 'received' ? 'Order received — stock updated' : 'Partly received — stock updated', 'success');
      } else {
        toast(status === 'not_receivable' ? 'Send the order before receiving it' : 'Nothing was received', 'error');
      }
      await load();
      onChanged();
    }, 'Could not receive the order.');
  }

  const groups = useMemo(() => groupCartByVendor(cart), [cart]);
  const orderable = cart.filter(lineIsOrderable);
  const headline = jobPartsHeadline(orders);
  const ordersByPo = useMemo(() => {
    const map = new Map<string, JobPartOrder[]>();
    for (const o of orders) map.set(o.purchase_order_id, [...(map.get(o.purchase_order_id) ?? []), o]);
    return [...map.values()];
  }, [orders]);

  return (
    <JobSection
      title="Order parts"
      icon={ShoppingCart}
      action={
        headline.open > 0 ? (
          <Pill className={TONE.info}>Parts expected {formatEta(headline.eta)}</Pill>
        ) : headline.allReceived ? (
          <Pill className={TONE.success}>All parts received</Pill>
        ) : undefined
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading parts orders…
        </div>
      ) : loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>Could not load parts orders.</span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          {ordersByPo.length > 0 && (
            <div className="space-y-2" aria-label="Orders for this job">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">On order</h3>
              {ordersByPo.map((lines) => {
                const first = lines[0];
                const st = deliveryState({ ...first, quantity_ordered: sum(lines, 'quantity_ordered'), quantity_received: sum(lines, 'quantity_received') });
                const link = safeTrackingUrl(first.tracking_url);
                return (
                  <div key={first.purchase_order_id} className="rounded-xl border border-border bg-bg-primary p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">
                          {first.po_number} <span className="font-normal text-text-secondary">· {first.vendor_name ?? 'Supplier'}</span>
                        </p>
                        <p className="text-xs text-text-secondary">
                          {first.po_status === 'received' ? 'Received' : `ETA ${formatEta(first.expected_at)}`}
                          {first.carrier ? ` · ${first.carrier}` : ''}
                          {first.shipment_status !== 'not_shipped' ? ` · ${SHIPMENT_LABEL[first.shipment_status]}` : ''}
                        </p>
                      </div>
                      <Pill className={TONE[st.tone]}>{st.label}</Pill>
                    </div>
                    <ul className="mt-2 space-y-1 text-sm">
                      {lines.map((l) => (
                        <li key={l.po_line_id} className="flex justify-between gap-2">
                          <span className="min-w-0 truncate text-text-primary">
                            {l.part_name} <span className="text-text-secondary">× {l.job_quantity}</span>
                          </span>
                          <span className="shrink-0 text-xs text-text-secondary">
                            {l.quantity_received}/{l.quantity_ordered} received
                          </span>
                        </li>
                      ))}
                    </ul>
                    {(link || first.tracking_number) && (
                      <p className="mt-2 text-xs text-text-secondary">
                        Tracking:{' '}
                        {link ? (
                          <a href={link} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-1 font-medium text-accent hover:underline">
                            {first.tracking_number ?? 'Track package'} <ExternalLink size={11} aria-hidden="true" />
                          </a>
                        ) : (
                          first.tracking_number
                        )}
                      </p>
                    )}
                    {canManage && st.action && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {st.action === 'approve_send' && (
                          <Button size="sm" disabled={busyKey === `send-${first.purchase_order_id}`} onClick={() => sendOrder(first.purchase_order_id)}>
                            {first.po_status === 'pending_approval' ? 'Approve & send' : 'Mark as sent'}
                          </Button>
                        )}
                        {(st.action === 'receive' || st.action === 'track') && first.po_status !== 'draft' && (
                          <Button size="sm" disabled={busyKey === `recv-${first.purchase_order_id}`} onClick={() => receiveOrder(first.purchase_order_id)}>
                            Receive order
                          </Button>
                        )}
                        {first.po_status !== 'draft' && first.po_status !== 'pending_approval' && (
                          <Button variant="secondary" size="sm" onClick={() => setTrackingFor(trackingFor === first.purchase_order_id ? null : first.purchase_order_id)}>
                            Update delivery
                          </Button>
                        )}
                      </div>
                    )}
                    {trackingFor === first.purchase_order_id && (
                      <ShipmentForm
                        order={first}
                        onDone={async () => {
                          setTrackingFor(null);
                          await load();
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {cart.length > 0 && (
            <div className="space-y-2" aria-label="Order list">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Order list</h3>
              {groups.map((g) => (
                <div key={g.vendorId} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-text-primary">{g.vendorName}</p>
                    <p className="text-sm font-semibold text-text-primary">{formatMoney(g.totalCents)}</p>
                  </div>
                  <ul className="space-y-2">
                    {g.lines.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-text-primary">{l.item?.name}</p>
                          <p className="text-xs text-text-secondary">
                            {l.item?.sku} · {l.item ? formatMoney(l.item.unit_cost_cents) : ''} each
                            {l.destination_location_id ? ` · to ${locations.find((x) => x.id === l.destination_location_id)?.name ?? 'truck'}` : ''}
                            {!lineIsOrderable(l) ? ' · unavailable' : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="sr-only" htmlFor={`cart-qty-${l.id}`}>
                            Quantity for {l.item?.name}
                          </label>
                          <input
                            id={`cart-qty-${l.id}`}
                            key={`${l.id}-${l.quantity}`}
                            type="number"
                            min={1}
                            max={100000}
                            defaultValue={l.quantity}
                            disabled={!canEdit || busyKey === `qty-${l.id}`}
                            onBlur={(e) => changeQty(l, e.target.value)}
                            className="focus-ring w-20 rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-sm text-text-primary"
                          />
                          {canEdit && (
                            <button
                              type="button"
                              aria-label={`Remove ${l.item?.name ?? 'line'}`}
                              onClick={() => removeLine(l)}
                              disabled={busyKey === `rm-${l.id}`}
                              className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger"
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {canManage ? (
                <div className="space-y-2">
                  {holdAllowed && (
                    <label className="flex items-start gap-2 text-sm text-text-primary">
                      <input type="checkbox" checked={holdJob} onChange={(e) => setHoldJob(e.target.checked)} className="mt-1" />
                      <span>
                        Put this job on “Waiting on parts” until they arrive
                        <span className="block text-xs text-text-secondary">It resumes automatically when the order is received. The time slot is released meanwhile.</span>
                      </span>
                    </label>
                  )}
                  <label className="block text-xs font-medium text-text-secondary" htmlFor="po-note">
                    Note for the order (optional)
                  </label>
                  <input
                    id="po-note"
                    value={poNote}
                    maxLength={500}
                    onChange={(e) => setPoNote(e.target.value)}
                    className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
                  />
                  <Button disabled={orderable.length === 0 || busyKey === 'order'} onClick={placeOrders}>
                    {busyKey === 'order' ? 'Creating…' : `Create purchase order${groups.length > 1 ? 's' : ''}`}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-text-secondary">A manager will review this list and place the order.</p>
              )}
            </div>
          )}

          {canEdit && !jobClosed && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Find parts</h3>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-[200px] flex-1">
                  <label className="sr-only" htmlFor="parts-search">
                    Search supplier catalogs
                  </label>
                  <input
                    id="parts-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, SKU or manufacturer #"
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} /> In stock only
                </label>
                {vans.length > 0 && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="truck-pick" className="text-sm text-text-secondary">
                      Truck
                    </label>
                    <select
                      id="truck-pick"
                      value={truckId}
                      onChange={(e) => setTruckId(e.target.value)}
                      className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-2 text-sm text-text-primary"
                    >
                      {vans.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div aria-live="polite" className="text-xs text-text-secondary">
                {searching ? 'Searching…' : hits ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : ''}
              </div>
              {searchError && (
                <div role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                  {searchError}
                </div>
              )}
              {hits && hits.length === 0 && !searching && (
                <EmptyHint icon={<PackageSearch size={18} aria-hidden="true" />}>
                  No supplier items match “{query.trim()}”. Import a supplier price list on the Supplier catalog page.
                </EmptyHint>
              )}
              {hits && hits.length > 0 && (
                <ul className="space-y-2">
                  {hits.map((h) => (
                    <HitRow
                      key={h.id}
                      hit={h}
                      qty={qtyById[h.id] ?? '1'}
                      onQty={(v) => setQtyById((m) => ({ ...m, [h.id]: v }))}
                      busy={busyKey?.endsWith(h.id) ?? false}
                      canTruck={vans.length > 0}
                      onAdd={add}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </JobSection>
  );
}

function sum(rows: JobPartOrder[], key: 'quantity_ordered' | 'quantity_received'): number {
  return rows.reduce((s, r) => s + r[key], 0);
}

function EmptyHint({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-border p-3 text-sm text-text-secondary">
      <span className="mt-0.5">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function HitRow({
  hit,
  qty,
  onQty,
  busy,
  canTruck,
  onAdd,
}: {
  hit: CatalogHit;
  qty: string;
  onQty: (v: string) => void;
  busy: boolean;
  canTruck: boolean;
  onAdd: (h: CatalogHit, target: 'job' | 'truck') => void;
}) {
  const stock = stockBadge(hit.stock_status);
  const delta = priceDelta(hit.unit_cost_cents, hit.prev_cost_cents);
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{hit.name}</p>
          <p className="text-xs text-text-secondary">
            {hit.vendor_name} · {hit.sku}
            {hit.brand ? ` · ${hit.brand}` : ''}
            {hit.lead_time_days != null ? ` · ${hit.lead_time_days}d lead` : ''}
            {hit.on_hand > 0 ? ` · ${hit.on_hand} on hand` : ''}
          </p>
          {(hit.min_order_qty > 1 || hit.pack_size > 1) && (
            <p className="text-xs text-text-secondary">
              {hit.min_order_qty > 1 ? `Min ${hit.min_order_qty}` : ''}
              {hit.min_order_qty > 1 && hit.pack_size > 1 ? ' · ' : ''}
              {hit.pack_size > 1 ? `Sold in packs of ${hit.pack_size}` : ''}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-text-primary">{formatMoney(hit.unit_cost_cents)}</p>
          <div className="mt-1 flex flex-wrap justify-end gap-1">
            <Pill className={TONE[stock.tone]}>{stock.label}</Pill>
            {hit.is_best_price && <Pill className={TONE.success}>Best price</Pill>}
            {delta && delta.direction !== 'same' && (
              <Pill className={delta.direction === 'up' ? TONE.danger : TONE.success}>
                {delta.direction === 'up' ? '▲' : '▼'} {delta.percent}%
              </Pill>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`qty-${hit.id}`}>
          Quantity for {hit.name}
        </label>
        <input
          id={`qty-${hit.id}`}
          type="number"
          min={1}
          max={100000}
          value={qty}
          onChange={(e) => onQty(e.target.value)}
          className="focus-ring w-20 rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-sm text-text-primary"
        />
        <Button size="sm" disabled={busy} onClick={() => onAdd(hit, 'job')}>
          Add to job
        </Button>
        {canTruck && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAdd(hit, 'truck')}>
            <Truck size={14} aria-hidden="true" /> Add to truck
          </Button>
        )}
      </div>
    </li>
  );
}

function ShipmentForm({ order, onDone }: { order: JobPartOrder; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [carrier, setCarrier] = useState(order.carrier ?? '');
  const [number, setNumber] = useState(order.tracking_number ?? '');
  const [url, setUrl] = useState(order.tracking_url ?? '');
  const [status, setStatus] = useState(order.shipment_status);
  const [eta, setEta] = useState(order.expected_at ?? '');
  const [saving, setSaving] = useState(false);
  const urlBad = url.trim() !== '' && !safeTrackingUrl(url.trim());

  async function save() {
    if (urlBad) return;
    setSaving(true);
    try {
      await updateShipment({
        poId: order.purchase_order_id,
        carrier: carrier.trim(),
        trackingNumber: number.trim(),
        trackingUrl: url.trim(),
        shipmentStatus: status,
        expectedAt: eta || null,
      });
      toast('Delivery details saved', 'success');
      await onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save delivery details.', 'error');
    } finally {
      setSaving(false);
    }
  }

  const field = 'focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';
  const id = order.purchase_order_id;
  return (
    <form
      className="mt-3 grid gap-3 rounded-xl bg-bg-secondary p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor={`car-${id}`}>Carrier</label>
        <input id={`car-${id}`} className={field} value={carrier} maxLength={80} onChange={(e) => setCarrier(e.target.value)} />
      </div>
      <div>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor={`trk-${id}`}>Tracking number</label>
        <input id={`trk-${id}`} className={field} value={number} maxLength={120} onChange={(e) => setNumber(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <label className="mb-1 block text-xs text-text-secondary" htmlFor={`url-${id}`}>Tracking link</label>
        <input id={`url-${id}`} className={field} value={url} maxLength={500} inputMode="url" placeholder="https://" onChange={(e) => setUrl(e.target.value)} aria-invalid={urlBad} />
        {urlBad && <p role="alert" className="mt-1 text-xs text-danger">Link must start with http:// or https://</p>}
      </div>
      <div>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor={`sts-${id}`}>Shipment status</label>
        <select id={`sts-${id}`} className={field} value={status} onChange={(e) => setStatus(e.target.value as JobPartOrder['shipment_status'])}>
          {SHIPMENT_STATUSES.map((s) => (
            <option key={s} value={s}>{SHIPMENT_LABEL[s]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor={`eta-${id}`}>Expected delivery</label>
        <input id={`eta-${id}`} type="date" className={field} value={eta} onChange={(e) => setEta(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={saving || urlBad}>
          {saving ? 'Saving…' : 'Save delivery details'}
        </Button>
      </div>
    </form>
  );
}
