// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { formatMoney } from '@/lib/partsOrdering';
import { decideOrder, listOpenOrders, receiveOrder, type OrderRow } from '@/lib/partsSourcingApi';
import { Chip, EmptyState, ErrorNote, LoadingRow, card, type ChipTone } from './shared';

const STATUS: Record<OrderRow['status'], { label: string; tone: ChipTone }> = {
  pending_approval: { label: 'Needs approval', tone: 'warn' },
  sent: { label: 'Sent to vendor', tone: 'info' },
  partially_received: { label: 'Partly received', tone: 'info' },
};

function fmtDay(iso: string | null): string {
  if (!iso) return 'No date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'No date' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type Action = 'approve' | 'reject' | 'receive';

/** Open purchase orders: managers approve/reject over-threshold orders and receive stock. The server re-checks role. */
export function OrdersTab() {
  const { toast } = useToast();
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Receiving changes stock levels, so it needs a second, deliberate click.
  const [confirmReceive, setConfirmReceive] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await listOpenOrders();
      if (alive.current) setRows(data);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not load orders.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (row: OrderRow, action: Action) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(`${row.id}:${action}`);
    try {
      if (action === 'receive') await receiveOrder(row.id);
      else await decideOrder(row.id, action);
      toast(action === 'approve' ? `${row.po_number} approved.` : action === 'reject' ? `${row.po_number} rejected.` : `${row.po_number} received into stock.`, 'success');
      setConfirmReceive(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed.', 'error');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  };

  if (error && !rows) return <ErrorNote message={error} onRetry={() => void load()} />;
  if (!rows) return <LoadingRow text="Loading orders…" />;

  return (
    <div className={card}>
      <h2 className="text-base font-semibold text-text-primary">Open orders</h2>
      <p className="mt-0.5 text-xs text-text-secondary">Orders waiting for approval or delivery.</p>
      {error && <div className="mt-3"><ErrorNote message={error} onRetry={() => void load()} /></div>}

      {rows.length === 0 ? (
        <div className="mt-4"><EmptyState>No open orders.</EmptyState></div>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {rows.map((o) => {
            const s = STATUS[o.status] ?? { label: o.status, tone: 'neutral' as ChipTone };
            const rowBusy = busy?.startsWith(`${o.id}:`) ?? false;
            return (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                    {o.po_number}
                    <Chip tone={s.tone}>{s.label}</Chip>
                  </p>
                  <p className="text-xs text-text-secondary">
                    {o.vendor_name ?? 'Unknown vendor'} · {formatMoney(o.total_cents)} · Expected {fmtDay(o.expected_at)} · Created {fmtDay(o.created_at)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {o.status === 'pending_approval' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void act(o, 'reject')} loading={busy === `${o.id}:reject`} disabled={rowBusy}>Reject</Button>
                      <Button size="sm" onClick={() => void act(o, 'approve')} loading={busy === `${o.id}:approve`} disabled={rowBusy}>Approve</Button>
                    </>
                  )}
                  {(o.status === 'sent' || o.status === 'partially_received') &&
                    (confirmReceive === o.id ? (
                      <>
                        <span className="text-xs text-text-secondary">Add all lines to stock?</span>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmReceive(null)} disabled={rowBusy}>Cancel</Button>
                        <Button size="sm" onClick={() => void act(o, 'receive')} loading={busy === `${o.id}:receive`} disabled={rowBusy}>Yes, receive</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setConfirmReceive(o.id)} disabled={rowBusy}>Receive</Button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
