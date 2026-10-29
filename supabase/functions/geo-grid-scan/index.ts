// geo-grid-scan — local rank tracking (geo-grid) for /dashboard/geo-grid.
//
//   POST { action: "status" }                                  → { configured, monthly_limit, used_points }
//   POST { action: "search_places", query, lat?, lng? }        → { places: [{ place_id, name, address, latitude, longitude }] }
//   POST { action: "scan", keyword_id }                        → { scan }   (one full grid, ~5–20 s)
//   POST { action: "run_due" }  + X-Cron-Secret                → { processed, ... }   (scheduled keywords)
//
// Auth: app  -> Authorization: Bearer <user JWT>; owner or can_edit_business_profile, that account only.
//       cron -> header X-Cron-Secret (CRON_SECRET must be set), only action "run_due".
// Provider: Google Places API (New) Text Search, with a location bias centred on every grid point.
// Secrets: GOOGLE_PLACES_API_KEY (falls back to GOOGLE_MAPS_API_KEY; "Places API (New)" must be enabled),
//          CRON_SECRET, GEO_GRID_MONTHLY_POINT_LIMIT (default 5000 points per account per month; 0 = no cap).
// Deploy: supabase functions deploy geo-grid-scan --no-verify-jwt
//         (the function verifies the JWT itself so the cron caller can use X-Cron-Secret instead)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  MAX_RANK,
  biasRadiusMeters,
  findRank,
  generateGridPoints,
  gridStepMeters,
  validateCenter,
  type Competitor,
  type PointOutcome,
} from "../_shared/geo-grid/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function fail(status: number, error: string, message: string) {
  return json({ error, message }, status);
}

type Admin = ReturnType<typeof createClient>;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCURRENCY = 5;
const CALL_TIMEOUT_MS = 10_000;
const INSERT_CHUNK = 100;
const CRON_BATCH = 4;
const CRON_BUDGET_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function monthlyLimit(): number {
  const raw = Number(Deno.env.get("GEO_GRID_MONTHLY_POINT_LIMIT") ?? "5000");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5000;
}

function placesKey(): string | null {
  return Deno.env.get("GOOGLE_PLACES_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY") || null;
}

class ProviderAuthError extends Error {}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

/** One Text Search call with retries on 429 / 5xx. A 401/403 means the key or API setup is wrong: never retried. */
async function textSearch(key: string, body: Row, fieldMask: string): Promise<RawPlace[]> {
  let lastError: Error = new Error("places_unavailable");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(PLACES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new ProviderAuthError("Google rejected the Places API key. Check that the key is valid and Places API (New) is enabled.");
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        lastError = new Error(`places_${res.status}`);
      } else if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`places_${res.status}`);
      } else {
        const data = await res.json();
        return Array.isArray(data?.places) ? (data.places as RawPlace[]) : [];
      }
    } catch (e) {
      if (e instanceof ProviderAuthError) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (lastError.message.startsWith("places_4")) throw lastError;
    }
    await sleep(400 * (attempt + 1) * (attempt + 1));
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface ScanContext {
  scan_id: string;
  keyword: string;
  grid_size: number;
  radius_m: number;
  center_lat: number;
  center_lng: number;
  place_id: string;
  point_count: number;
}

interface PointResult {
  row_idx: number;
  col_idx: number;
  latitude: number;
  longitude: number;
  outcome: PointOutcome;
  rank: number | null;
  competitors: Competitor[];
}

class RpcFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function beginScan(admin: Admin, userId: string, keywordId: string, triggeredBy: "manual" | "schedule", createdBy: string | null): Promise<ScanContext> {
  const { data, error } = await admin.rpc("geo_grid_begin_scan", {
    p_user_id: userId,
    p_keyword_id: keywordId,
    p_triggered_by: triggeredBy,
    p_created_by: createdBy,
    p_monthly_limit: monthlyLimit(),
  });
  if (error) throw new RpcFailure(error.code ?? "", error.message);
  return data as ScanContext;
}

async function finishScan(admin: Admin, scanId: string, status: "completed" | "failed", message: string | null): Promise<Row> {
  const { data, error } = await admin.rpc("geo_grid_finish_scan", { p_scan_id: scanId, p_status: status, p_error: message });
  if (error) throw new RpcFailure(error.code ?? "", error.message);
  return data as Row;
}

