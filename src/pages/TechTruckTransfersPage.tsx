import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ClipboardCheck, PackageCheck, RefreshCw, ScanLine, Truck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { BarcodeScanSheet } from '@/components/technician/BarcodeScanSheet';
import { TransferLineConfirm } from '@/components/technician/TransferLineConfirm';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { TONE_CLASSES } from '@/lib/truckStock';
import {
  AUDIT_STATUS_META,
  canComplete,
  completeTransfer,
  describeStatus,
  getMyVan,
  isOk,
  listTransfers,
  listVanAudits,
  opsErrorMessage,
  startVanAudit,
  transferProgress,
  type MyVan,
  type TransferOrder,
  type VanAuditRow,
} from '@/lib/truckOps';
import {
  countErrorMessage,
  countInventoryPart,
  getInventoryCountLines,
  parseQuantityInput,
  setInventoryCountLine,
  submitInventoryCount,
  type InventoryCountLine,
} from '@/lib/inventoryCounts';

type LoadState = 'loading' | 'ready' | 'error' | 'blocked';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4';
const bigBtn =
  'focus-ring flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-base font-semibold text-white disabled:opacity-50';

export function TechTruckTransfersPage() {
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [van, setVan] = useState<MyVan | null>(null);
  const [incoming, setIncoming] = useState<TransferOrder[]>([]);
  const [preparing, setPreparing] = useState<TransferOrder[]>([]);
  const [audit, setAudit] = useState<VanAuditRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const me = await getMyVan();
      setVan(me);
      if (me.status !== 'ok' || !me.van_id) {
        setState('blocked');
        return;
      }
      const [orders, audits] = await Promise.all([
        listTransfers({ statuses: ['open', 'in_transit'], toLocationId: me.van_id }),
        listVanAudits(),
      ]);
      setIncoming(orders.filter((o) => o.status === 'in_transit'));
      setPreparing(orders.filter((o) => o.status === 'open'));
      setAudit(audits.find((a) => a.location_id === me.van_id) ?? null);
      setError(null);
      setState('ready');
    } catch (err) {
      setError(opsErrorMessage(err));
      setState((s) => (s === 'ready' ? 'ready' : 'error'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  let body: ReactNode;
  if (state === 'loading') {
    body = (
      <div className="space-y-3" role="status" aria-label="Loading">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  } else if (state === 'blocked') {
    body = (
      <EmptyState
        icon={Truck}
        title={van?.status === 'no_truck' ? 'No truck assigned yet' : 'This page is for technicians'}
        description={
          van?.status === 'no_truck'
            ? 'Ask the office to assign a truck to you. Deliveries and audits for it show up here.'
            : 'Office staff manage transfers under Truck Operations.'
        }
        action={{ label: 'Check again', onClick: () => void load() }}
      />
    );
  } else if (state === 'error') {
    body = (
      <EmptyState icon={AlertTriangle} title="Couldn't load your truck" description={error ?? 'Try again.'} action={{ label: 'Try again', onClick: () => void load() }} />
    );
  } else {
    body = (
      <div className="space-y-5">
        {error && <p role="status" className="rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">Couldn't refresh just now — showing what was loaded last.</p>}

        <section aria-label="Deliveries to your truck" className="space-y-3">
          <h2 className="text-base font-semibold text-text-primary">Deliveries to {van?.van_name ?? 'your truck'}</h2>
          {incoming.length === 0 ? (
            <p className={`${card} text-sm text-text-secondary`}>
              {preparing.length > 0
                ? `${preparing.length} transfer(s) are being picked at the warehouse. They appear here once shipped.`
                : 'Nothing on the way to your truck right now.'}
            </p>
          ) : (
            incoming.map((o) => <IncomingTransfer key={o.id} order={o} onChanged={() => void load()} />)
          )}
        </section>

        <section aria-label="Van audit" className="space-y-3">
          <h2 className="text-base font-semibold text-text-primary">Van audit</h2>
          <AuditCard audit={audit} onChanged={() => void load()} toast={toast} />
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-16">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-3">
          <Link to="/tech/truck-stock" aria-label="Back to truck stock" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-text-primary">Deliveries &amp; audit</h1>
            <p className="truncate text-xs text-text-secondary">{van?.van_name ?? 'Your truck'}</p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            aria-label="Refresh"
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary disabled:opacity-40"
          >
            <RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-lg px-4 pt-4">{body}</main>
    </div>
  );
}

// ============================================================
// INCOMING TRANSFER
// ============================================================

function IncomingTransfer({ order, onChanged }: { order: TransferOrder; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const progress = transferProgress(order);

  const finish = async () => {
    setBusy(true);
    try {
      const result = await completeTransfer(order.id);
      if (isOk(result, 'completed')) {
        const short = result.short_lines as number;
        toast(short > 0 ? 'Received. The office was told some parts arrived short.' : 'All parts received into your truck.', short > 0 ? 'info' : 'success');
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
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{order.transfer_number}</p>
          <p className="text-xs text-text-secondary">From {order.from_location?.name ?? 'warehouse'}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES.warning}`}>
          {progress.confirmed}/{progress.lines} checked
        </span>
      </div>
      <p className="mt-2 text-xs text-text-secondary">Scan each part as you load it. If fewer arrived than shipped, enter the number you actually received.</p>
      <ul className="mt-3 space-y-2">
        {order.lines
          .filter((l) => l.qty_picked > 0)
          .map((l) => (
            <TransferLineConfirm key={`${l.id}-${l.received_at ?? ''}`} line={l} stage="receive" onConfirmed={onChanged} large />
          ))}
      </ul>
      <button type="button" className={`${bigBtn} mt-4`} disabled={busy || !canComplete(order)} onClick={() => void finish()}>
        <PackageCheck className="h-5 w-5" aria-hidden /> {busy ? 'Finishing…' : 'Finish receiving'}
      </button>
      {!canComplete(order) && <p className="mt-2 text-center text-xs text-text-secondary">Check every line to finish.</p>}
    </div>
  );
}

// ============================================================
// VAN AUDIT
// ============================================================

function AuditCard({ audit, onChanged, toast }: { audit: VanAuditRow | null; onChanged: () => void; toast: (m: string, t?: 'success' | 'error' | 'info') => void }) {
  const [busy, setBusy] = useState(false);
  const [countId, setCountId] = useState<string | null>(audit?.open_count_id ?? null);

  useEffect(() => {
    setCountId(audit?.open_count_id ?? null);
  }, [audit?.open_count_id]);

  if (!audit) {
    return <p className={`${card} text-sm text-text-secondary`}>Audit details aren't available for your truck yet.</p>;
  }
  const meta = AUDIT_STATUS_META[audit.audit_status];

  const start = async () => {
    setBusy(true);
    try {
      const result = await startVanAudit(audit.location_id);
      if (isOk(result, 'started', 'already_open')) {
        setCountId(String(result.count_id));
        onChanged();
      } else {
        toast(describeStatus(result), 'error');
      }
    } catch (err) {
      toast(countErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (countId) {
    return <AuditCounter countId={countId} onDone={() => { setCountId(null); onChanged(); }} />;
  }

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-text-primary">
          {audit.last_audit_at ? `Last audit ${new Date(audit.last_audit_at).toLocaleDateString()}` : 'Never audited'}
          {audit.last_accuracy_pct !== null && ` · ${Number(audit.last_accuracy_pct)}% accurate`}
        </p>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[meta.tone]}`}>{meta.label}</span>
      </div>
      <p className="mt-2 text-xs text-text-secondary">Count what is physically on your truck. You won't see the expected numbers — that keeps the count honest.</p>
      <button type="button" className={`${bigBtn} mt-3`} disabled={busy} onClick={() => void start()}>
        <ClipboardCheck className="h-5 w-5" aria-hidden /> {busy ? 'Starting…' : 'Start van audit'}
      </button>
    </div>
  );
}

function AuditCounter({ countId, onDone }: { countId: string; onDone: () => void }) {
  const { toast } = useToast();
  const [lines, setLines] = useState<InventoryCountLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setLines(await getInventoryCountLines(countId));
      setError(null);
    } catch (err) {
      setError(countErrorMessage(err));
    }
  }, [countId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onScan = async (code: string) => {
    setScanOpen(false);
    try {
      const r = await countInventoryPart({ countId, barcode: code, increment: 1 });
      toast(`${r.part_name}: ${r.counted_qty} counted`, 'success');
      setDrafts((d) => {
        const next = { ...d };
        delete next[r.line_id];
        return next;
      });
      await load();
    } catch (err) {
      toast(countErrorMessage(err, "That code didn't match a part on this truck."), 'error');
    }
  };

  const setQty = async (line: InventoryCountLine) => {
    const raw = drafts[line.line_id];
    if (raw === undefined) return;
    const parsed = parseQuantityInput(raw);
    if (!parsed.ok) {
      toast(parsed.error, 'error');
      return;
    }
    try {
      await setInventoryCountLine(line.line_id, parsed.value);
      setDrafts((d) => {
        const next = { ...d };
        delete next[line.line_id];
        return next;
      });
      await load();
    } catch (err) {
      toast(countErrorMessage(err), 'error');
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await submitInventoryCount(countId, false);
      toast('Audit submitted. The office will review it.', 'success');
      onDone();
    } catch (err) {
      toast(countErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error && !lines) {
    return <EmptyState icon={AlertTriangle} title="Couldn't load the audit" description={error} action={{ label: 'Try again', onClick: () => void load() }} />;
  }
  if (!lines) return <Skeleton className="h-28 w-full rounded-2xl" />;

  const counted = lines.filter((l) => l.counted_qty !== null).length;
  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">Counting your truck</p>
        <span className="text-xs text-text-secondary">{counted}/{lines.length} counted</span>
      </div>
      <button type="button" className={`${bigBtn} mt-3`} onClick={() => setScanOpen(true)}>
        <ScanLine className="h-5 w-5" aria-hidden /> Scan a part (+1)
      </button>
      <ul className="mt-3 space-y-2">
        {lines.map((l) => (
          <li key={l.line_id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">{l.part_name}</p>
              {l.part_number && <p className="truncate text-xs text-text-secondary">{l.part_number}</p>}
            </div>
            <input
              aria-label={`Counted ${l.part_name}`}
              inputMode="numeric"
              placeholder="—"
              value={drafts[l.line_id] ?? (l.counted_qty === null ? '' : String(l.counted_qty))}
              onChange={(e) => setDrafts((d) => ({ ...d, [l.line_id]: e.target.value }))}
              onBlur={() => void setQty(l)}
              className="focus-ring h-11 w-20 rounded-lg border border-border bg-bg-secondary text-center text-base text-text-primary"
            />
          </li>
        ))}
      </ul>
      <button type="button" className={`${bigBtn} mt-4`} disabled={busy || counted < lines.length} onClick={() => void submit()}>
        {busy ? 'Submitting…' : 'Submit audit'}
      </button>
      {counted < lines.length && <p className="mt-2 text-center text-xs text-text-secondary">Count every part (enter 0 if none) to submit.</p>}
      <BarcodeScanSheet open={scanOpen} onClose={() => setScanOpen(false)} onCode={(c) => void onScan(c)} hint="Scan each unit, or type the count in the list" />
    </div>
  );
}
