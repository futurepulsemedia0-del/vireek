// Local-first outbox for time clock events. Storage is injected (localStorage in the app,
// an in-memory fake in tests). Events are kept until the server confirms them.

import type { ClockEvent } from '@/lib/timeClock';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RejectedEvent {
  event: ClockEvent;
  code: string;
}

export interface QueueState {
  pending: ClockEvent[];
  rejected: RejectedEvent[];
}

export interface SendResult {
  id: string;
  outcome: 'applied' | 'duplicate' | 'rejected' | 'error';
  code?: string | null;
}

export const EMPTY_QUEUE: QueueState = { pending: [], rejected: [] };
export const MAX_BATCH = 100;

const TYPES = new Set(['clock_in', 'clock_out', 'break_start', 'break_end', 'switch_job']);

function isEvent(v: unknown): v is ClockEvent {
  const e = v as Partial<ClockEvent> | null;
  return !!e && typeof e.id === 'string' && typeof e.shift_id === 'string' && typeof e.at === 'string' && typeof e.type === 'string' && TYPES.has(e.type);
}

export const queueKey = (userId: string) => `vireek.timeclock.queue.v1:${userId}`;

export function loadQueue(storage: StorageLike, key: string): QueueState {
  try {
    const raw = storage.getItem(key);
    if (!raw) return EMPTY_QUEUE;
    const parsed = JSON.parse(raw) as Partial<QueueState>;
    return {
      pending: Array.isArray(parsed.pending) ? parsed.pending.filter(isEvent) : [],
      rejected: Array.isArray(parsed.rejected) ? parsed.rejected.filter((r) => r && isEvent(r.event) && typeof r.code === 'string') : [],
    };
  } catch {
    return EMPTY_QUEUE;
  }
}

/** Returns false when the browser refused to persist (private mode / quota) so the UI can warn. */
export function saveQueue(storage: StorageLike, key: string, state: QueueState): boolean {
  try {
    if (state.pending.length === 0 && state.rejected.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function enqueue(state: QueueState, event: ClockEvent): QueueState {
  return state.pending.some((e) => e.id === event.id) ? state : { ...state, pending: [...state.pending, event] };
}

export function dismissRejected(state: QueueState, eventId?: string): QueueState {
  return { ...state, rejected: eventId ? state.rejected.filter((r) => r.event.id !== eventId) : [] };
}

export interface FlushOutcome {
  state: QueueState;
  /** Events the server accepted or already had. */
  confirmed: number;
  /** True when the network (or a transient server error) stopped the flush — retry later. */
  retry: boolean;
}

/**
 * Sends pending events in order. Confirmed events leave the queue; permanently rejected ones move to
 * `rejected` (so the technician sees them); anything without a confirmed result stays queued.
 */
export async function flushQueue(initial: QueueState, send: (events: ClockEvent[]) => Promise<SendResult[]>): Promise<FlushOutcome> {
  let state = initial;
  let confirmed = 0;
  while (state.pending.length > 0) {
    const batch = state.pending.slice(0, MAX_BATCH);
    let results: SendResult[];
    try {
      results = await send(batch);
    } catch {
      return { state, confirmed, retry: true };
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    const rejected: RejectedEvent[] = [];
    const keep: ClockEvent[] = [];
    let stopped = false;
    for (const ev of batch) {
      const r = stopped ? undefined : byId.get(ev.id);
      if (!r || r.outcome === 'error') {
        stopped = true; // order matters: nothing after an unconfirmed event may be dropped
        keep.push(ev);
      } else if (r.outcome === 'rejected') {
        rejected.push({ event: ev, code: r.code ?? 'tc_invalid_event' });
      } else {
        confirmed += 1;
      }
    }
    state = { pending: [...keep, ...state.pending.slice(MAX_BATCH)], rejected: [...state.rejected, ...rejected] };
    if (stopped) return { state, confirmed, retry: true };
  }
  return { state, confirmed, retry: false };
}
