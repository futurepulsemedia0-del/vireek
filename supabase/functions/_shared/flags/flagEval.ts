// Server-side flag evaluation for edge functions (calls the flag_evaluate RPC with the service-role client).
// Safe by default: a flag that cannot be evaluated is OFF (the stable path), unless a recent value is cached.

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface FlagEvaluatorOptions {
  rpc: RpcClient['rpc'];
  now?: () => number;
  ttlMs?: number;       // default 10 s
  maxStaleMs?: number;  // default 5 min: last known value is trusted this long when the RPC fails
  maxEntries?: number;  // default 500
}

export interface FlagContext {
  userId?: string | null;
}

export interface FlagEvaluator {
  isOn(key: string, tenantId: string, fallback?: boolean, ctx?: FlagContext): Promise<boolean>;
}

export function createFlagEvaluator({ rpc, now = Date.now, ttlMs = 10_000, maxStaleMs = 5 * 60_000, maxEntries = 500 }: FlagEvaluatorOptions): FlagEvaluator {
  const cache = new Map<string, { value: boolean; at: number }>();
  const inflight = new Map<string, Promise<boolean | null>>();

    async function fetchValue(key: string, tenantId: string, userId: string | null): Promise<boolean | null> {
    try {
      const { data, error } = userId
        ? await rpc('flag_evaluate_for_user', { p_key: key, p_tenant: tenantId, p_user: userId })
        : await rpc('flag_evaluate', { p_key: key, p_tenant: tenantId });
    }
  }

  return {
    async isOn(key, tenantId, fallback = false, ctx) {
      const userId = typeof ctx?.userId === 'string' && ctx.userId !== '' ? ctx.userId : null;
      const id = `${key}:${tenantId}:${userId ?? ''}`;
      const id = `${key}:${tenantId}`;
      const hit = cache.get(id);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      let p = inflight.get(id);
      if (!p) {
        p = fetchValue(key, tenantId).finally(() => inflight.delete(id));
        inflight.set(id, p);
      }
      const value = await p;
      if (value !== null) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
        cache.set(id, { value, at: now() });
        return value;
      }
      return hit && now() - hit.at <= maxStaleMs ? hit.value : fallback;
    },
  };
}
