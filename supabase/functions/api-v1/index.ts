// supabase/functions/api-v1/index.ts
//
// The real, public Vireek API — documented in /docs. Authenticated with a
// customer-issued API key (see api_keys table + src/pages/ApiKeysPage.tsx),
// NOT a Supabase auth JWT. The key is verified by hashing the presented
// value with the same SHA-256 the frontend used at creation time and
// looking up the hash — the raw key is never stored anywhere.
//
// Routes, scopes, limits and validation live in ./contract.ts (single source of
// truth for this function, the OpenAPI spec and the CI drift check).
// Published spec: /openapi.json — regenerate with `npm run openapi:generate`.
//
// Deploy:
//   supabase functions deploy api-v1 --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { NOT_FOUND_MESSAGE, RATE_LIMIT_PER_MINUTE, isUuid, parseBefore, parseLimit, resolveRoute } from "./contract.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface LogCtx {
  admin: ReturnType<typeof createClient> | null;
  keyId: string | null;
  userId: string | null;
  resource: string | null;
}

async function handle(req: Request, ctx: LogCtx): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  ctx.admin = admin;
  // ---- Authenticate the API key -----------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!rawKey) {
    return json({ error: "Missing Authorization header. Use: Authorization: Bearer vrk_live_..." }, 401);
  }

  const keyHash = await sha256Hex(rawKey);
  const { data: keyRow } = await admin
    .from("api_keys")
    .select("id, user_id, scopes, revoked_at")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (!keyRow || keyRow.revoked_at) {
    return json({ error: "Invalid or revoked API key" }, 401);
  }

  ctx.keyId = keyRow.id;
  ctx.userId = keyRow.user_id;
  // Per-key limiter (fixed 60 s window, counted from api_request_logs).
  // Fail-open: a limiter error must never take the API down.
  const { data: withinLimit } = await admin.rpc("api_v1_rate_limit_ok", {
    p_key_id: keyRow.id,
    p_limit: RATE_LIMIT_PER_MINUTE,
  });
  if (withinLimit === false) {
    return json(
      { error: `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE} requests/minute per key). Retry shortly.` },
      429,
      { "Retry-After": "60" },
    );
  }
  // Fire-and-forget last_used_at update — doesn't block the response.
  admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id).then(() => {});

  // ---- Route (single source of truth: ./contract.ts) ---------------------
  const url = new URL(req.url);
  const route = resolveRoute(url.pathname);
  ctx.resource = route.kind === "ok" ? route.resource : null;
  if (route.kind !== "ok") return json({ error: NOT_FOUND_MESSAGE }, 404);
  if (!(keyRow.scopes as string[]).includes(route.scope)) {
    return json({ error: `This key is missing the required scope: ${route.scope}` }, 403);
  }

  let query = admin.from(route.table).select("*").eq("user_id", keyRow.user_id);

  if (route.id !== null) {
    if (!isUuid(route.id)) return json({ error: "Invalid id: expected a UUID" }, 400);
    const { data, error } = await query.eq("id", route.id).maybeSingle();
    if (error) return json({ error: "Query failed" }, 500);
    if (!data) return json({ error: `${route.resource} not found` }, 404);
    return json({ data });
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const before = parseBefore(url.searchParams.get("before"));
  if (!before.ok) return json({ error: "Invalid before: expected an ISO 8601 timestamp" }, 400);
  query = query.order("created_at", { ascending: false }).limit(limit);
  if (before.value) query = query.lt("created_at", before.value);

  const { data, error } = await query;
  if (error) return json({ error: "Query failed" }, 500);
  return json({ data, has_more: data.length === limit, next_before: data.length ? data[data.length - 1].created_at : null });
}

// Logs every authenticated request per API key (api_request_logs).
// The raw key is never logged; unauthenticated requests have no key to attribute.
Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  const ctx: LogCtx = { admin: null, keyId: null, userId: null, resource: null };

  let res: Response;
  try {
    res = await handle(req, ctx);
  } catch (_err) {
    res = json({ error: "Internal error" }, 500);
  }

  const latencyMs = Math.max(0, Date.now() - startedAt);
  if (ctx.admin && ctx.keyId && ctx.userId) {
    let errorMessage: string | null = null;
    if (res.status >= 400) {
      try {
        const body = await res.clone().json();
        errorMessage = typeof body?.error === "string" ? body.error.slice(0, 300) : null;
      } catch (_e) {
        errorMessage = null;
      }
    }
    const pathname = new URL(req.url).pathname.replace(/^\/api-v1/, "") || "/";
    const write = Promise.resolve(
      ctx.admin.from("api_request_logs").insert({
        api_key_id: ctx.keyId,
        user_id: ctx.userId,
        method: req.method.slice(0, 10),
        path: pathname.slice(0, 300),
        resource: ctx.resource,
        status: res.status,
        latency_ms: latencyMs,
        error: errorMessage,
        user_agent: (req.headers.get("user-agent") || "").slice(0, 200) || null,
      }),
    ).catch(() => {});
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(write);
  }

  return res;
});
