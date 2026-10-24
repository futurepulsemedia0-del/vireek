// supabase/functions/insights-api/index.ts
//
// Vireek Insights subscriber API: privacy-safe, k-anonymous industry indexes.
// Authenticated with a subscriber key (insights_api_keys), NOT a Supabase JWT.
// Only the SHA-256 of a key is stored; the raw key is shown once at issue time.
//
// Routes (all GET):
//   /insights-api/v1/publications
//   /insights-api/v1/indexes?period=2027-Q4&trade=hvac&region=tx&metric=close_rate_pct&limit=200&offset=0&format=json|csv
//   /insights-api/v1/methodology
//
// Deploy:  supabase functions deploy insights-api --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const METRICS = ["avg_ticket_cents", "close_rate_pct", "response_hours", "leads_per_business", "demand_index"];
const PERIOD_RE = /^[0-9]{4}-Q[1-4]$/;
const TRADE_RE = /^(all|[a-z]+(-[a-z]+)*)$/;
const REGION_RE = /^(all|[a-z]{2})$/;

const METHODOLOGY = {
  version: 1,
  description:
    "Quarterly percentile indexes computed from businesses that explicitly opted in. Each business contributes one value per metric; cohorts are percentiles of those values.",
  privacy: {
    minimum_businesses_per_cell: 10,
    minimum_distinct_values_per_cell: 3,
    published_statistics: ["p25", "p50", "p75"],
    contributor_count: "banded (10-19, 20-49, 50-99, 100+); exact counts are never published",
    noise:
      "One stable, deterministic Laplace shift per cell (IQR / n scale). Differential-privacy-inspired; not a formally proven epsilon-DP guarantee.",
    releases: "Published quarters are immutable; a release can only be retracted.",
  },
  metrics: {
    avg_ticket_cents: "Average paid job value per business (USD cents); higher is better.",
    close_rate_pct: "Accepted quotes / quotes sent, percent; higher is better.",
    response_hours: "Average hours from lead creation to quote sent; lower is better.",
    leads_per_business: "Leads created per business in the quarter.",
    demand_index: "Leads this quarter / leads prior quarter x 100 per business.",
  },
  regions: "Lowercase US state code, or 'all' for national.",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, max-age=300", ...extra },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Neutralise spreadsheet formula injection; values here are server-controlled but stay defensive.
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface Ctx {
  admin: ReturnType<typeof createClient> | null;
  keyId: string | null;
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  ctx.admin = admin;

  const authHeader = req.headers.get("Authorization") || "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!rawKey) return json({ error: "Missing Authorization header. Use: Authorization: Bearer vrk_ins_..." }, 401);

  const { data: keyRow } = await admin
    .from("insights_api_keys")
    .select("id, scopes, rate_limit_per_minute, revoked_at, expires_at, subscriber:insights_subscribers(status)")
    .eq("key_hash", await sha256Hex(rawKey))
    .maybeSingle();

  const subscriber = (keyRow as { subscriber?: { status?: string } | null } | null)?.subscriber;
  const expired = keyRow?.expires_at ? new Date(keyRow.expires_at as string).getTime() < Date.now() : false;
  if (!keyRow || keyRow.revoked_at || expired || subscriber?.status !== "active") {
    return json({ error: "Invalid, expired or revoked API key" }, 401);
  }
  ctx.keyId = keyRow.id as string;
  if (!(keyRow.scopes as string[]).includes("insights:read")) {
    return json({ error: "This key is missing the required scope: insights:read" }, 403);
  }

  const limit = keyRow.rate_limit_per_minute as number;
  const { data: within } = await admin.rpc("insights_api_rate_ok", { p_key_id: keyRow.id, p_limit: limit });
  if (within === false) {
    return json({ error: `Rate limit exceeded (${limit} requests/minute for this key).` }, 429, {
      "Retry-After": "60",
      "X-RateLimit-Limit": String(limit),
    });
  }
  admin.from("insights_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id).then(() => {});

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/insights-api\/?/, "").replace(/^v1\/?/, "").split("/").filter(Boolean)[0] ?? "";
  const rl = { "X-RateLimit-Limit": String(limit) };

  if (route === "methodology") return json({ data: METHODOLOGY }, 200, rl);

  if (route === "publications") {
    const { data, error } = await admin.rpc("insights_public_periods");
    if (error) return json({ error: "Query failed" }, 500);
    return json({ data }, 200, rl);
  }

  if (route === "indexes") {
    const q = url.searchParams;
    const period = q.get("period");
    const trade = q.get("trade");
    const region = q.get("region");
    const metric = q.get("metric");
    if (period && !PERIOD_RE.test(period)) return json({ error: "period must look like 2027-Q4" }, 400);
    if (trade && !TRADE_RE.test(trade)) return json({ error: "invalid trade" }, 400);
    if (region && !REGION_RE.test(region)) return json({ error: "region must be a lowercase US state code or 'all'" }, 400);
    if (metric && !METRICS.includes(metric)) return json({ error: `metric must be one of: ${METRICS.join(", ")}` }, 400);
    const pageLimit = Math.min(Math.max(Number(q.get("limit")) || 200, 1), 500);
    const offset = Math.max(Number(q.get("offset")) || 0, 0);

    const { data, error } = await admin.rpc("insights_api_indexes", {
      p_period: period,
      p_trade: trade,
      p_region: region,
      p_metric: metric,
      p_limit: pageLimit,
      p_offset: offset,
    });
    if (error) return json({ error: "Query failed" }, 500);
    const rows = (data ?? []) as Record<string, unknown>[];

    if (q.get("format") === "csv") {
      const cols = ["period_label", "trade", "region_key", "metric", "unit", "direction", "contributor_band", "p25", "p50", "p75", "qoq_change_pct"];
      const body = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
      return new Response(body, {
        status: 200,
        headers: { ...corsHeaders, ...rl, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="vireek-insights.csv"' },
      });
    }
    return json({ data: rows, has_more: rows.length === pageLimit, next_offset: offset + rows.length }, 200, rl);
  }

  return json({ error: "Not found. Available: /v1/publications, /v1/indexes, /v1/methodology" }, 404);
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const ctx: Ctx = { admin: null, keyId: null };
  let res: Response;
  try {
    res = await handle(req, ctx);
  } catch (_err) {
    res = json({ error: "Internal error" }, 500);
  }
  if (ctx.admin && ctx.keyId) {
    const write = Promise.resolve(
      ctx.admin.from("insights_api_request_log").insert({
        key_id: ctx.keyId,
        status: res.status,
        path: new URL(req.url).pathname.slice(0, 200),
        latency_ms: Math.max(0, Date.now() - started),
      }),
    ).catch(() => {});
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(write);
  }
  return res;
});
