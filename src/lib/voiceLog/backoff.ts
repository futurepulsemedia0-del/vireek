/** Exponential backoff: 15s, 30s, 60s ... capped at 10 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}
