// supabase/functions/_shared/http/publicGuard.ts
//
// Per-client rate limit for PUBLIC (verify_jwt = false) endpoints, built on the existing edge_rate_limit_hit() RPC
// (migration 20280402000000) through dbRateLimiter. Pure module (no Deno / npm imports) so Vitest runs it.
//
//   failClosed: true  -> limiter unavailable = 503. Use for endpoints that WRITE or cost money.
//   failClosed: false -> limiter unavailable = request allowed. Use for cacheable read-only feeds.
//
// The client IP is only ever stored as a salted SHA-256 prefix, never raw.

import { dbRateLimiter, type RateLimiter, type RpcClient } from "./rateLimit.ts";

export interface PublicGuardOptions {
  /** Short stable name of the endpoint, e.g. "video-ice". Becomes part of the bucket key. */
  endpoint: string;
  limit: number;
  windowSeconds: number;
  failClosed: boolean;
  /** Extra key material, e.g. a slug or session token hash, to add a second per-resource bucket. */
  scope?: string;
  /** Secret salt for the IP hash. Defaults to a fixed pepper (the hash is only a bucket key, not a credential). */
  salt?: string;
  headers?: Record<string, string>;
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Best-effort client IP (Supabase edge sits behind Cloudflare). Falls back to "unknown" => one shared bucket. */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff ? xff.slice(0, 64) : "unknown";
}

export async function rateLimitBucket(req: Request, o: Pick<PublicGuardOptions, "endpoint" | "scope" | "salt">): Promise<string> {
  const ipKey = (await sha256Hex(`${o.salt ?? "vireek-public-guard"}|${clientIp(req)}`)).slice(0, 32);
  const scope = o.scope ? `:${(await sha256Hex(o.scope)).slice(0, 16)}` : "";
  return `pub:${o.endpoint}${scope}:${ipKey}`;
}

function tooMany(retryAfter: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message: "Too many requests. Please try again shortly." }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(Math.max(1, retryAfter)), "Cache-Control": "no-store", ...headers },
  });
}

/**
 * Returns a Response to send (429 / 503) or null to continue.
 * Never throws: a broken limiter must not turn into a 500 stack trace.
 */
export async function guardPublicRequest(req: Request, db: RpcClient | RateLimiter, o: PublicGuardOptions): Promise<Response | null> {
  const limiter: RateLimiter = "hit" in db ? db : dbRateLimiter(db);
  const headers = o.headers ?? {};
  try {
    const r = await limiter.hit(await rateLimitBucket(req, o), o.limit, o.windowSeconds);
    return r.allowed ? null : tooMany(r.retryAfter, headers);
  } catch {
    if (!o.failClosed) return null;
    return new Response(JSON.stringify({ error: "unavailable", message: "Service temporarily unavailable." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30", "Cache-Control": "no-store", ...headers },
    });
  }
}
