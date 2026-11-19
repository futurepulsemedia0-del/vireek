import { describe, expect, it } from "vitest";
import { clientIp, guardPublicRequest, rateLimitBucket } from "./publicGuard.ts";
import type { RateLimiter } from "./rateLimit.ts";

const req = (ip: string, h: Record<string, string> = {}) => new Request("https://x.test/", { headers: { "x-forwarded-for": ip, ...h } });

/** In-memory fixed-window limiter with the same contract as edge_rate_limit_hit(). */
function memLimiter(): RateLimiter & { buckets: Map<string, number> } {
  const buckets = new Map<string, number>();
  return {
    buckets,
    async hit(bucket, limit) {
      const n = (buckets.get(bucket) ?? 0) + 1;
      buckets.set(bucket, n);
      return { allowed: n <= limit, remaining: Math.max(limit - n, 0), retryAfter: 42 };
    },
  };
}
const broken: RateLimiter = { async hit() { throw new Error("db down"); } };
const base = { endpoint: "video-ice", limit: 3, windowSeconds: 60 };

describe("guardPublicRequest", () => {
  it("allows up to the limit, then answers 429 with Retry-After", async () => {
    const l = memLimiter();
    for (let i = 0; i < 3; i++) expect(await guardPublicRequest(req("1.2.3.4"), l, { ...base, failClosed: true })).toBeNull();
    const blocked = await guardPublicRequest(req("1.2.3.4"), l, { ...base, failClosed: true });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe("42");
  });
  it("buckets per client IP and per scope", async () => {
    const l = memLimiter();
    for (let i = 0; i < 3; i++) await guardPublicRequest(req("1.1.1.1"), l, { ...base, failClosed: true });
    expect(await guardPublicRequest(req("2.2.2.2"), l, { ...base, failClosed: true })).toBeNull();
    expect(await guardPublicRequest(req("1.1.1.1"), l, { ...base, scope: "other", failClosed: true })).toBeNull();
  });
  it("fails closed with 503 when the limiter is down and failClosed is true", async () => {
    const r = await guardPublicRequest(req("1.2.3.4"), broken, { ...base, failClosed: true });
    expect(r?.status).toBe(503);
  });
  it("fails open for cacheable read-only feeds", async () => {
    expect(await guardPublicRequest(req("1.2.3.4"), broken, { ...base, failClosed: false })).toBeNull();
  });
  it("never stores the raw IP in the bucket key", async () => {
    const b = await rateLimitBucket(req("203.0.113.9"), { endpoint: "x" });
    expect(b).not.toContain("203.0.113.9");
    expect(b.startsWith("pub:x:")).toBe(true);
  });
  it("prefers cf-connecting-ip over x-forwarded-for", () => {
    expect(clientIp(req("9.9.9.9", { "cf-connecting-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(new Request("https://x.test/"))).toBe("unknown");
  });
});
