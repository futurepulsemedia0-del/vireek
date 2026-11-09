// Server-side module entitlement checks for edge functions (and any API route that can import this file).
// Calls the entitlement_check RPC with the SERVICE-ROLE client. Framework-free, so Vitest runs it.
//
// RULES
// - tenantId must come from the VERIFIED caller (resolve it with get_account_owner_id() on the caller's JWT),
//   never from the request body or query string.
// - DEFAULT DENY: invalid input, RPC error, network failure or a non-boolean answer all return false.
// - A recent `true` survives a short outage (maxStaleMs) so a blip does not take a paid module down, but a
//   revoke is visible within ttlMs (10 s) when the database is reachable.
//
// Usage inside a function (after authenticating the caller and resolving tenantId):
//   const entitlements = createEntitlementChecker({ rpc: (fn, args) => serviceClient.rpc(fn, args) }); // module scope
//   await requireEntitlement(entitlements, tenantId, "pay");          // throws HttpError("forbidden") -> 403
//   if (await entitlements.isEntitled(tenantId, "ai")) { ... }        // soft check
import { HttpError } from "../http/core.ts";

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface EntitlementCheckerOptions {
  rpc: RpcClient["rpc"];
  now?: () => number;
  ttlMs?: number;       // default 10 s
  maxStaleMs?: number;  // default 60 s: last known TRUE is trusted this long when the RPC fails
  maxEntries?: number;  // default 1000
}

export interface EntitlementChecker {
  isEntitled(tenantId: string, moduleId: string): Promise<boolean>;
}

// Mirrors is_valid_module_id() in the migration.
const MODULE_RE = /^(core|pay|ai|supply|finance|passport|intelligence|connect|packs:[a-z0-9][a-z0-9_-]{0,39})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createEntitlementChecker({ rpc, now = Date.now, ttlMs = 10_000, maxStaleMs = 60_000, maxEntries = 1000 }: EntitlementCheckerOptions): EntitlementChecker {
  const cache = new Map<string, { value: boolean; at: number }>();
  const inflight = new Map<string, Promise<boolean | null>>();

  async function fetchValue(tenantId: string, moduleId: string): Promise<boolean | null> {
    try {
      const { data, error } = await rpc("entitlement_check", { p_tenant: tenantId, p_module: moduleId });
      return error || typeof data !== "boolean" ? null : data;
    } catch {
      return null;
    }
  }

  return {
    async isEntitled(tenantId, moduleId) {
      if (!UUID_RE.test(tenantId) || !MODULE_RE.test(moduleId)) return false;
      const key = `${tenantId}|${moduleId}`;
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.at < ttlMs) return hit.value;

      let p = inflight.get(key);
      if (!p) {
        p = fetchValue(tenantId, moduleId).finally(() => { inflight.delete(key); });
        inflight.set(key, p);
      }
      const fresh = await p;
      if (fresh !== null) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
        cache.set(key, { value: fresh, at: now() });
        return fresh;
      }
      // RPC failed: only a recent TRUE is reused; anything else is denied.
      return Boolean(hit && hit.value && t - hit.at < maxStaleMs);
    },
  };
}

/** Throws HttpError("forbidden") (standard 403 JSON via errorResponse) unless the tenant has the module. */
export async function requireEntitlement(checker: EntitlementChecker, tenantId: string, moduleId: string): Promise<void> {
  if (!(await checker.isEntitled(tenantId, moduleId))) {
    throw new HttpError("forbidden", "This module is not available on your account.", { code: "module_not_entitled", module: moduleId });
  }
}
