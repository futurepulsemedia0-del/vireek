/**
 * Data-freshness policy (pure). Decides when a view should refetch and when
 * it should look stale; the hook/component only wire timers and DOM events.
 */
export type RealtimeState = 'live' | 'connecting' | 'reconnecting' | 'none';

export const STALE_AFTER_MS = 5 * 60_000; // no realtime: stale after 5 min
export const STALE_AFTER_DISCONNECTED_MS = 60_000; // realtime was expected but is down: 1 min
export const POLL_MS = 30_000; // fallback polling while realtime is down
export const FOCUS_REFRESH_MS = 30_000; // refetch on tab focus when older than this

export interface FreshnessInput {
  lastUpdatedAt: number | null;
  now: number;
  realtime: RealtimeState;
  online: boolean;
  visible: boolean;
}

export type FreshnessDecision = {
  /** Show the stale badge. */
  stale: boolean;
  /** Why it is stale (drives the tooltip copy). */
  reason: 'offline' | 'disconnected' | 'old' | null;
  /** What the auto-refresh policy wants to do right now. */
  action: 'none' | 'refresh';
  /** Next time (ms from now) the policy should be re-evaluated; null = only on events. */
  recheckInMs: number | null;
};

export function evaluateFreshness(i: FreshnessInput): FreshnessDecision {
  const age = i.lastUpdatedAt == null ? Number.POSITIVE_INFINITY : Math.max(0, i.now - i.lastUpdatedAt);
  const down = i.realtime === 'reconnecting';
  const limit = down ? STALE_AFTER_DISCONNECTED_MS : i.realtime === 'live' ? Number.POSITIVE_INFINITY : STALE_AFTER_MS;

  const stale = !i.online || age > limit;
  const reason = !i.online ? 'offline' : age > limit ? (down ? 'disconnected' : 'old') : null;

  let action: FreshnessDecision['action'] = 'none';
  if (i.online && i.visible) {
    if (i.lastUpdatedAt == null) action = 'refresh';
    else if (down && age >= POLL_MS) action = 'refresh'; // polling fallback
    else if (i.realtime !== 'live' && age >= STALE_AFTER_MS) action = 'refresh';
  }

  let recheckInMs: number | null = null;
  if (i.visible && i.online) {
    if (down) recheckInMs = Math.max(1000, POLL_MS - (Number.isFinite(age) ? age % POLL_MS : 0));
    else if (i.realtime !== 'live') recheckInMs = Math.max(1000, STALE_AFTER_MS - (Number.isFinite(age) ? age : 0));
  }
  return { stale, reason, action, recheckInMs };
}

/** Whether coming back to the tab should refetch. */
export const shouldRefreshOnFocus = (lastUpdatedAt: number | null, now: number, realtime: RealtimeState): boolean =>
  realtime !== 'live' && (lastUpdatedAt == null || now - lastUpdatedAt >= FOCUS_REFRESH_MS);

export interface RelativeAge {
  value: number;
  unit: 'second' | 'minute' | 'hour' | 'day';
}

/** Negative `value` (as Intl.RelativeTimeFormat expects). Under 10 s collapses to "just now" via `justNow`. */
export function relativeAge(lastUpdatedAt: number, now: number): RelativeAge & { justNow: boolean } {
  const s = Math.max(0, Math.round((now - lastUpdatedAt) / 1000));
  if (s < 10) return { value: 0, unit: 'second', justNow: true };
  if (s < 60) return { value: -s, unit: 'second', justNow: false };
  const m = Math.floor(s / 60);
  if (m < 60) return { value: -m, unit: 'minute', justNow: false };
  const h = Math.floor(m / 60);
  if (h < 24) return { value: -h, unit: 'hour', justNow: false };
  return { value: -Math.floor(h / 24), unit: 'day', justNow: false };
}
