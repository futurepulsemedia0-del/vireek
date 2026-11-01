// supabase/functions/rum-ingest/index.ts
//
// PUBLIC beacon endpoint for real-user web vitals (no JWT; the browser cannot sign beacons).
// Defences: strict allow-list validation (shared contract), route normalisation, server-side rating,
// 8 KB body cap, best-effort per-IP rate limit. The IP lives only in a short-lived in-memory counter:
// it is never logged or stored. Writes use the service role; the table has no client policies.
//
// Deploy: supabase functions deploy rum-ingest --no-verify-jwt

import { adminClient } from "../_shared/data-platform/http.ts";
import { rate, validatePayload } from "../_shared/rum/vitals.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};
const MAX_BYTES = 8 * 1024;
const LIMIT_PER_MINUTE = 60;
const hits = new Map<string, { n: number; reset: number }>();

function allow(key: string, now: number): boolean {
  if (hits.size > 5000) hits.clear();
  const h = hits.get(key);
  if (!h || now >= h.reset) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    return true;
  }
  h.n += 1;
  return h.n <= LIMIT_PER_MINUTE;
}

const reply = (status = 204) => new Response(null, { status, headers: CORS });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return reply();
  if (req.method !== "POST") return reply(405);

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0]?.trim() ?? "unknown";
  if (!allow(ip, Date.now())) return reply(429);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413);

  const text = await req.text();
  if (text.length > MAX_BYTES) return reply(413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply(400);
  }

  const result = validatePayload(raw);
  if (!result.ok) return reply(422);
  const { payload } = result;

  const rows = payload.metrics.map((m) => ({
    metric: m.name,
    value: m.value,
    rating: rate(m.name, m.value), // never trust a client-supplied rating
    route: payload.route,
    device: payload.device,
    conn: payload.conn,
    release: payload.release,
    nav: payload.nav,
  }));
  const { error } = await adminClient().from("rum_vitals").insert(rows);
  if (error) {
    console.error("[rum-ingest] insert failed:", error.message);
    return reply(500);
  }
  return reply();
});
