/**
 * Webhook delivery console — pure logic (no React, no network). The payload column is never read here:
 * the console shows delivery metadata only, so event bodies (which may contain customer PII) stay server-side.
 */

export const DELIVERY_STATUSES = ['pending', 'delivering', 'delivered', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryFilter = 'all' | DeliveryStatus;

export const DELIVERY_COLUMNS =
  'id, endpoint_id, delivery_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error, replay_count, created_at, delivered_at';

export const FILTERS: { value: DeliveryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dead', label: 'Dead letters' },
  { value: 'pending', label: 'Retrying' },
  { value: 'delivered', label: 'Delivered' },
];

export interface Delivery {
  id: string;
  endpointId: string;
  deliveryId: string;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  replayCount: number;
  createdAt: string;
  deliveredAt: string | null;
}

const isStatus = (v: unknown): v is DeliveryStatus => typeof v === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown, fallback: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback);

/** Maps a database row; returns null for a row that is not a valid delivery (never throws). */
export function toDelivery(row: unknown): Delivery | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = str(r.id);
  const endpointId = str(r.endpoint_id);
  const deliveryId = str(r.delivery_id);
  const eventType = str(r.event_type);
  const createdAt = str(r.created_at);
  if (!id || !endpointId || !deliveryId || !eventType || !createdAt || !isStatus(r.status)) return null;
  return {
    id,
    endpointId,
    deliveryId,
    eventType,
    status: r.status,
    attempts: int(r.attempts, 0) ?? 0,
    nextAttemptAt: str(r.next_attempt_at),
    lastStatusCode: int(r.last_status_code, null),
    lastError: str(r.last_error),
    replayCount: int(r.replay_count, 0) ?? 0,
    createdAt,
    deliveredAt: str(r.delivered_at),
  };
}

export function toDeliveries(rows: unknown): Delivery[] {
  return Array.isArray(rows) ? rows.map(toDelivery).filter((d): d is Delivery => d !== null) : [];
}

/** The RPC only accepts dead or delivered rows; anything in flight must not offer a replay button. */
export function canReplay(d: Pick<Delivery, 'status'>): boolean {
  return d.status === 'dead' || d.status === 'delivered';
}

export function statusLabel(s: DeliveryStatus): string {
  return { pending: 'Retrying', delivering: 'Sending', delivered: 'Delivered', dead: 'Dead letter' }[s];
}

export function summarize(rows: readonly Delivery[]): Record<DeliveryStatus, number> {
  const out: Record<DeliveryStatus, number> = { pending: 0, delivering: 0, delivered: 0, dead: 0 };
  for (const d of rows) out[d.status] += 1;
  return out;
}

export function applyFilter(rows: readonly Delivery[], filter: DeliveryFilter): Delivery[] {
  if (filter === 'all') return [...rows];
  if (filter === 'pending') return rows.filter((d) => d.status === 'pending' || d.status === 'delivering');
  return rows.filter((d) => d.status === filter);
}

/** Maps RPC/PostgREST errors to a message safe to show; never echoes raw database text. */
export function friendlyReplayError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '').toLowerCase();
  if (msg.includes('not authorized')) return 'Only account owners and security admins can replay deliveries.';
  if (msg.includes('in flight') || msg.includes('not found')) return 'This delivery is no longer replayable. Refresh the list.';
  return 'Could not replay the delivery. Try again.';
}

export function formatWhen(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return `in ${Math.max(1, Math.round(-s / 60))} min`;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