/** Runs every grid point (bounded concurrency), stores the points, and closes the scan. Never throws after begin. */
async function runScan(admin: Admin, key: string, ctx: ScanContext, userId: string): Promise<Row> {
  try {
    const points = generateGridPoints(ctx.center_lat, ctx.center_lng, ctx.grid_size, ctx.radius_m);
    const bias = biasRadiusMeters(gridStepMeters(ctx.grid_size, ctx.radius_m));
    let fatal: string | null = null;
    const results: PointResult[] = new Array(points.length);
    let next = 0;

    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= points.length) return;
        const pt = points[i];
        const base = { row_idx: pt.row, col_idx: pt.col, latitude: pt.lat, longitude: pt.lng };
        if (fatal) {
          results[i] = { ...base, outcome: "error", rank: null, competitors: [] };
          continue;
        }
        try {
          const places = await textSearch(
            key,
            {
              textQuery: ctx.keyword,
              pageSize: MAX_RANK,
              languageCode: "en",
              locationBias: { circle: { center: { latitude: pt.lat, longitude: pt.lng }, radius: bias } },
            },
            "places.id,places.displayName",
          );
          const { rank, competitors } = findRank(
            places.map((p) => ({ id: p.id ?? "", name: p.displayName?.text ?? null })),
            ctx.place_id,
          );
          results[i] = { ...base, outcome: rank === null ? "not_found" : "ranked", rank, competitors };
        } catch (e) {
          if (e instanceof ProviderAuthError) fatal = e.message;
          else console.error(JSON.stringify({ event: "geo_grid_point_failed", error: e instanceof Error ? e.message : String(e) }));
          results[i] = { ...base, outcome: "error", rank: null, competitors: [] };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, points.length) }, worker));

    if (fatal) return await finishScan(admin, ctx.scan_id, "failed", fatal);

    for (let from = 0; from < results.length; from += INSERT_CHUNK) {
      const chunk = results.slice(from, from + INSERT_CHUNK).map((r) => ({ ...r, user_id: userId, scan_id: ctx.scan_id }));
      const { error } = await admin.from("geo_grid_points").insert(chunk);
      if (error) {
        console.error(JSON.stringify({ event: "geo_grid_points_insert_failed", code: error.code, message: error.message }));
        await admin.from("geo_grid_points").delete().eq("scan_id", ctx.scan_id);
        return await finishScan(admin, ctx.scan_id, "failed", "Could not save the scan results. Please try again.");
      }
    }

    const errors = results.filter((r) => r.outcome === "error").length;
    const note = errors > 0 ? `${errors} of ${results.length} grid points could not be checked.` : null;
    return await finishScan(admin, ctx.scan_id, errors === results.length ? "failed" : "completed", note);
  } catch (e) {
    console.error(JSON.stringify({ event: "geo_grid_scan_failed", error: e instanceof Error ? e.message : String(e) }));
    try {
      return await finishScan(admin, ctx.scan_id, "failed", "The scan stopped unexpectedly. Please try again.");
    } catch {
      return { id: ctx.scan_id, status: "failed" };
    }
  }
}

function rpcStatus(code: string): number {
  if (code === "P0002") return 404;
  if (code === "53400") return 429;
  if (code === "55000") return 409;
  if (code === "42501") return 403;
  if (code === "22023") return 400;
  return 500;
}

// ---------------------------------------------------------------------------
// Scheduled runs
// ---------------------------------------------------------------------------

