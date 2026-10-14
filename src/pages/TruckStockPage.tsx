import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CloudOff, Package, PackagePlus, RefreshCw, ScanLine, Search, Truck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useTruckStock } from '@/hooks/useTruckStock';
import { BarcodeScanSheet } from '@/components/technician/BarcodeScanSheet';
import { TruckStockActionSheet, type ActionMode } from '@/components/technician/TruckStockActionSheet';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { TONE_CLASSES, TRUCK_STATUS_META } from '@/lib/truckStock';
import {
  availableQty,
  describeOp,
  filterItems,
  findPartByCode,
  formatAgo,
  itemFromCatalog,
  sortItems,
  stockLevel,
  type ItemFilter,
  type NewOp,
  type TruckItem,
} from '@/lib/truckStockField';

interface SheetState {
  item: TruckItem;
  onTruck: boolean;
  mode: ActionMode;
  fromScan: boolean;
}

const FILTERS: { id: ItemFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'restock', label: 'Needs restock' },
  { id: 'requested', label: 'Requested' },
];

const BAR_COLOR = { ok: 'bg-success-500', low: 'bg-warning-500', empty: 'bg-danger' } as const;

export function TruckStockPage() {
  const stock = useTruckStock();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [scanOpen, setScanOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // Re-render the "synced 3 min ago" label.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const snapshot = stock.snapshot;
  const items = useMemo(() => (snapshot ? sortItems(snapshot.items) : []), [snapshot]);
  const visible = useMemo(() => filterItems(items, query, filter), [items, query, filter]);
  const needsRestock = useMemo(() => items.filter((i) => stockLevel(i) !== 'ok').length, [items]);

  const openForCode = useCallback(
    (code: string, fromScan: boolean): boolean => {
      if (!snapshot) return false;
      const match = findPartByCode(snapshot, code);
      if (match.kind === 'on_truck') {
        setSheet({ item: match.item, onTruck: true, mode: 'use', fromScan });
        setUnknownCode(null);
        return true;
      }
      if (match.kind === 'catalog') {
        setSheet({ item: itemFromCatalog(match.part), onTruck: false, mode: 'use', fromScan });
        setUnknownCode(null);
        return true;
      }
      setUnknownCode(match.code);
      return false;
    },
    [snapshot],
  );

  const onScanCode = useCallback(
    (code: string) => {
      setScanOpen(false);
      openForCode(code, true);
    },
    [openForCode],
  );

  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) openForCode(query, false);
  };

  const closeSheet = useCallback(() => setSheet(null), []);

  const onSubmitOp = (op: NewOp, options: { scanNext: boolean }) => {
    const current = sheet;
    const stored = stock.submit(op); // throws on invalid input; the sheet shows the message
    const offline = !stock.online;
    let message = `${describeOp(stored)}${offline ? ' — saved, will sync when you have signal' : ''}`;
    if (op.kind === 'use' && current?.onTruck) {
      const after = availableQty(current.item) - op.quantity;
      if (current.item.min_quantity !== null && after <= current.item.min_quantity && current.item.requested_qty === 0) {
        message += `. Low on ${current.item.name} (${Math.max(after, 0)} left) — request a restock.`;
      }
    }
    toast(message, 'success');
    setSheet(null);
    if (options.scanNext) setScanOpen(true);
  };

  // ---------- header ----------
  const syncLabel = !stock.online
    ? 'Offline'
    : stock.refreshing
      ? 'Syncing…'
      : stock.pendingCount > 0
        ? `${stock.pendingCount} waiting`
        : `Synced ${formatAgo(stock.syncedAt)}`;
  const syncTone = !stock.online ? 'warning' : stock.failedCount > 0 ? 'danger' : stock.pendingCount > 0 ? 'accent' : 'neutral';

  const header = (
    <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <Link to="/tech/today" aria-label="Back to today's jobs" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-text-primary">Truck stock</h1>
          <p className="truncate text-xs text-text-secondary">
            {snapshot ? `${snapshot.location.name} · ${items.length} part${items.length === 1 ? '' : 's'}${needsRestock ? ` · ${needsRestock} to restock` : ''}` : 'Your truck inventory'}
          </p>
        </div>
        <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[syncTone]}`} role="status">
          {!stock.online && <CloudOff className="h-3.5 w-3.5" aria-hidden />}
          {syncLabel}
        </span>
        <button
          type="button"
          onClick={() => void stock.refresh()}
          disabled={stock.refreshing || !stock.online}
          aria-label="Refresh stock"
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary disabled:opacity-40"
        >
          <RefreshCw className={`h-5 w-5 ${stock.refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </header>
  );

  // ---------- states ----------
  let body: ReactNode;
  if (stock.status === 'loading') {
    body = (
      <div className="space-y-3" role="status" aria-label="Loading truck stock">
        <Skeleton className="h-12 w-full rounded-xl" />
        {[0, 1, 2, 3].map((n) => (
          <Skeleton key={n} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
    );
  } else if (stock.status === 'blocked') {
    body =
      stock.blocked === 'no_truck' ? (
        <EmptyState
          icon={Truck}
          title="No truck assigned yet"
          description="Ask the office to assign a truck to you. Once they do, its stock shows up here."
          action={{ label: 'Check again', onClick: () => void stock.refresh() }}
        />
      ) : (
        <EmptyState
          icon={Truck}
          title="This page is for technicians"
          description="Truck stock follows the technician who drives the truck. Office staff manage parts and trucks under Parts & Inventory."
        />
      );
  } else if (stock.status === 'error' || !snapshot) {
    body = (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load truck stock"
        description={stock.online ? (stock.error ?? 'Something went wrong. Try again.') : 'You are offline and this truck has not been saved on this device yet. Connect once to load it.'}
        action={{ label: 'Try again', onClick: () => void stock.refresh() }}
      />
    );
  } else {
    body = (
      <>
        {!stock.online && (
          <p role="status" className="mb-3 flex gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
            <CloudOff className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
            <span>
              You're offline. Showing stock as of {formatAgo(stock.syncedAt)}. Anything you record is saved on this device and sent automatically when signal returns.
            </span>
          </p>
        )}
        {stock.online && stock.error && (
          <p role="status" className="mb-3 rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
            Couldn't refresh just now — showing the last saved stock.{' '}
            <button type="button" onClick={() => void stock.refresh()} className="font-semibold underline">Retry</button>
          </p>
        )}

        {stock.queue.length > 0 && (
          <details className="mb-3 rounded-2xl border border-border bg-bg-secondary" open={stock.failedCount > 0}>
            <summary className="flex min-h-[3rem] cursor-pointer items-center justify-between px-4 text-sm font-medium text-text-primary">
              <span>
                {stock.pendingCount > 0 ? `${stock.pendingCount} waiting to sync` : 'Needs attention'}
                {stock.failedCount > 0 && <span className="ml-2 text-danger">{stock.failedCount} failed</span>}
              </span>
            </summary>
            <ul className="divide-y divide-border border-t border-border">
              {stock.queue.map((op) => (
                <li key={op.id} className="px-4 py-3 text-sm">
                  <p className="text-text-primary">{describeOp(op)}</p>
                  {op.state === 'failed' ? (
                    <>
                      <p className="mt-1 text-xs text-danger">{op.last_error ?? 'This could not be recorded.'}</p>
                      <div className="mt-2 flex gap-2">
                        <button type="button" onClick={() => stock.retry(op.id)} className="h-10 rounded-lg border border-border px-4 text-xs font-semibold text-text-primary">Try again</button>
                        <button type="button" onClick={() => stock.discard(op.id)} className="h-10 rounded-lg px-4 text-xs font-semibold text-danger">Discard</button>
                      </div>
                    </>
                  ) : (
                    <p className="mt-0.5 text-xs text-text-secondary">{stock.online ? 'Sending…' : 'Will send when you are back online'}</p>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {unknownCode && (
          <div role="alert" className="mb-3 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm">
            <p className="font-medium text-text-primary">No part matches “{unknownCode}”</p>
            <p className="mt-1 text-text-secondary">It isn't in the parts catalog. Check the code, or ask the office to add the part.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => { setUnknownCode(null); setScanOpen(true); }} className="h-10 rounded-lg bg-accent px-4 text-xs font-semibold text-white">Scan again</button>
              <button type="button" onClick={() => setUnknownCode(null)} className="h-10 rounded-lg px-4 text-xs font-semibold text-text-secondary">Dismiss</button>
            </div>
          </div>
        )}

        <form onSubmit={onSearchSubmit} role="search" className="mb-3">
          <label className="relative block">
            <span className="sr-only">Search parts</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, part number or barcode"
              enterKeyHint="search"
              className="h-12 w-full rounded-xl border border-border bg-bg-secondary pl-10 pr-3 text-base text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none"
            />
          </label>
        </form>

        <div className="mb-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter parts">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`h-10 flex-shrink-0 rounded-full border px-4 text-sm font-medium ${filter === f.id ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary'}`}
            >
              {f.label}
              {f.id === 'restock' && needsRestock > 0 ? ` (${needsRestock})` : ''}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Nothing on this truck yet"
            description="Once the office loads parts onto your truck (or sets par levels), they appear here. You can still scan a part to record usage."
            action={{ label: 'Scan a part', onClick: () => setScanOpen(true) }}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No parts match"
            description={query ? `Nothing on your truck matches “${query}”.` : 'Nothing in this filter right now.'}
            action={{ label: 'Clear search and filter', onClick: () => { setQuery(''); setFilter('all'); } }}
          />
        ) : (
          <ul className="space-y-3">
            {visible.map((item) => {
              const level = stockLevel(item);
              const avail = availableQty(item);
              const pct = item.target_quantity ? Math.min(Math.max((avail / item.target_quantity) * 100, 0), 100) : null;
              return (
                <li key={item.part_id} className="rounded-2xl border border-border bg-bg-secondary">
                  <button
                    type="button"
                    onClick={() => setSheet({ item, onTruck: true, mode: 'use', fromScan: false })}
                    className="block w-full rounded-2xl p-4 text-left active:scale-[0.99]"
                    aria-label={`${item.name}, ${avail} on truck, ${TRUCK_STATUS_META[level].label}. Open actions`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-text-primary">{item.name}</p>
                        <p className="truncate text-xs text-text-secondary">{item.part_number ?? item.barcode ?? 'No part number'}</p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className="text-2xl font-semibold tabular-nums leading-none text-text-primary">{avail}</p>
                        {item.target_quantity !== null && <p className="mt-1 text-[11px] text-text-secondary">of {item.target_quantity}</p>}
                      </div>
                    </div>
                    {pct !== null && (
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden>
                        <div className={`h-full rounded-full ${BAR_COLOR[level]}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[TRUCK_STATUS_META[level].tone]}`}>{TRUCK_STATUS_META[level].label}</span>
                      {item.requested_qty > 0 && (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES.accent}`}>{item.requested_qty} requested</span>
                      )}
                      {item.reserved > 0 && <span className="text-xs text-text-secondary">{item.reserved} reserved for jobs</span>}
                    </div>
                  </button>
                  {level !== 'ok' && item.requested_qty === 0 && (
                    <div className="border-t border-border px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setSheet({ item, onTruck: true, mode: 'request', fromScan: false })}
                        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-accent active:bg-accent/5"
                      >
                        <PackagePlus className="h-4 w-4" aria-hidden /> Request restock
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  const canScan = stock.status === 'ready' && !!snapshot;

  return (
    <div className="min-h-screen bg-bg-primary pb-32">
      {header}
      <main className="mx-auto max-w-lg px-4 py-4">{body}</main>

      {canScan && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-bg-primary via-bg-primary/90 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8">
          <button
            type="button"
            onClick={() => { setUnknownCode(null); setScanOpen(true); }}
            className="pointer-events-auto flex h-14 w-full max-w-lg items-center justify-center gap-2 rounded-2xl bg-accent text-base font-semibold text-white shadow-lg active:scale-[0.98]"
          >
            <ScanLine className="h-5 w-5" aria-hidden /> Scan part
          </button>
        </div>
      )}

      <BarcodeScanSheet open={scanOpen} onClose={() => setScanOpen(false)} onCode={onScanCode} />

      {sheet && snapshot && (
        <TruckStockActionSheet
          key={sheet.item.part_id}
          item={sheet.item}
          onTruck={sheet.onTruck}
          mode={sheet.mode}
          jobs={snapshot.jobs}
          vendors={snapshot.vendors}
          fromScan={sheet.fromScan}
          onModeChange={(mode) => setSheet((s) => (s ? { ...s, mode } : s))}
          onSubmit={onSubmitOp}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}
