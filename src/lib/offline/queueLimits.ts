// src/lib/offline/queueLimits.ts
// Storage guard for the outbox: refuse to queue a file that would push the device past its
// storage quota, instead of letting IndexedDB fail halfway. Unknown quota => allow (never block
// field work on a missing API).

/** Keep 10 % of the quota free. Judgment call, not a measured number. */
export const MAX_QUOTA_FRACTION = 0.9;

export class QueueFullError extends Error {
  constructor() {
    super('This device is almost out of storage. Free up space or sync before adding more photos.');
    this.name = 'QueueFullError';
  }
}

export function wouldExceedQuota(
  incomingBytes: number,
  estimate: { usage?: number; quota?: number } | null | undefined,
): boolean {
  if (!estimate || !estimate.quota || estimate.quota <= 0) return false;
  return (estimate.usage ?? 0) + Math.max(0, incomingBytes) > estimate.quota * MAX_QUOTA_FRACTION;
}

export async function assertRoomFor(bytes: number): Promise<void> {
  let estimate: { usage?: number; quota?: number } | undefined;
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch {
    return;
  }
  if (wouldExceedQuota(bytes, estimate)) throw new QueueFullError();
}
