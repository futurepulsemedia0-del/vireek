/** Single source for idempotency keys (replaces the copies in pay.ts and refunds.ts). */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
