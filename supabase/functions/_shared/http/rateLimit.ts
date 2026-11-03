// _shared/http/rateLimit.ts — rate limiting behind an interface; DB-backed implementation uses edge_rate_limit_hit().
import { HttpError } from "./core.ts";

export interface RateLimiter {
  hit(bucket: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; retryAfter: number }>;
}

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function dbRateLimiter(db: RpcClient): RateLimiter {
  return {
    async hit(bucket, limit, windowSeconds) {
      const { data, error } = await db.rpc("edge_rate_limit_hit", { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
      if (error || !data || typeof data !== "object") throw new Error("rate limiter unavailable");
      const d = data as { allowed: boolean; remaining: number; retry_after: number };
      return { allowed: !!d.allowed, remaining: d.remaining, retryAfter: d.retry_after };
    },
  };
}

export function dbReplayStore(db: RpcClient) {
  return {
    async claim(provider: string, eventId: string): Promise<boolean> {
      const { data, error } = await db.rpc("claim_webhook_event", { p_provider: provider, p_event_id: eventId });
      if (error) throw new Error("replay store unavailable");
      return data === true;
    },
  };
}

export function rateLimitedError(retryAfter: number): HttpError {
  return new HttpError("rate_limited", "Too many requests.", null, { "Retry-After": String(retryAfter) });
}
