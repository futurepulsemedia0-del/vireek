// supabase/functions/_shared/http/publicGuardDeno.ts
// Deno wrapper around guardPublicRequest(): builds the service-role client the edge_rate_limit_hit() RPC needs.
// Usage:  const blocked = await guardPublic(req, { endpoint: "video-ice", limit: 30, windowSeconds: 60, failClosed: true });
//         if (blocked) return blocked;

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { guardPublicRequest, type PublicGuardOptions } from "./publicGuard.ts";

export function guardPublic(req: Request, o: PublicGuardOptions): Promise<Response | null> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) {
    // Cannot even reach the limiter: honour the endpoint's policy.
    return Promise.resolve(
      o.failClosed
        ? new Response(JSON.stringify({ error: "unavailable", message: "Service temporarily unavailable." }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "30", ...(o.headers ?? {}) },
          })
        : null,
    );
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return guardPublicRequest(req, { rpc: (fn, args) => db.rpc(fn, args) }, o);
}
