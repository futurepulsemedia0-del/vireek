// supabase/functions/bi-gateway/index.ts
//
// Read-only live access for BI tools. Authenticated with a BI token (Authorization: Bearer vbi_… or
// Basic with the token as password), NOT a Supabase JWT. GET/HEAD only: there is no write path at all.
//
//   GET /bi-gateway/odata/                      service document          (Power BI, Excel, Tableau: "OData feed")
//   GET /bi-gateway/odata/$metadata             schema
//   GET /bi-gateway/odata/<EntitySet>           rows ($select $filter $orderby $top $skip $count, server paging)
//   GET /bi-gateway/v1/schema                   data dictionary for the datasets this token can read
//   GET /bi-gateway/v1/<dataset>?limit=&cursor=&updated_since=&format=json|csv
//
// Deploy: supabase functions deploy bi-gateway --no-verify-jwt
// Required secret: DATA_PLATFORM_ENCRYPTION_KEY (same as the Data Platform: keeps pseudonymised ids consistent).

import { adminClient, encryptionKey } from "../_shared/data-platform/http.ts";
import { DATASETS, isDatasetKey, type DatasetKey, type PiiMode } from "../_shared/data-platform/catalog.ts";
import { NIL_UUID, advanceCursor, type Cursor } from "../_shared/data-platform/warehouse.ts";
import { extractToken, hashToken, isExpired } from "../_shared/bi/access.ts";
import { PAGE_DEFAULT, PAGE_MAX, datasetFromEntitySet, decodeSkipToken, encodeSkipToken, entitySetName, metadataXml, normalizeLiteral, odataValue, pageBudget, parseODataQuery } from "../_shared/bi/odata.ts";
import { countRows, createShaper, readRows } from "../_shared/bi/reader.ts";
import { toCsv } from "../_shared/bi/serialize.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, OData-MaxVersion, OData-Version",
};
const BASE_HEADERS = { ...CORS, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const respond = (body: BodyInit | null, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers: { ...BASE_HEADERS, ...headers } });
const jsonRes = (data: unknown, status = 200, headers: Record<string, string> = {}) => respond(JSON.stringify(data), status, { "Content-Type": "application/json; charset=utf-8", ...headers });
const odataError = (status: number, message: string, headers: Record<string, string> = {}) =>
  jsonRes({ error: { code: String(status), message } }, status, { "OData-Version": "4.0", ...headers });
const unauthorized = () => odataError(401, "Invalid, expired or revoked token.", { "WWW-Authenticate": 'Basic realm="Vireek BI", charset="UTF-8"' });

interface TokenRow {
  id: string;
  user_id: string;
  datasets: string[];
  pii_mode: PiiMode;
  rate_limit_per_minute: number;
  expires_at: string | null;
}

