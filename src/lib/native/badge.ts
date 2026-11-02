// src/lib/native/badge.ts — app-icon badge = unread job messages. No-op on the web, and a silent
// no-op until the user has granted notification permission (the badge shares that permission).

import { isNative } from './platform';

export function normalizeBadgeCount(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(99_999, Math.floor(v));
}

/** Pass `known` when the caller already fetched the unread count, to skip a second query. */
export async function syncAppBadge(known?: number): Promise<void> {
  if (!isNative()) return;
  try {
    const count = normalizeBadgeCount(known ?? (await (await import('@/lib/jobMessages')).fetchUnreadTotal()));
    const { Badge } = await import('@capawesome/capacitor-badge');
    const { display } = await Badge.checkPermissions();
    if (display !== 'granted') return;
    if (count > 0) await Badge.set({ count });
    else await Badge.clear();
  } catch {
    /* offline, signed out or plugin unsupported — the badge keeps its last value */
  }
}
