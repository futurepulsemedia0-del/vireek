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
import { apiReadEntries, logSensitiveRead } from "../_shared/privacy/readLog.ts";
import {
  API_VERSION,
  API_VERSION_HEADER,
  MODE_HEADER,
  NOT_FOUND_MESSAGE,
  RATE_LIMIT_PER_MINUTE,
  clientIp,
  deprecationHeaders,
  errorBody,
  errorStatus,
  ipAllowed,
  isUuid,
  parseBefore,
  parseLimit,
  resolveRoute,
  selectColumns,
  parseListQuery,
  usesListExtensions,
  sandboxResponse,
  type ErrorCode,
} from "./contract.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Expose-Headers": "X-Request-Id, X-RateLimit-Limit, Retry-After, X-Vireek-Mode, X-Vireek-Api-Version, Deprecation, Sunset",
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Catalog-coded error response: { error, code, doc_url, request_id } with the status the catalog defines. */
function fail(ctx: LogCtx, code: ErrorCode, message: string, extraHeaders: Record<string, string> = {}) {
  return json(errorBody(code, message, ctx.requestId), errorStatus(code), extraHeaders);
}
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface LogCtx {
  requestId: string;
  mode: "live" | "test";
  admin: ReturnType<typeof createClient> | null;
  keyId: string | null;
  userId: string | null;
  rateLimit: number;
  resource: string | null;
}