const functionsBase = () => `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/bi-gateway`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond(null, 204);
  if (req.method !== "GET" && req.method !== "HEAD") return odataError(405, "This API is read-only.", { Allow: "GET, HEAD, OPTIONS" });

  const url = new URL(req.url);
  const segments = url.pathname.replace(/^\/bi-gateway\/?/, "").split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const area = segments[0] ?? "";
  const resource = segments[1] ?? "";

  const token = extractToken(req.headers.get("Authorization"));
  if (!token) return unauthorized();
  const admin = adminClient();
  let logId: number | null = null;

  try {
    const { data: row } = await admin
      .from("bi_access_tokens")
      .select("id,user_id,datasets,pii_mode,rate_limit_per_minute,expires_at")
      .eq("token_hash", await hashToken(token))
      .eq("status", "active")
      .maybeSingle();
    const t = row as TokenRow | null;
    if (!t || isExpired(t.expires_at)) return unauthorized();
    const allowed = t.datasets.filter(isDatasetKey) as DatasetKey[];

    // ---- routing (no database reads for metadata) ----
    if (area === "" || (area === "odata" && !resource) || (area === "odata" && resource === "$metadata") || (area === "v1" && resource === "schema")) {
      const begin = await admin.rpc("bi_begin_request", { p_token_id: t.id, p_limit: t.rate_limit_per_minute, p_dataset: "meta" });
      if (begin.data === null || begin.data === undefined) return odataError(429, "Rate limit reached. Try again in a minute.", { "Retry-After": "30" });
      logId = begin.data as number;
      if (area === "odata" && resource === "$metadata") return finish(admin, logId, 0, 200, respond(req.method === "HEAD" ? null : metadataXml(allowed), 200, { "Content-Type": "application/xml; charset=utf-8", "OData-Version": "4.0" }));
      if (area === "odata") {
        const base = `${functionsBase()}/odata`;
        return finish(admin, logId, 0, 200, jsonRes({ "@odata.context": `${base}/$metadata`, value: allowed.map((k) => ({ name: entitySetName(k), kind: "EntitySet", url: entitySetName(k) })) }, 200, { "OData-Version": "4.0" }));
      }
      if (area === "v1") {
        return finish(admin, logId, 0, 200, jsonRes({ datasets: allowed.map((k) => ({ key: k, label: DATASETS[k].label, description: DATASETS[k].description, columns: DATASETS[k].columns.map((c) => ({ name: c.name, type: c.type, description: c.description, privacy: c.pii ?? "none" })) })), pii_mode: t.pii_mode }));
      }
      return finish(admin, logId, 0, 200, jsonRes({ service: "Vireek BI gateway", read_only: true, odata: `${functionsBase()}/odata/`, rest: `${functionsBase()}/v1/<dataset>`, datasets: allowed }));
    }

    const isOData = area === "odata";
    const dataset: DatasetKey | null = isOData ? datasetFromEntitySet(resource, allowed) : area === "v1" ? (allowed.find((k) => k === resource.replace(/\.csv$/, "")) ?? null) : null;
    if (!dataset) return odataError(404, "Unknown or unavailable dataset for this token.");

    const begin = await admin.rpc("bi_begin_request", { p_token_id: t.id, p_limit: t.rate_limit_per_minute, p_dataset: dataset });
    if (begin.data === null || begin.data === undefined) return odataError(429, "Rate limit reached. Try again in a minute.", { "Retry-After": "30" });
    logId = begin.data as number;
    const shaper = await createShaper(encryptionKey(), t.user_id, t.pii_mode);
    const cols = DATASETS[dataset].columns;

    // ---------------- OData ----------------
    if (isOData) {
      const parsed = parseODataQuery(dataset, url.searchParams);
      if (!parsed.ok) return finish(admin, logId, 0, 400, odataError(400, parsed.message));
      const plan = parsed.value;
      const budget = pageBudget(plan);
      const offsetMode = !!plan.orderBy || plan.skip > 0;
      const cursor: Cursor = plan.skiptoken ? { ts: plan.skiptoken.ts, id: plan.skiptoken.id } : { ts: "1970-01-01T00:00:00.000Z", id: NIL_UUID };
      const rows = budget.limit === 0 ? [] : await readRows(admin, {
        ownerId: t.user_id, dataset, filters: plan.filters, limit: budget.limit,
        read: offsetMode ? { mode: "offset", column: plan.orderBy?.column ?? "updated_at", asc: plan.orderBy?.asc ?? true, offset: plan.skip } : { mode: "keyset", cursor },
      });
      const wanted = plan.select ?? cols.map((c) => c.name);
      const value: Record<string, unknown>[] = [];
      for (const r of rows) {
        const shaped = await shaper.shape(dataset, r, false);
        const o: Record<string, unknown> = {};
        for (const c of cols) if (wanted.includes(c.name)) o[c.name] = odataValue(c.type, shaped[c.name]);
        value.push(o);
      }
      const body: Record<string, unknown> = { "@odata.context": `${functionsBase()}/odata/$metadata#${entitySetName(dataset)}` };
      if (plan.count) body["@odata.count"] = await countRows(admin, t.user_id, dataset, plan.filters);
      body.value = value;

      const more = budget.remainingAfter === null ? rows.length === budget.limit : budget.remainingAfter > 0 && rows.length === budget.limit;
      if (more && rows.length) {
        const next = new URLSearchParams(url.searchParams);
        if (offsetMode) {
          next.set("$skip", String(plan.skip + rows.length));
          if (budget.remainingAfter !== null) next.set("$top", String(budget.remainingAfter));
        } else {
          const c = advanceCursor(rows as { updated_at?: unknown; id?: unknown }[], cursor);
          next.set("$skiptoken", encodeSkipToken({ ts: c.ts, id: c.id, remaining: budget.remainingAfter }));
          next.delete("$top");
        }
        body["@odata.nextLink"] = `${functionsBase()}/odata/${entitySetName(dataset)}?${next.toString()}`;
      }
      return finish(admin, logId, value.length, 200, jsonRes(body, 200, { "OData-Version": "4.0", "Content-Type": "application/json;odata.metadata=minimal;charset=utf-8" }), req.method === "HEAD");
    }

    // ---------------- REST (JSON / CSV) ----------------
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? PAGE_DEFAULT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) return finish(admin, logId, 0, 400, odataError(400, `limit must be a whole number between 1 and ${PAGE_MAX}.`));
    let cursor: Cursor = { ts: "1970-01-01T00:00:00.000Z", id: NIL_UUID };
    const since = url.searchParams.get("updated_since");
    if (since) {
      const iso = normalizeLiteral("timestamp", since);
      if (!iso) return finish(admin, logId, 0, 400, odataError(400, "updated_since must be an ISO 8601 timestamp."));
      cursor = { ts: iso, id: NIL_UUID };
    }
    const cur = url.searchParams.get("cursor");
    if (cur) {
      const d = decodeSkipToken(cur);
      if (!d) return finish(admin, logId, 0, 400, odataError(400, "The cursor is invalid. Start again without it."));
      cursor = { ts: d.ts, id: d.id };
    }
    const rows = await readRows(admin, { ownerId: t.user_id, dataset, read: { mode: "keyset", cursor }, limit });
    const shaped: Record<string, unknown>[] = [];
    for (const r of rows) shaped.push(await shaper.shape(dataset, r, false));
    const hasMore = rows.length === limit;
    const next = hasMore ? encodeSkipToken({ ts: advanceCursor(rows as { updated_at?: unknown; id?: unknown }[], cursor).ts, id: advanceCursor(rows as { updated_at?: unknown; id?: unknown }[], cursor).id, remaining: null }) : null;
    const wantCsv = resource.endsWith(".csv") || url.searchParams.get("format") === "csv";
    if (wantCsv) {
      return finish(admin, logId, shaped.length, 200, respond(req.method === "HEAD" ? null : toCsv(cols.map((c) => ({ name: c.name, type: c.type })), shaped), 200, {
        "Content-Type": "text/csv; charset=utf-8", "X-Has-More": String(hasMore), ...(next ? { "X-Next-Cursor": next } : {}), "Access-Control-Expose-Headers": "X-Next-Cursor, X-Has-More",
      }));
    }
    return finish(admin, logId, shaped.length, 200, jsonRes({ data: shaped, has_more: hasMore, next_cursor: next }));
  } catch (err) {
    console.error("[bi-gateway]", err instanceof Error ? err.message : err);
    if (logId !== null) await admin.from("bi_request_log").update({ status: 500 }).eq("id", logId);
    return odataError(500, "Something went wrong. Please try again.");
  }
});

async function finish(admin: ReturnType<typeof adminClient>, logId: number | null, rows: number, status: number, res: Response, head = false): Promise<Response> {
  if (logId !== null) await admin.from("bi_request_log").update({ rows, status }).eq("id", logId);
  return head ? new Response(null, { status: res.status, headers: res.headers }) : res;
}
