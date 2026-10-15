/**
 * Pure helpers for the sessions & devices page (no I/O, fully unit-tested).
 */

export interface SessionLike {
  id: string;
  created_at: string;
  updated_at: string;
  refreshed_at: string | null;
  not_after: string | null;
  user_agent: string | null;
  ip: string | null;
}

export interface LoginEventLike {
  id: string;
  device_label: string;
  ip: string | null;
  is_new_device: boolean;
  is_new_ip: boolean;
  alerted: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a calendar date. Future/invalid input is safe. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const diff = now - t;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Expires in 12 days" / "Expires today" / "Expired". */
export function formatExpiry(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'No expiry';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Unknown expiry';
  const diff = t - now;
  if (diff <= 0) return 'Expired';
  const days = Math.floor(diff / DAY);
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

export function lastActiveIso(s: SessionLike): string {
  return s.refreshed_at ?? s.updated_at;
}

/** Current session first, then most recently active. Does not mutate the input. */
export function sortSessions<T extends SessionLike>(sessions: T[], currentId: string | null): T[] {
  return [...sessions].sort((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return new Date(lastActiveIso(b)).getTime() - new Date(lastActiveIso(a)).getTime();
  });
}

/** Sessions other than the one in use right now. */
export function otherSessions<T extends SessionLike>(sessions: T[], currentId: string | null): T[] {
  return sessions.filter((s) => s.id !== currentId);
}

/** Alerts the user has not yet confirmed, newest first. */
export function pendingAlerts<T extends LoginEventLike>(events: T[]): T[] {
  return events
    .filter((e) => e.alerted && !e.acknowledged_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Short flags shown beside a history row. */
export function eventFlags(e: Pick<LoginEventLike, 'is_new_device' | 'is_new_ip'>): string[] {
  const flags: string[] = [];
  if (e.is_new_device) flags.push('New device');
  if (e.is_new_ip) flags.push('New network');
  return flags;
}
