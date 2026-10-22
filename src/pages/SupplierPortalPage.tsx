/**
 * Supplier Portal - /supplier-portal
 *
 * For supplier organisations (not Vireek tenants). Suppliers manage their catalog, group
 * programs with volume tiers, negotiated price schedules, incoming orders and rebates.
 * They only ever see AGGREGATED pool volumes (3+ businesses) plus the orders placed with them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Package, RefreshCw } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  REBATE_KIND_LABELS,
  SCHEDULE_STATUS_LABELS,
  bpsToPercent,
  buildScheduleFromDiscounts,
  formatMoney,
  parseCatalogCsv,
  parseMoneyToCents,
  supplierOrderActions,
  tierProgress,
  validateScheduleDraft,
} from '@/lib/procurementNetwork';
import type { CatalogImportResult, NetworkOrder, NetworkOrderLine, Rebate, Tier } from '@/lib/procurementNetwork';
import {
  addSupplierMember,
  createCatalogItem,
  createProgram,
  createSchedule,
  deleteTier,
  errorMessage,
  fetchCatalog,
  fetchMySupplier,
  fetchOrderLines,
  fetchScheduleLines,
  fetchSchedules,
  fetchSupplierMembers,
  fetchSupplierOrders,
  fetchSupplierProgramStats,
  fetchSupplierPrograms,
  fetchSupplierRebates,
  fetchTiers,
  importCatalogRows,
  markRebatePaid,
  replaceScheduleLines,
  saveTier,
  setProgramStatus,
  submitSchedule,
  updateCatalogItem,
  updateProgram,
  updateSupplierOrder,
  updateSupplierProfile,
} from '@/lib/procurementNetworkApi';
import type { CatalogItem, Program, Schedule, SupplierMembership, SupplierProgramStats } from '@/lib/procurementNetworkApi';

const fieldClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-5';
type Tab = 'orders' | 'catalog' | 'programs' | 'rebates' | 'team';
const list = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

export function SupplierPortalPage() {
  const { toast } = useToast();
  const [me, setMe] = useState<SupplierMembership | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('orders');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await fetchMySupplier());
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <Loader2 className="animate-spin text-text-secondary" />
      </div>
    );
  }
  if (!me) return null;
  const s = me.supplier;
  const isAdmin = me.role === 'admin';
  const approved = s.status === 'approved';

  return (
    <div className="min-h-screen bg-bg-primary">
      <header className="border-b border-border bg-bg-secondary">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-text-secondary">Vireek Procurement Network - Supplier portal</p>
            <h1 className="text-xl font-bold text-text-primary">{s.name}</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${approved ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400'}`}>{s.status}</span>
            <Button variant="secondary" size="sm" onClick={() => void load()} aria-label="Refresh"><RefreshCw size={14} /></Button>
            <Link to="/dashboard" className="text-sm text-accent hover:underline">Back to Vireek</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {!approved && (
          <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300" role="status">
            {s.status === 'pending' && 'Your application is under review. You can prepare your catalog and draft programs now; programs open to buyers once you are approved.'}
            {s.status === 'rejected' && `Your application was not approved.${s.review_notes ? ` Note: ${s.review_notes}` : ''}`}
            {s.status === 'suspended' && `Your account is suspended and cannot receive new orders.${s.review_notes ? ` Note: ${s.review_notes}` : ''}`}
          </div>
        )}

        <div className="mb-6 flex flex-wrap gap-1 border-b border-border" role="tablist">
          {(['orders', 'catalog', 'programs', 'rebates', 'team'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${tab === t ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              {t === 'team' ? 'Team & profile' : t}
            </button>
          ))}
        </div>

        {tab === 'orders' && <OrdersPanel supplierId={s.id} />}
        {tab === 'catalog' && <CatalogPanel supplierId={s.id} />}
        {tab === 'programs' && <ProgramsPanel supplierId={s.id} isAdmin={isAdmin} />}
        {tab === 'rebates' && <RebatesPanel supplierId={s.id} isAdmin={isAdmin} />}
        {tab === 'team' && <TeamPanel me={me} onSaved={load} />}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ orders

function OrdersPanel({ supplierId }: { supplierId: string }) {
  const { toast } = useToast();
  const [orders, setOrders] = useState<NetworkOrder[] | null>(null);
  const [lines, setLines] = useState<Record<string, NetworkOrderLine[]>>({});
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await fetchSupplierOrders(supplierId));
    } catch (e) {
      toast(errorMessage(e), 'error');
      setOrders([]);
    }
  }, [supplierId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (o: NetworkOrder, action: 'confirm' | 'ship' | 'deliver' | 'cancel') => {
    let tracking: string | undefined;
    let note: string | undefined;
    if (action === 'ship') tracking = window.prompt('Tracking number / carrier (optional)') ?? undefined;
    if (action === 'cancel') {
      note = window.prompt('Reason for cancelling (visible to the buyer)') ?? '';
      if (note.trim().length < 3) return;
    }
    try {
      await updateSupplierOrder(o.id, action, { tracking, note });
      toast('Order updated', 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const toggle = async (id: string) => {
    setOpen(open === id ? null : id);
    if (!lines[id]) setLines((p) => ({ ...p, [id]: [] }));
    if (!lines[id]?.length) {
      try {
        const l = await fetchOrderLines(id);
        setLines((p) => ({ ...p, [id]: l }));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    }
  };

  if (!orders) return <Loader2 className="animate-spin text-text-secondary" />;
  if (orders.length === 0) return <EmptyState icon={Package} title="No orders yet" description="Orders appear here after a buyer approves their purchase order." />;
  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <div key={o.id} className={cardClass}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="text-sm">
              <p className="font-semibold text-text-primary">{o.order_number} <span className="font-normal text-text-secondary">- {o.program_title}</span></p>
              <p className="text-xs text-text-secondary">{o.buyer_company} - {new Date(o.created_at).toLocaleDateString()}</p>
              <p className="mt-1 text-xs text-text-secondary">
                Ship to: {[o.ship_to.name, o.ship_to.line1, o.ship_to.line2, o.ship_to.city, o.ship_to.region, o.ship_to.postal_code, o.ship_to.country].filter(Boolean).join(', ')}
                {o.ship_to.contact ? ` - ${o.ship_to.contact}` : ''}{o.ship_to.phone ? ` ${o.ship_to.phone}` : ''}
              </p>
              {o.notes && <p className="mt-1 text-xs text-text-secondary">Buyer note: {o.notes}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-text-primary">{formatMoney(o.subtotal_cents)}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_TONE[o.status]}`}>{ORDER_STATUS_LABELS[o.status]}</span>
              <Button variant="ghost" size="sm" onClick={() => void toggle(o.id)}>Lines</Button>
              {supplierOrderActions(o.status).map((a) => (
                <Button key={a} size="sm" variant={a === 'cancel' ? 'secondary' : 'primary'} onClick={() => void act(o, a)} className="capitalize">{a}</Button>
              ))}
            </div>
          </div>
          {open === o.id && (
            <table className="mt-3 w-full text-sm"><tbody>
              {(lines[o.id] ?? []).map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="py-1.5 text-text-secondary">{l.sku}</td>
                  <td className="py-1.5 text-text-primary">{l.description}</td>
                  <td className="py-1.5 text-right text-text-secondary">{l.qty} x {formatMoney(l.unit_price_cents)}</td>
                  <td className="py-1.5 text-right text-text-primary">{formatMoney(Math.round(l.qty * l.unit_price_cents))}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ catalog

function CatalogPanel({ supplierId }: { supplierId: string }) {
  const { toast } = useToast();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<CatalogImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ sku: '', name: '', price: '', unit: 'each', category: '' });

  const load = useCallback(async () => {
    try {
      setItems(await fetchCatalog(supplierId));
    } catch (e) {
      toast(errorMessage(e), 'error');
      setItems([]);
    }
  }, [supplierId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const addOne = async () => {
    const cents = parseMoneyToCents(form.price);
    if (!form.sku.trim() || !form.name.trim() || cents === null) return toast('SKU, name and a valid price are required', 'error');
    setBusy(true);
    try {
      await createCatalogItem(supplierId, { sku: form.sku.trim(), name: form.name.trim(), description: null, category: form.category.trim() || null, manufacturer: null, mpn: null, unit: form.unit.trim() || 'each', list_price_cents: cents, min_order_qty: 1, lead_time_days: null, active: true });
      setForm({ sku: '', name: '', price: '', unit: 'each', category: '' });
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!preview || preview.rows.length === 0) return;
    setBusy(true);
    try {
      const r = await importCatalogRows(supplierId, preview.rows, items ?? []);
      toast(`Imported: ${r.inserted} new, ${r.updated} updated${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0].sku}: ${r.failed[0].message})` : ''}`, r.failed.length ? 'error' : 'success');
      setCsv('');
      setPreview(null);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (i: CatalogItem) => {
    try {
      await updateCatalogItem(i.id, { active: !i.active });
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const editPrice = async (i: CatalogItem) => {
    const v = window.prompt(`New list price for ${i.sku}`, (i.list_price_cents / 100).toFixed(2));
    if (v === null) return;
    const cents = parseMoneyToCents(v);
    if (cents === null) return toast('Invalid price', 'error');
    try {
      await updateCatalogItem(i.id, { list_price_cents: cents });
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className={cardClass}>
        <h2 className="mb-3 font-semibold text-text-primary">Add item</h2>
        <div className="grid gap-3 sm:grid-cols-5">
          <input className={fieldClass} placeholder="SKU" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} aria-label="SKU" />
          <input className={`${fieldClass} sm:col-span-2`} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
          <input className={fieldClass} placeholder="List price" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} aria-label="List price" />
          <Button onClick={() => void addOne()} disabled={busy}>Add</Button>
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-accent">Bulk import from CSV</summary>
          <p className="mt-2 text-xs text-text-secondary">Columns: sku, name, price (required); unit, category, manufacturer, mpn, description, moq, lead_time_days. Up to 2,000 rows. Existing SKUs are updated.</p>
          <textarea className={`${fieldClass} mt-2 font-mono`} rows={5} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} placeholder="sku,name,price&#10;CAP-45-5,Dual run capacitor 45/5,18.50" />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPreview(parseCatalogCsv(csv))} disabled={!csv.trim()}>Validate</Button>
            {preview && <Button size="sm" onClick={() => void runImport()} disabled={busy || preview.rows.length === 0}>Import {preview.rows.length} items</Button>}
          </div>
          {preview && preview.errors.length > 0 && (
            <ul className="mt-2 max-h-32 overflow-auto text-xs text-rose-600">{preview.errors.slice(0, 20).map((e, idx) => <li key={idx}>Line {e.line}: {e.message}</li>)}</ul>
          )}
        </details>
      </div>

      {!items ? <Loader2 className="animate-spin text-text-secondary" /> : items.length === 0 ? (
        <EmptyState icon={Package} title="Your catalog is empty" description="Add items or import a CSV to start building programs." />
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-text-secondary"><th className="pb-2">SKU</th><th className="pb-2">Name</th><th className="pb-2">Unit</th><th className="pb-2 text-right">List</th><th className="pb-2">Status</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t border-border">
                  <td className="py-2 text-text-secondary">{i.sku}</td>
                  <td className="py-2 text-text-primary">{i.name}</td>
                  <td className="py-2 text-text-secondary">{i.unit}</td>
                  <td className="py-2 text-right text-text-primary">{formatMoney(i.list_price_cents)}</td>
                  <td className="py-2 text-text-secondary">{i.active ? 'Active' : 'Inactive'}</td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => void editPrice(i)}>Price</Button>
                    <Button variant="ghost" size="sm" onClick={() => void toggleActive(i)}>{i.active ? 'Deactivate' : 'Activate'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ programs

function ProgramsPanel({ supplierId, isAdmin }: { supplierId: string; isAdmin: boolean }) {
  const { toast } = useToast();
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', ends_on: '', bonus: '0', bonusMin: '0', minParticipants: '3' });

  const load = useCallback(async () => {
    try {
      setPrograms(await fetchSupplierPrograms(supplierId));
    } catch (e) {
      toast(errorMessage(e), 'error');
      setPrograms([]);
    }
  }, [supplierId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const bonusMin = parseMoneyToCents(form.bonusMin) ?? 0;
    if (form.title.trim().length < 2 || !form.ends_on) return toast('Title and end date are required', 'error');
    try {
      const p = await createProgram(supplierId, {
        title: form.title.trim(), description: null, category: null, terms: null, starts_on: today(), ends_on: form.ends_on, regions: [],
        min_participants_for_tier: Math.max(3, Number(form.minParticipants) || 3), bonus_rebate_bps: Math.round((Number(form.bonus) || 0) * 100), bonus_min_spend_cents: bonusMin,
      });
      setForm({ title: '', ends_on: '', bonus: '0', bonusMin: '0', minParticipants: '3' });
      setSelected(p.id);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (selected) {
    const p = programs?.find((x) => x.id === selected);
    if (p) return <ProgramEditor program={p} supplierId={supplierId} isAdmin={isAdmin} onBack={() => { setSelected(null); void load(); }} />;
  }

  return (
    <div className="space-y-5">
      <div className={cardClass}>
        <h2 className="mb-3 font-semibold text-text-primary">New group program</h2>
        <div className="grid gap-3 sm:grid-cols-6">
          <input className={`${fieldClass} sm:col-span-2`} placeholder="Program title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Program title" />
          <input type="date" className={fieldClass} value={form.ends_on} min={today()} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} aria-label="End date" />
          <input className={fieldClass} placeholder="Bonus rebate %" inputMode="decimal" value={form.bonus} onChange={(e) => setForm({ ...form, bonus: e.target.value })} aria-label="Bonus rebate percent" />
          <input className={fieldClass} placeholder="Bonus min spend $" inputMode="decimal" value={form.bonusMin} onChange={(e) => setForm({ ...form, bonusMin: e.target.value })} aria-label="Bonus minimum spend" />
          <Button onClick={() => void create()}>Create</Button>
        </div>
        <p className="mt-2 text-xs text-text-secondary">Higher tiers unlock only after {form.minParticipants || 3}+ distinct businesses have ordered (minimum 3).</p>
      </div>
      {!programs ? <Loader2 className="animate-spin text-text-secondary" /> : programs.length === 0 ? (
        <EmptyState icon={Package} title="No programs yet" description="Create a program, add volume tiers, negotiate a price schedule, then open it to buyers." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {programs.map((p) => (
            <button key={p.id} onClick={() => setSelected(p.id)} className={`${cardClass} focus-ring text-left hover:border-accent`}>
              <div className="flex items-center justify-between"><h3 className="font-semibold text-text-primary">{p.title}</h3><span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-secondary">{p.status}</span></div>
              <p className="mt-1 text-xs text-text-secondary">{p.starts_on} to {p.ends_on}{p.bonus_rebate_bps > 0 ? ` - ${bpsToPercent(p.bonus_rebate_bps)} bonus rebate` : ''}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgramEditor({ program, supplierId, isAdmin, onBack }: { program: Program; supplierId: string; isAdmin: boolean; onBack: () => void }) {
  const { toast } = useToast();
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [stats, setStats] = useState<SupplierProgramStats | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({}); // `${itemId}|${tierId}` -> dollars
  const [tierForm, setTierForm] = useState({ rank: '1', label: '', min: '0', discount: '0' });
  const [status, setStatus] = useState(program.status);
  const [busy, setBusy] = useState(false);
  const draft = status === 'draft';

  const reload = useCallback(async () => {
    try {
      const [t, s, c] = await Promise.all([fetchTiers(program.id), fetchSchedules(program.id), fetchCatalog(supplierId)]);
      setTiers(t);
      setSchedules(s);
      setItems(c.filter((i) => i.active));
      if (status !== 'draft') setStats(await fetchSupplierProgramStats(program.id));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }, [program.id, supplierId, status, toast]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const activeSchedule = schedules.find((s) => s.status === 'draft') ?? null;
  useEffect(() => {
    setScheduleId(activeSchedule?.id ?? null);
  }, [activeSchedule?.id]);

  useEffect(() => {
    if (!scheduleId) return setPrices({});
    void fetchScheduleLines(scheduleId).then((ls) => setPrices(Object.fromEntries(ls.map((l) => [`${l.catalog_item_id}|${l.tier_id}`, (l.unit_price_cents / 100).toFixed(2)])))).catch((e) => toast(errorMessage(e), 'error'));
  }, [scheduleId, toast]);

  const sorted = useMemo(() => [...tiers].sort((a, b) => a.rank - b.rank), [tiers]);
  const lines = useMemo(() => {
    const out: Array<{ catalog_item_id: string; tier_id: string; unit_price_cents: number }> = [];
    for (const [k, v] of Object.entries(prices)) {
      const cents = parseMoneyToCents(v);
      if (cents === null) continue;
      const [catalog_item_id, tier_id] = k.split('|');
      out.push({ catalog_item_id, tier_id, unit_price_cents: cents });
    }
    return out;
  }, [prices]);
  const issues = useMemo(() => (scheduleId ? validateScheduleDraft(sorted, items, lines) : []), [scheduleId, sorted, items, lines]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      await reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const addTier = () => {
    const min = parseMoneyToCents(tierForm.min);
    if (!tierForm.label.trim() || min === null) return toast('Label and a valid threshold are required', 'error');
    void run(() => saveTier(program.id, { rank: Number(tierForm.rank), label: tierForm.label.trim(), min_qualifying_cents: min, discount_bps: Math.round((Number(tierForm.discount) || 0) * 100) }), 'Tier saved');
  };

  const changeStatus = (s: 'open' | 'closed' | 'cancelled') => {
    if (s === 'closed' && !window.confirm('Close and settle this program? The final pooled tier is applied to every order and rebates are calculated. This cannot be undone.')) return;
    void run(async () => { await setProgramStatus(program.id, s); setStatus(s === 'open' ? 'open' : s); }, `Program ${s}`);
  };

  const pool = stats?.pool ?? null;
  const prog = tierProgress(pool, sorted);

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="focus-ring text-sm text-accent hover:underline">&larr; All programs</button>
      <div className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-semibold text-text-primary">{program.title}</h2><p className="text-xs text-text-secondary">{program.starts_on} to {program.ends_on} - status: {status}</p></div>
          {isAdmin && (
            <div className="flex gap-2">
              {draft && <Button onClick={() => changeStatus('open')} disabled={busy}>Open to buyers</Button>}
              {(draft || status === 'open') && <Button variant="secondary" onClick={() => changeStatus('cancelled')} disabled={busy}>Cancel</Button>}
              {status === 'open' && <Button onClick={() => changeStatus('closed')} disabled={busy}>Close &amp; settle</Button>}
            </div>
          )}
        </div>
        {stats && (
          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-text-secondary">Pooled volume</p><p className="font-semibold text-text-primary">{pool?.pooled_cents == null ? 'Forming (3+ buyers needed)' : formatMoney(pool.pooled_cents)}</p></div>
            <div><p className="text-xs text-text-secondary">Tier</p><p className="font-semibold text-text-primary">{prog.currentLabel ?? '-'}</p></div>
            <div><p className="text-xs text-text-secondary">Orders</p><p className="font-semibold text-text-primary">{stats.orders}</p></div>
            <div><p className="text-xs text-text-secondary">Rebates owed / paid</p><p className="font-semibold text-text-primary">{formatMoney(stats.rebates_accrued_cents)} / {formatMoney(stats.rebates_paid_cents)}</p></div>
          </div>
        )}
        {stats && stats.items.length > 0 && (
          <table className="mt-4 w-full text-sm"><thead><tr className="text-left text-xs uppercase text-text-secondary"><th className="pb-1">Demand by item (aggregated)</th><th className="pb-1 text-right">Ordered</th><th className="pb-1 text-right">Forecast</th></tr></thead><tbody>
            {stats.items.map((i) => <tr key={i.catalog_item_id} className="border-t border-border"><td className="py-1.5 text-text-primary">{i.name} <span className="text-text-secondary">{i.sku}</span></td><td className="py-1.5 text-right">{i.ordered_qty}</td><td className="py-1.5 text-right">{i.committed_qty}</td></tr>)}
          </tbody></table>
        )}
      </div>

      <div className={cardClass}>
        <h3 className="mb-3 font-semibold text-text-primary">Volume tiers</h3>
        <table className="w-full text-sm"><tbody>
          {sorted.map((t) => (
            <tr key={t.id} className="border-t border-border first:border-0">
              <td className="py-2 text-text-secondary">#{t.rank}</td><td className="py-2 text-text-primary">{t.label}</td>
              <td className="py-2 text-text-secondary">from {formatMoney(t.min_qualifying_cents)} pooled list volume</td>
              <td className="py-2 text-text-secondary">fallback {bpsToPercent(t.discount_bps)} off</td>
              <td className="py-2 text-right">{draft && <Button variant="ghost" size="sm" onClick={() => void run(() => deleteTier(t.id), 'Tier removed')}>Remove</Button>}</td>
            </tr>
          ))}
        </tbody></table>
        {draft && (
          <div className="mt-3 grid gap-2 sm:grid-cols-5">
            <input className={fieldClass} placeholder="Rank" inputMode="numeric" value={tierForm.rank} onChange={(e) => setTierForm({ ...tierForm, rank: e.target.value })} aria-label="Tier rank" />
            <input className={fieldClass} placeholder="Label (Silver)" value={tierForm.label} onChange={(e) => setTierForm({ ...tierForm, label: e.target.value })} aria-label="Tier label" />
            <input className={fieldClass} placeholder="Min pooled $" inputMode="decimal" value={tierForm.min} onChange={(e) => setTierForm({ ...tierForm, min: e.target.value })} aria-label="Minimum pooled volume" />
            <input className={fieldClass} placeholder="Fallback % off" inputMode="decimal" value={tierForm.discount} onChange={(e) => setTierForm({ ...tierForm, discount: e.target.value })} aria-label="Fallback discount percent" />
            <Button onClick={addTier} disabled={busy}>Add tier</Button>
          </div>
        )}
        {!draft && <p className="mt-2 text-xs text-text-secondary">Tiers are locked once a program opens so pricing stays fair for buyers.</p>}
      </div>

      <div className={cardClass}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-text-primary">Negotiated price schedule</h3>
          <Button variant="secondary" size="sm" onClick={() => void run(() => createSchedule(program.id, ''), 'Draft schedule created')} disabled={busy || !!activeSchedule}>New version</Button>
        </div>
        <ul className="mb-3 space-y-1 text-xs text-text-secondary">
          {schedules.map((s) => <li key={s.id}>v{s.version} - {SCHEDULE_STATUS_LABELS[s.status]}{s.review_note ? ` - Reviewer: ${s.review_note}` : ''}</li>)}
          {schedules.length === 0 && <li>No schedule yet. Create a draft, set a price per item per tier, then submit it for review.</li>}
        </ul>
        {scheduleId && sorted.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead><tr className="text-left text-xs uppercase text-text-secondary"><th className="pb-2">Item</th><th className="pb-2 text-right">List</th>{sorted.map((t) => <th key={t.id} className="pb-2 text-right">{t.label}</th>)}</tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-t border-border">
                      <td className="py-1.5 text-text-primary">{i.name} <span className="text-text-secondary">{i.sku}</span></td>
                      <td className="py-1.5 text-right text-text-secondary">{formatMoney(i.list_price_cents)}</td>
                      {sorted.map((t) => (
                        <td key={t.id} className="py-1.5 text-right"><input className={`${fieldClass} w-24 text-right`} inputMode="decimal" value={prices[`${i.id}|${t.id}`] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [`${i.id}|${t.id}`]: e.target.value }))} aria-label={`${i.sku} price at ${t.label}`} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {issues.length > 0 && <ul className="mt-2 text-xs text-rose-600">{issues.slice(0, 6).map((m) => <li key={m}>{m}</li>)}</ul>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => { const built = buildScheduleFromDiscounts(sorted, items, {}); setPrices(Object.fromEntries(built.map((l) => [`${l.catalog_item_id}|${l.tier_id}`, (l.unit_price_cents / 100).toFixed(2)]))); }}>Fill from tier discounts</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => replaceScheduleLines(scheduleId, lines), 'Draft saved')}>Save draft</Button>
              <Button size="sm" disabled={busy || issues.length > 0} onClick={() => void run(async () => { await replaceScheduleLines(scheduleId, lines); await submitSchedule(scheduleId); }, 'Submitted for review')}>Submit for review</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ rebates

function RebatesPanel({ supplierId, isAdmin }: { supplierId: string; isAdmin: boolean }) {
  const { toast } = useToast();
  const [rebates, setRebates] = useState<Rebate[] | null>(null);
  const load = useCallback(async () => {
    try {
      setRebates(await fetchSupplierRebates(supplierId));
    } catch (e) {
      toast(errorMessage(e), 'error');
      setRebates([]);
    }
  }, [supplierId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const pay = async (r: Rebate) => {
    const ref = window.prompt('Payment reference (check number, transfer id)');
    if (ref === null) return;
    try {
      await markRebatePaid(r.id, ref);
      toast('Marked as paid', 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (!rebates) return <Loader2 className="animate-spin text-text-secondary" />;
  if (rebates.length === 0) return <EmptyState icon={Package} title="No rebates" description="Rebates are calculated automatically when a program closes." />;
  return (
    <div className={`${cardClass} overflow-x-auto`}>
      <table className="w-full min-w-[560px] text-sm">
        <thead><tr className="text-left text-xs uppercase text-text-secondary"><th className="pb-2">Buyer</th><th className="pb-2">Program</th><th className="pb-2">Type</th><th className="pb-2 text-right">Amount</th><th className="pb-2">Status</th><th /></tr></thead>
        <tbody>
          {rebates.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="py-2 text-text-primary">{r.basis.buyer_company ?? 'Buyer'}</td>
              <td className="py-2 text-text-secondary">{r.basis.program_title}</td>
              <td className="py-2 text-text-secondary">{REBATE_KIND_LABELS[r.kind]}</td>
              <td className="py-2 text-right font-medium text-text-primary">{formatMoney(r.amount_cents)}</td>
              <td className="py-2 capitalize text-text-secondary">{r.status}</td>
              <td className="py-2 text-right">{isAdmin && r.status === 'accrued' && <Button size="sm" onClick={() => void pay(r)}>Mark paid</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ team & profile

function TeamPanel({ me, onSaved }: { me: SupplierMembership; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const s = me.supplier;
  const admin = me.role === 'admin';
  const [f, setF] = useState({ contactName: s.contact_name ?? '', contactEmail: s.contact_email, phone: s.phone ?? '', website: s.website ?? '', description: s.description ?? '', regions: s.regions.join(', '), categories: s.categories.join(', ') });
  const [members, setMembers] = useState<Array<{ id: string; user_id: string; role: string }>>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');

  useEffect(() => {
    void fetchSupplierMembers(s.id).then(setMembers).catch(() => undefined);
  }, [s.id]);

  const save = async () => {
    try {
      await updateSupplierProfile(s.id, { ...f, regions: list(f.regions), categories: list(f.categories) });
      toast('Profile saved', 'success');
      await onSaved();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const add = async () => {
    try {
      await addSupplierMember(s.id, email, role);
      toast('Member added', 'success');
      setEmail('');
      setMembers(await fetchSupplierMembers(s.id));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className={`${cardClass} space-y-3`}>
        <h2 className="font-semibold text-text-primary">Company profile</h2>
        {([['contactName', 'Contact name'], ['contactEmail', 'Contact email'], ['phone', 'Phone'], ['website', 'Website'], ['regions', 'Regions (comma separated)'], ['categories', 'Categories (comma separated)']] as Array<[keyof typeof f, string]>).map(([k, label]) => (
          <label key={k} className="block text-sm text-text-secondary">{label}<input disabled={!admin} className={`${fieldClass} mt-1`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
        ))}
        <label className="block text-sm text-text-secondary">About<textarea disabled={!admin} rows={3} className={`${fieldClass} mt-1`} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        {admin && <Button onClick={() => void save()}>Save profile</Button>}
        <p className="text-xs text-text-secondary">W-9: {s.w9_verified ? 'verified' : 'pending'} - Insurance: {s.insurance_verified ? 'verified' : 'pending'}</p>
      </div>
      <div className={`${cardClass} space-y-3`}>
        <h2 className="font-semibold text-text-primary">Team ({members.length})</h2>
        <ul className="text-sm text-text-secondary">{members.map((m) => <li key={m.id} className="border-t border-border py-1.5 first:border-0">{m.user_id.slice(0, 8)}... - {m.role}</li>)}</ul>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <input className={`${fieldClass} flex-1`} type="email" placeholder="Teammate's Vireek account email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Teammate email" />
            <select className={`${fieldClass} w-28`} value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')} aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select>
            <Button onClick={() => void add()} disabled={!email.trim()}>Add</Button>
          </div>
        )}
      </div>
    </div>
  );
}
