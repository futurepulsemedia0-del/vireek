/**
 * Procurement Network — /dashboard/procurement-network
 *
 * Opt-in group purchasing. Orders are routed into the existing Purchase Orders flow
 * (/dashboard/procurement): approve the PO there and the supplier receives the order;
 * receiving the PO there updates inventory and marks the network order delivered.
 *
 * Logic: src/lib/procurementNetwork.ts (pure, tested). Data: procurementNetworkApi.ts.
 * Tenant isolation: only aggregated pool numbers (3+ tenants) are ever shown.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Handshake, Loader2, RefreshCw, ShieldCheck, TrendingUp, Users } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid } from '@/components/Skeleton';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  REBATE_KIND_LABELS,
  bpsToPercent,
  buyerCanCancel,
  daysLeft,
  formatMoney,
  previewCart,
  summarizeSavings,
  tierProgress,
  unitPriceAt,
  validateShipTo,
  MIN_COHORT,
} from '@/lib/procurementNetwork';
import type {
  NetworkOrder,
  NetworkOrderLine,
  OrderSavingsRow,
  ProgramDetail,
  ProgramSummary,
  Rebate,
  ShipTo,
} from '@/lib/procurementNetwork';
import {
  approveOrder,
  cancelOrder,
  errorMessage,
  fetchInventoryPartsLite,
  fetchMembership,
  fetchMyOrders,
  fetchMyRebates,
  fetchOrderLines,
  fetchOrderSavings,
  getProgramDetail,
  joinNetwork,
  leaveNetwork,
  linkPart,
  listPrograms,
  placeOrder,
  setCommitment,
  unlinkPart,
} from '@/lib/procurementNetworkApi';
import type { InventoryPartLite, Membership } from '@/lib/procurementNetworkApi';

const fieldClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-5';

type Tab = 'overview' | 'programs' | 'orders' | 'rebates' | 'settings';

const EMPTY_SHIP: ShipTo = { name: '', contact: '', phone: '', line1: '', line2: '', city: '', region: '', postal_code: '', country: '' };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={cardClass}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function TierBar({ program }: { program: Pick<ProgramSummary, 'pool' | 'tiers'> }) {
  const p = tierProgress(program.pool, program.tiers);
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>
          Current tier: <strong className="text-text-primary">{p.currentLabel ?? '-'}</strong>
        </span>
        {p.nextLabel && <span>Next: {p.nextLabel}</span>}
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={p.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${p.percent ?? 0}%` }} />
      </div>
      <p className="mt-1 text-xs text-text-secondary">
        {p.hidden
          ? `Pool is forming - totals appear once ${MIN_COHORT}+ businesses have joined this program.`
          : p.gapCents !== null && p.nextLabel
            ? `${formatMoney(p.gapCents)} more pooled volume unlocks ${p.nextLabel}. You get the better price back as a rebate at close.`
            : 'Top tier unlocked.'}
      </p>
    </div>
  );
}

export function ProcurementNetworkPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [orders, setOrders] = useState<NetworkOrder[]>([]);
  const [savingsRows, setSavingsRows] = useState<OrderSavingsRow[]>([]);
  const [rebates, setRebates] = useState<Rebate[]>([]);
  const [openProgram, setOpenProgram] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const m = await fetchMembership();
      setMembership(m && m.status === 'active' ? m : null);
      if (m && m.status === 'active') {
        const [p, o, s, r] = await Promise.all([listPrograms(), fetchMyOrders(), fetchOrderSavings(), fetchMyRebates()]);
        setPrograms(p);
        setOrders(o);
        setSavingsRows(s);
        setRebates(r);
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not load the Procurement Network'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeSavings(savingsRows, rebates), [savingsRows, rebates]);
  const programStatus = useMemo(() => new Map(programs.map((p) => [p.id, p.status])), [programs]);
  const supplierNames = useMemo(() => new Map(orders.map((o) => [o.supplier_id, o.supplier_name ?? 'Supplier'])), [orders]);

  return (
    <DashboardLayout activeLabel="Procurement Network">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Handshake size={22} /> Procurement Network
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Buy together with other businesses to unlock volume pricing. Only aggregated volumes are shared - never your orders, prices or customers.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/dashboard/procurement" className="text-sm text-accent hover:underline">
              Purchase orders
            </Link>
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {loading && !membership ? (
          <SkeletonStatGrid count={4} />
        ) : !membership ? (
          <JoinCard onJoined={load} />
        ) : (
          <>
            <div className="mb-6 flex flex-wrap gap-1 border-b border-border" role="tablist">
              {(['overview', 'programs', 'orders', 'rebates', 'settings'] as Tab[]).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${tab === t ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <div className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Total savings" value={formatMoney(summary.totalSavingsCents)} hint={summary.savingsPercent === null ? undefined : `${summary.savingsPercent}% vs your previous prices`} />
                  <Stat label="Spent via network" value={formatMoney(summary.paidCents)} hint={`${summary.orders} orders`} />
                  <Stat label="Instant savings" value={formatMoney(summary.instantSavingsCents)} hint="vs last price paid, or list" />
                  <Stat label="Rebates" value={formatMoney(summary.rebatesAccruedCents + summary.rebatesPaidCents)} hint={`${formatMoney(summary.rebatesPaidCents)} paid`} />
                </div>
                {summary.orders === 0 ? (
                  <EmptyState icon={TrendingUp} title="No savings yet" description="Place your first network order to start tracking savings." action={{ label: 'Browse programs', onClick: () => setTab('programs') }} />
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className={cardClass}>
                      <h2 className="mb-3 text-sm font-semibold text-text-primary">By month</h2>
                      <table className="w-full text-sm">
                        <tbody>
                          {summary.byMonth.map((m) => (
                            <tr key={m.month} className="border-t border-border first:border-0">
                              <td className="py-2 text-text-secondary">{m.month}</td>
                              <td className="py-2 text-right text-text-primary">{formatMoney(m.paidCents)}</td>
                              <td className={`py-2 text-right font-medium ${m.savingsCents >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{formatMoney(m.savingsCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className={cardClass}>
                      <h2 className="mb-3 text-sm font-semibold text-text-primary">By supplier</h2>
                      <table className="w-full text-sm">
                        <tbody>
                          {summary.bySupplier.map((s) => (
                            <tr key={s.supplierId} className="border-t border-border first:border-0">
                              <td className="py-2 text-text-secondary">{supplierNames.get(s.supplierId) ?? 'Supplier'}</td>
                              <td className="py-2 text-right text-text-primary">{formatMoney(s.paidCents)}</td>
                              <td className={`py-2 text-right font-medium ${s.savingsCents >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{formatMoney(s.savingsCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'programs' &&
              (openProgram ? (
                <ProgramPanel
                  programId={openProgram}
                  onBack={() => setOpenProgram(null)}
                  onOrdered={async () => {
                    setOpenProgram(null);
                    setTab('orders');
                    await load();
                  }}
                />
              ) : programs.length === 0 ? (
                <EmptyState icon={Users} title="No programs available yet" description="Approved suppliers publish group-buying programs here. Check back soon." />
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {programs.map((p) => (
                    <div key={p.id} className={cardClass}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-text-primary">{p.title}</h3>
                          <p className="text-xs text-text-secondary">
                            {p.supplier_name}
                            {p.category ? ` - ${p.category}` : ''}
                          </p>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.status === 'open' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-bg-tertiary text-text-secondary'}`}>
                          {p.status === 'open' ? `${daysLeft(p.ends_on)}d left` : 'Closed'}
                        </span>
                      </div>
                      {p.description && <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{p.description}</p>}
                      <div className="mt-4">
                        <TierBar program={p} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-4 text-xs text-text-secondary">
                        {p.pool?.cohort_visible && <span>{p.pool.participants} businesses</span>}
                        {p.bonus_rebate_bps > 0 && <span>+{bpsToPercent(p.bonus_rebate_bps)} bonus rebate</span>}
                        {p.my_ordered_cents > 0 && <span>You ordered {formatMoney(p.my_ordered_cents)}</span>}
                      </div>
                      <div className="mt-4 flex items-center justify-between">
                        {!p.eligible ? <span className="text-xs text-amber-600">Not available in your region</span> : <span />}
                        <Button size="sm" onClick={() => setOpenProgram(p.id)} disabled={!p.eligible && p.status === 'open'}>
                          {p.status === 'open' ? 'View & order' : 'View'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}

            {tab === 'orders' && <OrdersTab orders={orders} programStatus={programStatus} onChanged={load} />}

            {tab === 'rebates' &&
              (rebates.length === 0 ? (
                <EmptyState icon={ShieldCheck} title="No rebates yet" description="When a program closes, the final pooled tier is applied to every order and any difference is paid back to you as a rebate." />
              ) : (
                <div className={`${cardClass} overflow-x-auto`}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-text-secondary">
                        <th className="pb-2">Program</th>
                        <th className="pb-2">Type</th>
                        <th className="pb-2 text-right">Amount</th>
                        <th className="pb-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebates.map((r) => (
                        <tr key={r.id} className="border-t border-border">
                          <td className="py-2 text-text-primary">
                            {r.basis.program_title ?? 'Program'}
                            <span className="block text-xs text-text-secondary">{r.basis.supplier_name}</span>
                          </td>
                          <td className="py-2 text-text-secondary">{REBATE_KIND_LABELS[r.kind]}</td>
                          <td className="py-2 text-right font-medium text-text-primary">{formatMoney(r.amount_cents)}</td>
                          <td className="py-2 text-text-secondary capitalize">
                            {r.status}
                            {r.paid_reference ? ` (${r.paid_reference})` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

            {tab === 'settings' && <SettingsTab membership={membership} onLeft={load} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ------------------------------------------------------------------

function JoinCard({ onJoined }: { onJoined: () => Promise<void> }) {
  const { toast } = useToast();
  const [region, setRegion] = useState('');
  const [categories, setCategories] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    try {
      await joinNetwork(region.trim(), categories.split(',').map((c) => c.trim()).filter(Boolean), consent);
      toast('Welcome to the Procurement Network', 'success');
      await onJoined();
    } catch (e) {
      toast(errorMessage(e, 'Could not join'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${cardClass} mx-auto max-w-2xl`}>
      <h2 className="text-lg font-semibold text-text-primary">Join the Procurement Network</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Pool your purchasing with other service businesses to reach volume tiers none of you could reach alone. Joining is optional and you can leave at any time.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-text-secondary">
          Region (state / province)
          <input className={`${fieldClass} mt-1`} value={region} onChange={(e) => setRegion(e.target.value)} placeholder="e.g. TX" maxLength={60} />
        </label>
        <label className="text-sm text-text-secondary">
          Categories you buy (comma separated)
          <input className={`${fieldClass} mt-1`} value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="HVAC parts, filters" />
        </label>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-text-secondary">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          I agree to contribute my <strong className="text-text-primary">aggregated purchasing volume</strong> to group pools. Other businesses never see my orders, prices or customers, and totals are only shown once {MIN_COHORT}+ businesses take part. Suppliers I order from receive that order's shipping details.
        </span>
      </label>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => void join()} disabled={!consent || busy}>
          {busy && <Loader2 size={16} className="animate-spin" />} Join network
        </Button>
      </div>
    </div>
  );
}

function SettingsTab({ membership, onLeft }: { membership: Membership; onLeft: () => Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (!window.confirm('Leave the network? Your open commitments are removed. Existing orders and rebates are kept.')) return;
    setBusy(true);
    try {
      await leaveNetwork();
      toast('You left the Procurement Network', 'success');
      await onLeft();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${cardClass} max-w-xl space-y-3`}>
      <h2 className="font-semibold text-text-primary">Membership</h2>
      <p className="text-sm text-text-secondary">Region: {membership.region ?? 'not set'}</p>
      <p className="text-sm text-text-secondary">Volume-sharing consent given {membership.consented_at ? new Date(membership.consented_at).toLocaleDateString() : ''}</p>
      <p className="text-xs text-text-secondary">Volume already contributed to a pool stays in that pool's totals but is not attributable to you.</p>
      <Button variant="secondary" onClick={() => void leave()} disabled={busy}>
        Leave network
      </Button>
    </div>
  );
}

function OrdersTab({ orders, programStatus, onChanged }: { orders: NetworkOrder[]; programStatus: Map<string, ProgramSummary['status']>; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, NetworkOrderLine[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (id: string) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (!lines[id]) {
      try {
        const l = await fetchOrderLines(id);
        setLines((prev) => ({ ...prev, [id]: l }));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    }
  };

  const approve = async (id: string) => {
    setBusy(id);
    try {
      await approveOrder(id);
      toast('Order approved and sent to the supplier', 'success');
      await onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    if (!window.confirm('Cancel this order? The linked purchase order is cancelled too.')) return;
    setBusy(id);
    try {
      await cancelOrder(id);
      toast('Order cancelled', 'success');
      await onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (orders.length === 0) return <EmptyState icon={Handshake} title="No network orders yet" description="Orders you place from a program appear here and in your Purchase Orders." />;

  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <div key={o.id} className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-text-primary">
                {o.order_number} <span className="font-normal text-text-secondary">- {o.supplier_name}</span>
              </p>
              <p className="text-xs text-text-secondary">
                {o.program_title} - {new Date(o.created_at).toLocaleDateString()}
                {o.tracking ? ` - Tracking: ${o.tracking}` : ''}
              </p>
              {o.status === 'awaiting_approval' && o.po_id && (
                <p className="mt-1 text-xs text-amber-600">
                  Approve the purchase order in <Link className="underline" to="/dashboard/procurement">Purchase Orders</Link> to send it to the supplier.
                </p>
              )}
              {o.status === 'awaiting_approval' && !o.po_id && (
                <p className="mt-1 text-xs text-amber-600">Review the order, then approve it here to send it to the supplier.</p>
              )}
              {o.cancel_reason && <p className="mt-1 text-xs text-rose-600">{o.cancel_reason}</p>}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-semibold text-text-primary">{formatMoney(o.subtotal_cents)}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_TONE[o.status]}`}>{ORDER_STATUS_LABELS[o.status]}</span>
              <Button variant="ghost" size="sm" onClick={() => void toggle(o.id)}>
                {expanded === o.id ? 'Hide' : 'Details'}
              </Button>
              {o.status === 'awaiting_approval' && !o.po_id && (
                <Button size="sm" onClick={() => void approve(o.id)} disabled={busy === o.id}>
                  Approve &amp; send
                </Button>
              )}
              {buyerCanCancel(o.status, programStatus.get(o.program_id)) && (
                <Button variant="secondary" size="sm" onClick={() => void cancel(o.id)} disabled={busy === o.id}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
          {expanded === o.id && (
            <table className="mt-3 w-full text-sm">
              <tbody>
                {(lines[o.id] ?? []).map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1.5 text-text-secondary">{l.sku}</td>
                    <td className="py-1.5 text-text-primary">{l.description}</td>
                    <td className="py-1.5 text-right text-text-secondary">
                      {l.qty} x {formatMoney(l.unit_price_cents)}
                    </td>
                    <td className="py-1.5 text-right text-text-primary">{formatMoney(Math.round(l.qty * l.unit_price_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function ProgramPanel({ programId, onBack, onOrdered }: { programId: string; onBack: () => void; onOrdered: () => Promise<void> }) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<ProgramDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [parts, setParts] = useState<InventoryPartLite[]>([]);
  const [partFor, setPartFor] = useState<Record<string, string>>({});
  const [ship, setShip] = useState<ShipTo>(EMPTY_SHIP);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, p] = await Promise.all([getProgramDetail(programId), fetchInventoryPartsLite().catch(() => [] as InventoryPartLite[])]);
        if (cancelled) return;
        setDetail(d);
        setParts(p);
        setPartFor(Object.fromEntries(d.items.filter((i) => i.part_id).map((i) => [i.id, i.part_id as string])));
      } catch (e) {
        if (!cancelled) toast(errorMessage(e, 'Could not load the program'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [programId, toast]);

  const tiers = detail?.tiers ?? [];
  const cart = useMemo(
    () => (detail ? previewCart(detail.items, qty, tiers, detail.pool?.tier_id ?? null, detail.pool?.next_tier_rank ?? null) : null),
    [detail, qty, tiers],
  );
  const currentTier = tiers.find((t) => t.id === detail?.pool?.tier_id) ?? tiers[0] ?? null;
  const open = detail?.program.status === 'open';

  const commit = async (itemId: string, value: number) => {
    try {
      await setCommitment(programId, itemId, value);
      toast(value > 0 ? 'Forecast saved' : 'Forecast removed', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const mapPart = async (itemId: string, partId: string) => {
    setPartFor((p) => ({ ...p, [itemId]: partId }));
    try {
      if (partId) await linkPart(itemId, partId);
      else await unlinkPart(itemId);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const submit = async () => {
    if (!cart || cart.lines.length === 0) return;
    const problems = [...cart.errors, ...validateShipTo(ship)];
    if (problems.length) return toast(problems[0], 'error');
    setBusy(true);
    try {
      const res = await placeOrder({
        programId,
        lines: cart.lines.map((l) => ({ catalog_item_id: l.item.id, qty: l.qty, part_id: partFor[l.item.id] || null })),
        shipTo: ship,
        notes,
      });
      toast(res.po_linked ? `Order ${res.order_number} created - approve its purchase order to send it` : `Order ${res.order_number} created - approve it in the Orders tab to send it`, 'success');
      await onOrdered();
    } catch (e) {
      toast(errorMessage(e, 'Could not place the order'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonStatGrid count={2} />;
  if (!detail || !cart) return <EmptyState icon={Handshake} title="Program unavailable" action={{ label: 'Back', onClick: onBack }} />;

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="focus-ring text-sm text-accent hover:underline">
        &larr; All programs
      </button>
      <div className={cardClass}>
        <h2 className="text-lg font-semibold text-text-primary">{detail.program.title}</h2>
        <p className="text-sm text-text-secondary">
          {detail.supplier.name} - ends {detail.program.ends_on}
        </p>
        {detail.program.description && <p className="mt-2 text-sm text-text-secondary">{detail.program.description}</p>}
        <div className="mt-4 max-w-xl">
          <TierBar program={{ pool: detail.pool, tiers }} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {tiers.map((t) => (
            <span key={t.id} className={`rounded-full border px-3 py-1 text-xs ${t.id === currentTier?.id ? 'border-accent text-text-primary' : 'border-border text-text-secondary'}`}>
              {t.label} from {formatMoney(t.min_qualifying_cents)}
            </span>
          ))}
        </div>
        {detail.program.terms && <p className="mt-3 whitespace-pre-line text-xs text-text-secondary">{detail.program.terms}</p>}
      </div>

      <div className={`${cardClass} overflow-x-auto`}>
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-text-secondary">
              <th className="pb-2">Item</th>
              <th className="pb-2 text-right">List</th>
              <th className="pb-2 text-right">Your price now</th>
              <th className="pb-2">Inventory part</th>
              <th className="pb-2 text-right">Forecast</th>
              <th className="pb-2 text-right">Order qty</th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((i) => (
              <tr key={i.id} className="border-t border-border align-top">
                <td className="py-2 text-text-primary">
                  {i.name}
                  <span className="block text-xs text-text-secondary">
                    {i.sku} - per {i.unit}
                    {i.min_order_qty > 1 ? ` - min ${i.min_order_qty}` : ''}
                  </span>
                </td>
                <td className="py-2 text-right text-text-secondary">{formatMoney(i.list_price_cents)}</td>
                <td className="py-2 text-right font-medium text-text-primary">{formatMoney(unitPriceAt(i, currentTier))}</td>
                <td className="py-2">
                  <select className={fieldClass} value={partFor[i.id] ?? ''} onChange={(e) => void mapPart(i.id, e.target.value)} aria-label={`Inventory part for ${i.sku}`}>
                    <option value="">Not linked</option>
                    {parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.part_number ? ` (${p.part_number})` : ''}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 text-right">
                  <input
                    type="number"
                    min={0}
                    className={`${fieldClass} w-24 text-right`}
                    defaultValue={i.my_commit_qty ?? ''}
                    disabled={!open}
                    onBlur={(e) => {
                      const v = Number(e.target.value || 0);
                      if (Number.isFinite(v) && v >= 0 && v !== (i.my_commit_qty ?? 0)) void commit(i.id, v);
                    }}
                    aria-label={`Forecast quantity for ${i.sku}`}
                  />
                </td>
                <td className="py-2 text-right">
                  <input
                    type="number"
                    min={0}
                    className={`${fieldClass} w-24 text-right`}
                    value={qty[i.id] ?? ''}
                    disabled={!open}
                    onChange={(e) => setQty((q) => ({ ...q, [i.id]: Number(e.target.value) }))}
                    aria-label={`Order quantity for ${i.sku}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-text-secondary">Forecasts are non-binding and help the pool reach the next tier. Linking an inventory part makes receiving update your stock automatically.</p>
      </div>

      {open && (
        <div className={cardClass}>
          <h3 className="font-semibold text-text-primary">Ship to</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(
              [
                ['name', 'Business / site name *'],
                ['contact', 'Contact person'],
                ['phone', 'Phone'],
                ['line1', 'Street address *'],
                ['line2', 'Suite / unit'],
                ['city', 'City *'],
                ['region', 'State / province'],
                ['postal_code', 'Postal code *'],
                ['country', 'Country'],
              ] as Array<[keyof ShipTo, string]>
            ).map(([k, label]) => (
              <label key={k} className="text-sm text-text-secondary">
                {label}
                <input className={`${fieldClass} mt-1`} value={ship[k]} onChange={(e) => setShip((s) => ({ ...s, [k]: e.target.value }))} />
              </label>
            ))}
          </div>
          <label className="mt-3 block text-sm text-text-secondary">
            Notes for the supplier
            <textarea className={`${fieldClass} mt-1`} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="text-sm">
              <p className="text-text-primary">
                Subtotal <strong>{formatMoney(cart.subtotalCents)}</strong>{' '}
                <span className="text-emerald-600">({formatMoney(cart.savingsVsListCents)} below list)</span>
              </p>
              {cart.nextTierExtraSavingCents !== null && cart.nextTierExtraSavingCents > 0 && (
                <p className="text-xs text-text-secondary">If the pool reaches the next tier you receive up to {formatMoney(cart.nextTierExtraSavingCents)} back as a rebate.</p>
              )}
              {cart.errors.length > 0 && <p className="text-xs text-rose-600">{cart.errors[0]}</p>}
            </div>
            <Button onClick={() => void submit()} disabled={busy || cart.lines.length === 0}>
              {busy && <Loader2 size={16} className="animate-spin" />} Create purchase order
            </Button>
          </div>
          <p className="mt-2 text-xs text-text-secondary">Prices are confirmed by the server when you submit. The order is sent to the supplier only after you approve the purchase order.</p>
        </div>
      )}
    </div>
  );
}