function fail(ctx: LogCtx, code: ErrorCode, message: string, extraHeaders: Record<string, string> = {}): Response {
  return json(errorBody(code, message, ctx.requestId), errorStatus(code), extraHeaders);
}
async function handle(req: Request, ctx: LogCtx): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET") return fail(ctx, "method_not_allowed", "Method not allowed", { Allow: "GET, OPTIONS" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return fail(ctx, "server_not_configured", "Server not configured");
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  ctx.admin = admin;
  // ---- Authenticate the API key -----------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!rawKey) {
    return fail(ctx, "missing_api_key", "Missing Authorization header. Use: Authorization: Bearer vrk_live_...");
  }

  const keyHash = await sha256Hex(rawKey);
  const { data: keyRow } = await admin
    .from("api_keys")
    .select("id, user_id, scopes, revoked_at, mode, ip_allowlist, rate_limit_per_minute")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (!keyRow || keyRow.revoked_at) {
    return fail(ctx, "invalid_api_key", "Invalid or revoked API key");
  }

  ctx.keyId = keyRow.id;
  ctx.userId = keyRow.user_id;
  ctx.rateLimit =
    Number.isInteger(keyRow.rate_limit_per_minute) && (keyRow.rate_limit_per_minute as number) > 0
      ? (keyRow.rate_limit_per_minute as number)
      : RATE_LIMIT_PER_MINUTE;
  ctx.mode = keyRow.mode === "test" ? "test" : "live";

  // ---- IP allowlist (empty = any address; unknown address with a list = denied) ----
  const callerIp = clientIp(req.headers);
  if (!ipAllowed(callerIp, (keyRow.ip_allowlist ?? []) as string[])) {
    return fail(
      ctx,
      "ip_not_allowed",
      `Requests from ${callerIp ?? "an unknown address"} are not allowed for this key. Update its IP allowlist in Settings → API Keys.`,
    );
  }
  // Per-key limiter (fixed 60 s window, counted from api_request_logs).
  // Fail-open: a limiter error must never take the API down.
  const { data: withinLimit } = await admin.rpc("api_v1_rate_limit_ok", {
    p_key_id: keyRow.id,
   p_limit: ctx.rateLimit,
  });
  if (withinLimit === false) {
    return fail(
      ctx,
      "rate_limited",
      `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE} requests/minute per key). Retry shortly.`,
      { "Retry-After": "60" },
    );
  }
  // Fire-and-forget last_used_at update — doesn't block the response.
  admin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString(), ...(callerIp ? { last_used_ip: callerIp } : {}) })
    .eq("id", keyRow.id)
    .then(() => {});

  // ---- Route (single source of truth: ./contract.ts) ---------------------
  const url = new URL(req.url);
  const route = resolveRoute(url.pathname);
  ctx.resource = route.kind === "ok" ? route.resource : null;
  if (route.kind !== "ok") return fail(ctx, "route_not_found", NOT_FOUND_MESSAGE);
  if (!(keyRow.scopes as string[]).includes(route.scope)) {
    return fail(ctx, "insufficient_scope", `This key is missing the required scope: ${route.scope}`);
  }

  // ---- Test keys: synthetic data only, never the real tables ------------------
  if (ctx.mode === "test") {
    if (route.id !== null && !isUuid(route.id)) return fail(ctx, "invalid_id", "Invalid id: expected a UUID");
    const testBefore = parseBefore(url.searchParams.get("before"));
    if (!testBefore.ok) return fail(ctx, "invalid_before", "Invalid before: expected an ISO 8601 timestamp");
    const body = sandboxResponse(route.resource, route.id, parseLimit(url.searchParams.get("limit")), testBefore.value);
    if (body === null) return fail(ctx, "record_not_found", `${route.resource} not found`);
    return json(body);
  }

  const columns = selectColumns(route.resource);
  if (!columns) return fail(ctx, "internal_error", "Internal error");
  let query = admin.from(route.table).select(columns).eq("user_id", keyRow.user_id);

  if (route.id !== null) {
    if (!isUuid(route.id)) return fail(ctx, "invalid_id", "Invalid id: expected a UUID");
    const { data, error } = await query.eq("id", route.id).maybeSingle();
    if (error) return fail(ctx, "query_failed", "Query failed");
    if (!data) return fail(ctx, "record_not_found", `${route.resource} not found`);
    try {
      for (const entry of apiReadEntries({ accountId: keyRow.user_id as string, apiKeyId: keyRow.id as string, table: route.table, recordId: route.id, returned: 1 })) await logSensitiveRead(admin, entry);
    } catch {
      return fail(ctx, "query_failed", "Query failed"); // fail closed: no log, no data
    }
    return json({ data });
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const before = parseBefore(url.searchParams.get("before"));
  if (!before.ok) return fail(ctx, "invalid_before", "Invalid before: expected an ISO 8601 timestamp");
  // Filters + sparse fieldsets: only for accounts with the public_api_v2 entitlement (fails closed -> ignored).
  if (usesListExtensions(route.resource, url.searchParams)) {
    const { data: v2 } = await admin.rpc("public_api_v2_enabled", { p_owner: keyRow.user_id });
    if (v2 === true) {
      const parsed = parseListQuery(route.resource, url.searchParams);
      if (!parsed.ok) return fail(ctx, "invalid_filter", parsed.message);
      for (const f of parsed.filters) query = query.eq(f.column, f.value);
      query = query.select(parsed.columns);
    }
  }
  query = query.order("created_at", { ascending: false }).limit(limit);
  if (before.value) query = query.lt("created_at", before.value);

  const { data, error } = await query;
  if (error) return fail(ctx, "query_failed", "Query failed");
  try {
    for (const entry of apiReadEntries({ accountId: keyRow.user_id as string, apiKeyId: keyRow.id as string, table: route.table, recordId: null, returned: data.length })) await logSensitiveRead(admin, entry);
  } catch {
    return fail(ctx, "query_failed", "Query failed"); // fail closed: no log, no data
  }
  return json({ data, has_more: data.length === limit, next_before: data.length ? data[data.length - 1].created_at : null });
}

// Logs every authenticated request per API key (api_request_logs).
// The raw key is never logged; unauthenticated requests have no key to attribute.
Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  const ctx: LogCtx = { requestId: crypto.randomUUID(), mode: "live", admin: null, keyId: null, userId: null, rateLimit: RATE_LIMIT_PER_MINUTE, resource: null };

  let res: Response;
  try {
    res = await handle(req, ctx);
  } catch (_err) {
    res = fail(ctx, "internal_error", "Internal error");
  }
  res.headers.set("X-Request-Id", ctx.requestId);
  res.headers.set(API_VERSION_HEADER, API_VERSION);
  if (ctx.keyId) {
    res.headers.set("X-RateLimit-Limit", String(ctx.rateLimit));
    res.headers.set(MODE_HEADER, ctx.mode);
    for (const [name, value] of Object.entries(deprecationHeaders(ctx.resource))) res.headers.set(name, value);
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
