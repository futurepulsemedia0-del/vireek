import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlugZap, RefreshCw, RotateCcw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import {
  FILTERS,
  applyFilter,
  canReplay,
  formatWhen,
  friendlyReplayError,
  statusLabel,
  summarize,
  type Delivery,
  type DeliveryFilter,
  type DeliveryStatus,
} from '@/lib/webhookDeliveries';
import { fetchDeliveries, replayDelivery, DELIVERY_PAGE_SIZE } from '@/lib/webhookDeliveriesApi';

const LABEL = 'Webhook Deliveries';

const STATUS_STYLE: Record<DeliveryStatus, string> = {
  pending: 'bg-warning-500/10 text-warning-500',
  delivering: 'bg-accent/10 text-accent',
  delivered: 'bg-success/10 text-success',
  dead: 'bg-danger/10 text-danger',
};

function StatusBadge({ status }: { status: DeliveryStatus }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[status]}`}>{statusLabel(status)}</span>;
}

export function WebhookDeliveriesPage() {
  const { profile, isOwner } = useAuth();
  const { toast } = useToast();
  const { ready, isEnabled } = useFeatureFlags();
  const enabled = isEnabled('public_api_v2');
  const ownerId = isOwner ? profile?.id : undefined;

  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<DeliveryFilter>('dead');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const id = ++req.current;
    setRefreshing(true);
    try {
      const data = await fetchDeliveries(ownerId);
      if (id !== req.current) return;
      setRows(data);
      setFailed(false);
    } catch {
      if (id !== req.current) return;
      setFailed(true);
    } finally {
      if (id === req.current) setRefreshing(false);
    }
  }, [ownerId]);

  useEffect(() => {
    if (enabled && ownerId) void load();
  }, [enabled, ownerId, load]);

  const counts = useMemo(() => summarize(rows ?? []), [rows]);
  const visible = useMemo(() => applyFilter(rows ?? [], filter), [rows, filter]);

  const onReplay = async (d: Delivery) => {
    setReplayingId(d.id);
    try {
      await replayDelivery(d.id);
      toast('Delivery queued for replay. Receivers de-duplicate on the same delivery ID.', 'success');
      setConfirmId(null);
      await load();
    } catch (err) {
      toast(friendlyReplayError(err), 'error');
    } finally {
      setReplayingId(null);
    }
  };

  const header = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><PlugZap size={22} aria-hidden="true" /> Webhook Deliveries</h1>
        <p className="mt-1 text-sm text-text-secondary">Delivery log, dead-letter queue and replay for your outbound webhooks. Event bodies are never shown here.</p>
      </div>
      {enabled && ownerId && (
        <button type="button" onClick={() => void load()} disabled={refreshing} aria-label="Refresh deliveries" className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary disabled:opacity-50">
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  if (!ready) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        {header}
        <div className="space-y-3" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-bg-tertiary" />)}
        </div>
      </DashboardLayout>
    );
  }

  if (!enabled) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        {header}
        <EmptyState variant="no-permission" icon={PlugZap} title="Not enabled for your account" description="The webhook delivery console is part of Public API v2. Contact support to enable it." />
      </DashboardLayout>
    );
  }

  if (!ownerId) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        {header}
        <EmptyState variant="no-permission" icon={PlugZap} title="Account owner only" description="Only the account owner can view and replay webhook deliveries." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={LABEL}>
      {header}

      {rows === null && !failed ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading deliveries">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-2xl bg-bg-tertiary" />)}
        </div>
      ) : failed && rows === null ? (
        <EmptyState variant="load-failed" title="Could not load deliveries" description="Check your connection and try again." onRetry={() => void load()} />
      ) : (
        <>
          <div role="radiogroup" aria-label="Filter deliveries" className="mb-4 inline-flex flex-wrap rounded-xl border border-border bg-bg-primary p-1">
            {FILTERS.map((f) => {
              const n = f.value === 'all' ? (rows ?? []).length : f.value === 'pending' ? counts.pending + counts.delivering : counts[f.value];
              return (
                <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} onClick={() => setFilter(f.value)} className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium ${filter === f.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                  {f.label} <span className="tabular-nums opacity-80">({n})</span>
                </button>
              );
            })}
          </div>
          <p className="sr-only" role="status" aria-live="polite">{visible.length} deliveries shown</p>

          {visible.length === 0 ? (
            <EmptyState variant="no-data" icon={PlugZap} title={filter === 'dead' ? 'No dead letters' : 'No deliveries'} description={filter === 'dead' ? 'Every delivery has either succeeded or is still being retried.' : 'Deliveries appear here once an event is sent to one of your endpoints.'} />
          ) : (
            <Card className="overflow-hidden p-0 hover:translate-y-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <caption className="sr-only">Outbound webhook deliveries, newest first</caption>
                  <thead>
                    <tr className="border-b border-border text-xs text-text-secondary">
                      <th scope="col" className="px-4 py-3 font-medium">Event</th>
                      <th scope="col" className="px-4 py-3 font-medium">Status</th>
                      <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
                      <th scope="col" className="px-4 py-3 font-medium">HTTP</th>
                      <th scope="col" className="px-4 py-3 font-medium">Last error</th>
                      <th scope="col" className="px-4 py-3 font-medium">Created</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((d) => (
                      <tr key={d.id} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 text-sm font-medium text-text-primary">{d.eventType}{d.replayCount > 0 && <span className="ml-2 text-[11px] font-normal text-text-secondary">replayed ×{d.replayCount}</span>}</td>
                        <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                        <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">{d.attempts}</td>
                        <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">{d.lastStatusCode ?? '—'}</td>
                        <td className="max-w-[220px] truncate px-4 py-3 text-xs text-text-secondary" title={d.lastError ?? ''}>{d.lastError ?? '—'}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-text-secondary" title={d.createdAt}>{formatWhen(d.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          {canReplay(d) ? (
                            confirmId === d.id ? (
                              <span className="inline-flex items-center gap-2">
                                <button type="button" disabled={replayingId === d.id} onClick={() => void onReplay(d)} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{replayingId === d.id ? 'Queuing…' : 'Confirm replay'}</button>
                                <button type="button" disabled={replayingId === d.id} onClick={() => setConfirmId(null)} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary">Cancel</button>
                              </span>
                            ) : (
                              <button type="button" onClick={() => setConfirmId(d.id)} aria-label={`Replay ${d.eventType} delivery`} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary">
                                <RotateCcw size={13} aria-hidden="true" /> Replay
                              </button>
                            )
                          ) : (
                            <span className="text-xs text-text-secondary">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <p className="mt-3 text-xs text-text-secondary">Showing the latest {DELIVERY_PAGE_SIZE} deliveries. Replays keep the original delivery ID so receivers can de-duplicate, and every replay is recorded in an append-only audit log.</p>
          {failed && <p role="alert" className="mt-2 text-xs text-danger">The last refresh failed; showing earlier data.</p>}
        </>
      )}
    </DashboardLayout>
  );
}
