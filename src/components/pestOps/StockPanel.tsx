import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { adjustStock, enableStock, fetchMovements, fetchStock, friendlyPestOpsError, reconcileStock } from '@/lib/pestOpsApi';
import { fetchProducts } from '@/lib/tradePacksApi';
import { PRODUCT_UNITS, UNIT_LABELS } from '@/lib/tradePacks';
import { unitFamily } from '@/lib/tradePacks/pestOps';
import { Pill, SelectField, fmtDateTime } from '@/components/tradePacks/shared';
import { useResource } from './useResource';

type Kind = 'receipt' | 'adjustment' | 'count';

export function StockPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const stock = useResource(() => fetchStock(ownerId));
  const products = useResource(() => fetchProducts(ownerId, 'pest_control'));
  const [selected, setSelected] = useState<string | null>(null);
  const [newProduct, setNewProduct] = useState('');
  const [opening, setOpening] = useState('0');
  const [kind, setKind] = useState<Kind>('receipt');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);

  const tracked = new Set((stock.data ?? []).map((s) => s.product_id));
  const untracked = (products.data ?? []).filter((p) => !tracked.has(p.id) && !p.archived_at);
  const row = (stock.data ?? []).find((s) => s.product_id === selected);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      await stock.reload();
      setHistoryTick((t) => t + 1);
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (stock.loading && !stock.data) return <Skeleton className="h-40 w-full" />;
  if (stock.error) return <EmptyState variant="load-failed" title="Could not load stock" description={stock.error} onRetry={() => void stock.reload()} />;

  const qtyNum = Number(qty);
  const qtyBad = qty.trim() === '' || !Number.isFinite(qtyNum) || (kind !== 'adjustment' && qtyNum < 0) || (kind === 'receipt' && qtyNum === 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">Every chemical application deducts from tracked products automatically. A record is never blocked by low stock — the balance can go negative and is flagged for recount.</p>

      {(stock.data ?? []).length === 0 ? (
        <EmptyState compact title="No products tracked yet" description="Start tracking a product below." />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Tracked products">
          {(stock.data ?? []).map((s) => {
            const low = s.reorder_point !== null && s.on_hand <= s.reorder_point;
            return (
              <li key={s.id}>
                <Card className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-text-primary">{s.product?.name ?? 'Product'}</p>
                      <p className="text-xs text-text-secondary">{s.product?.epa_reg_number ? `Reg. ${s.product.epa_reg_number}` : 'No registration number'}</p>
                    </div>
                    {s.on_hand < 0 ? <Pill tone="danger">negative — recount</Pill> : low ? <Pill tone="warning">reorder</Pill> : <Pill tone="success">ok</Pill>}
                  </div>
                  <p className="text-2xl font-semibold text-text-primary">{s.on_hand} <span className="text-sm font-normal text-text-secondary">{UNIT_LABELS[s.unit as keyof typeof UNIT_LABELS] ?? s.unit}</span></p>
                  <Button size="xs" variant="secondary" onClick={() => { setSelected(selected === s.product_id ? null : s.product_id); setUnit(s.unit); }}>
                    {selected === s.product_id ? 'Hide history' : 'History & adjust'}
                  </Button>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {selected && row && (
        <Card className="space-y-3 p-4">
          <h3 className="font-semibold text-text-primary">{row.product?.name}</h3>
          {canManage && (
            <div className="grid gap-3 sm:grid-cols-4">
              <SelectField label="Action" value={kind} onChange={(v) => setKind(v as Kind)}>
                <option value="receipt">Receive stock</option>
                <option value="count">Physical count</option>
                <option value="adjustment">Adjust (+/−)</option>
              </SelectField>
              <Input label="Quantity" type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
              <SelectField label="Unit" value={unit} onChange={setUnit}>
                {PRODUCT_UNITS.filter((u) => unitFamily(u) === unitFamily(row.unit)).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
              </SelectField>
              <div className="flex items-end">
                <Button size="sm" loading={busy} disabled={qtyBad} disabledReason={qtyBad ? 'Enter a valid quantity' : undefined} onClick={() => void act(() => adjustStock({ productId: row.product_id, kind, quantity: qtyNum, unit }), 'Stock updated').then(() => setQty(''))}>Apply</Button>
              </div>
            </div>
          )}
          <MovementList key={`${selected}:${historyTick}`} ownerId={ownerId} productId={selected} />
        </Card>
      )}

      {canManage && (
        <Card className="space-y-3 p-4">
          <h3 className="font-semibold text-text-primary">Track a product</h3>
          {products.loading && !products.data ? <Skeleton className="h-16 w-full" /> : untracked.length === 0 ? (
            <p className="text-sm text-text-secondary">All register products are tracked (or none exist yet — add products under Trade Packs).</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField label="Product" value={newProduct} onChange={setNewProduct}>
                <option value="">Choose…</option>
                {untracked.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
              </SelectField>
              <Input label="Opening count" type="number" min={0} step="any" value={opening} onChange={(e) => setOpening(e.target.value)} helperText="In the product’s unit." />
              <div className="flex items-end">
                <Button size="sm" loading={busy} disabled={!newProduct || Number(opening) < 0 || opening.trim() === ''} onClick={() => void act(() => enableStock(newProduct, Number(opening), null), 'Tracking started').then(() => setNewProduct(''))}>Start tracking</Button>
              </div>
            </div>
          )}
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void act(async () => { const n = await reconcileStock(); toast(n ? `${n} missing movement(s) added` : 'Everything is in sync', 'info'); }, 'Reconciled')}>Reconcile with treatment log</Button>
        </Card>
      )}
    </div>
  );
}

function MovementList({ ownerId, productId }: { ownerId: string; productId: string }) {
  const movements = useResource(() => fetchMovements(ownerId, productId));
  if (movements.loading && !movements.data) return <Skeleton className="h-20 w-full" />;
  if (movements.error) return <p className="text-sm text-danger" role="alert">{movements.error}</p>;
  if ((movements.data ?? []).length === 0) return <p className="text-sm text-text-secondary">No movements yet.</p>;
  return (
    <ul className="divide-y divide-border text-sm" aria-label="Stock movements">
      {(movements.data ?? []).map((m) => (
        <li key={m.id} className="flex flex-wrap justify-between gap-2 py-1.5">
          <span className="text-text-primary">{m.kind.replace('_', ' ')} {m.delta > 0 ? '+' : ''}{m.delta}{m.note ? ` · ${m.note}` : ''}</span>
          <span className="text-xs text-text-secondary">balance {m.balance_after} · {fmtDateTime(m.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
