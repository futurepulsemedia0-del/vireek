// supabase/functions/_shared/data-products/guard.ts
//
// Runtime half of the data-product approval control (docs/data/monetization-ethics.md).
// An external data endpoint calls assertDataProductApproved() once per request, AFTER it has authenticated the caller
// and BEFORE it reads or returns any product data:
//
//   const blocked = await assertDataProductApproved(admin, "vireek_insights", "insights-api", corsHeaders);
//   if (blocked) return blocked;
//
// The decision comes from the database function public.data_product_gate(product_key, endpoint), which is true only for
// an `approved`, unexpired, un-revoked data_product_reviews row that lists the endpoint. Everything else is a denial.
//
// Modes (env DATA_PRODUCT_GATE_MODE):
//   unset | "" | "shadow"   log the decision, never block (same pattern as FABRIC_SIG_MODE). The default, so deploying
//                           this code cannot take a live endpoint down before reviews exist.
//   anything else           ENFORCE. A typo ("enfroce") therefore fails closed, not open.
// In enforce mode a denial returns 403 and a gate outage (RPC error) returns 503; both are no-store and generic.
//
// Only positive decisions are cached (60 s), so a revocation reaches every instance within a minute and a denial is
// never "stuck". CDN caches in front of public endpoints are outside this module (see the doc).

export type GateMode = "shadow" | "enforce";

export interface GateDecision {
  allowed: boolean;
  reason: string;
  reviewId: string | null;
  /** True when the decision actually blocks the request (enforce mode and not allowed). */
  blocking: boolean;
  mode: GateMode;
}

/** The only client method the guard needs; a supabase-js client satisfies it. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export const POSITIVE_CACHE_MS = 60_000;
const PRODUCT_KEY_RE = /^[a-z0-9_]{2,48}$/;
const cache = new Map<string, { until: number; reviewId: string | null }>();

export function gateMode(raw: string | null | undefined): GateMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "" || v === "shadow" ? "shadow" : "enforce";
}

export function resetGateCache(): void {
  cache.clear();
}

function readEnv(): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("DATA_PRODUCT_GATE_MODE");
  } catch {
    return undefined; // no permission to read env: treat as unset (shadow)
  }
}

export async function checkDataProduct(
  client: RpcClient,
  productKey: string,
  endpoint: string,
  opts: { mode?: string | null; now?: () => number } = {},
): Promise<GateDecision> {
  const mode = gateMode(opts.mode !== undefined ? opts.mode : readEnv());
  const now = opts.now ?? Date.now;
  const make = (allowed: boolean, reason: string, reviewId: string | null): GateDecision => ({
    allowed, reason, reviewId, mode, blocking: mode === "enforce" && !allowed,
  });

  if (!PRODUCT_KEY_RE.test(productKey) || !endpoint.trim()) return make(false, "invalid_arguments", null);

  const ck = `${productKey}|${endpoint}`;
  const hit = cache.get(ck);
  if (hit && hit.until > now()) return make(true, "approved", hit.reviewId);

  try {
    const { data, error } = await client.rpc("data_product_gate", { p_product_key: productKey, p_endpoint: endpoint });
    if (error || !data || typeof data !== "object") return make(false, "gate_unavailable", null);
    const d = data as { allowed?: unknown; reason?: unknown; review_id?: unknown };
    if (d.allowed === true) {
      const reviewId = typeof d.review_id === "string" ? d.review_id : null;
      cache.set(ck, { until: now() + POSITIVE_CACHE_MS, reviewId });
      return make(true, "approved", reviewId);
    }
    cache.delete(ck);
    return make(false, typeof d.reason === "string" ? d.reason : "denied", null);
  } catch {
    return make(false, "gate_unavailable", null);
  }
}

/** Returns a Response to send when the request must be blocked, or null to continue. */
export async function assertDataProductApproved(
  client: RpcClient,
  productKey: string,
  endpoint: string,
  headers: Record<string, string> = {},
  opts: { mode?: string | null; now?: () => number } = {},
): Promise<Response | null> {
  const d = await checkDataProduct(client, productKey, endpoint, opts);
  if (d.allowed) return null;
  console.warn(`[data-product-gate] ${d.blocking ? "BLOCKED" : "shadow-denied"} product=${productKey} endpoint=${endpoint} reason=${d.reason}`);
  if (!d.blocking) return null;
  const outage = d.reason === "gate_unavailable";
  return new Response(
    JSON.stringify({ error: outage ? "Temporarily unavailable." : "This data product is not currently approved for release." }),
    { status: outage ? 503 : 403, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store", ...(outage ? { "Retry-After": "30" } : {}) } },
  );
}