async function runDue(admin: Admin, key: string | null): Promise<Row> {
  if (!key) return { processed: 0, skipped: "provider_not_configured" };
  const started = Date.now();
  const { data, error } = await admin.rpc("geo_grid_due_keywords", { p_limit: CRON_BATCH });
  if (error) throw new RpcFailure(error.code ?? "", error.message);
  const due = (Array.isArray(data) ? data : []) as Row[];
  let completed = 0;
  let failed = 0;
  let deferred = 0;
  for (const d of due) {
    if (Date.now() - started > CRON_BUDGET_MS) break;
    try {
      const ctx = await beginScan(admin, d.due_user_id, d.due_keyword_id, "schedule", d.due_created_by ?? null);
      const scan = await runScan(admin, key, ctx, d.due_user_id);
      if (scan.status === "completed") completed++;
      else failed++;
    } catch (e) {
      const code = e instanceof RpcFailure ? e.code : "";
      // Over budget / archived location / not found: push it back so it cannot block the queue.
      await admin.rpc("geo_grid_defer_keyword", { p_keyword_id: d.due_keyword_id, p_hours: code === "53400" ? 24 : 6 });
      deferred++;
      console.error(JSON.stringify({ event: "geo_grid_due_skipped", code, message: e instanceof Error ? e.message : String(e) }));
    }
  }
  return { processed: completed + failed, completed, failed, deferred };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Method not allowed.");

  let body: Row;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "Invalid JSON body.");
  }
  const action = typeof body?.action === "string" ? body.action : "";

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const key = placesKey();

  try {
    // ---- cron ----
    const cronHeader = req.headers.get("X-Cron-Secret");
    if (cronHeader) {
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || !safeEqual(cronHeader, secret)) return fail(401, "unauthorized", "Invalid cron secret.");
      if (action !== "run_due") return fail(400, "unknown_action", "Unknown action.");
      return json(await runDue(admin, key));
    }

    // ---- user ----
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return fail(401, "unauthorized", "Missing Authorization header.");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return fail(401, "unauthorized", "Invalid or expired session.");
    const userId = userData.user.id;

    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { data: ctxRows, error: ctxError } = await callerClient.rpc("geo_grid_context");
    const ctxRow = (Array.isArray(ctxRows) ? ctxRows[0] : ctxRows) as Row | null | undefined;
    if (ctxError || !ctxRow?.account_owner_id) return fail(403, "forbidden", "No account found for this user.");
    if (ctxRow.can_manage !== true) return fail(403, "forbidden", "You do not have permission to use local rank tracking.");
    const ownerId = ctxRow.account_owner_id as string;

    if (action === "status") {
      const { data: used, error } = await admin.rpc("geo_grid_month_usage", { p_user_id: ownerId });
      if (error) throw new RpcFailure(error.code ?? "", error.message);
      return json({ configured: key !== null, monthly_limit: monthlyLimit(), used_points: typeof used === "number" ? used : 0 });
    }

    if (action === "search_places") {
      if (!key) return fail(503, "provider_not_configured", "Local rank tracking is not set up yet. Ask your administrator to add a Google Places API key.");
      const query = typeof body.query === "string" ? body.query.replace(/\s+/g, " ").trim() : "";
      if (query.length < 2 || query.length > 160) return fail(400, "invalid_query", "Enter your business name and city (2–160 characters).");
      const request: Row = { textQuery: query, pageSize: 5, languageCode: "en" };
      if (typeof body.lat === "number" && typeof body.lng === "number" && validateCenter(body.lat, body.lng) === null) {
        request.locationBias = { circle: { center: { latitude: body.lat, longitude: body.lng }, radius: 50_000 } };
      }
      let raw: RawPlace[];
      try {
        raw = await textSearch(key, request, "places.id,places.displayName,places.formattedAddress,places.location");
      } catch (e) {
        if (e instanceof ProviderAuthError) return fail(502, "provider_auth", e.message);
        return fail(502, "provider_error", "Google Places is not responding right now. Please try again in a moment.");
      }
      const places = raw
        .filter((p) => p.id && p.displayName?.text && typeof p.location?.latitude === "number" && typeof p.location?.longitude === "number")
        .filter((p) => validateCenter(p.location!.latitude, p.location!.longitude) === null)
        .map((p) => ({
          place_id: p.id as string,
          name: p.displayName!.text as string,
          address: p.formattedAddress ?? "",
          latitude: p.location!.latitude as number,
          longitude: p.location!.longitude as number,
        }));
      return json({ places });
    }

    if (action === "scan") {
      if (!key) return fail(503, "provider_not_configured", "Local rank tracking is not set up yet. Ask your administrator to add a Google Places API key.");
      const keywordId = typeof body.keyword_id === "string" ? body.keyword_id : "";
      if (!UUID_RE.test(keywordId)) return fail(400, "invalid_keyword", "Unknown keyword.");
      let ctx: ScanContext;
      try {
        ctx = await beginScan(admin, ownerId, keywordId, "manual", userId);
      } catch (e) {
        if (e instanceof RpcFailure) return fail(rpcStatus(e.code), "scan_not_started", e.message);
        throw e;
      }
      const scan = await runScan(admin, key, ctx, ownerId);
      const { data: full } = await admin
        .from("geo_grid_scans")
        .select(
          "id, keyword_id, location_id, keyword, status, triggered_by, grid_size, radius_m, center_lat, center_lng, point_count, checked_count, ranked_count, top3_count, error_count, avg_rank, solv, error, started_at, completed_at",
        )
        .eq("id", scan.id ?? ctx.scan_id)
        .maybeSingle();
      return json({ scan: full ?? scan });
    }

    return fail(400, "unknown_action", "Unknown action.");
  } catch (e) {
    console.error(JSON.stringify({ event: "geo_grid_scan_error", error: e instanceof Error ? e.message : String(e) }));
    return fail(500, "internal", "Something went wrong. Please try again.");
  }
});
