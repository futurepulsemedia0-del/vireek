// supabase/functions/cost-index-public/index.ts (item 140) — the ONLY public egress of the Cost Index.
//   GET ?release=latest|<slug>&format=json|csv      frozen, published release document
//   GET ?list=1                                      version history (published / superseded / withdrawn notices; no cells)
// Deploy with --no-verify-jwt. Read-only, cacheable, no cookies, no per-visitor logging.
import { adminClient } from "../_shared/data-platform/http.ts";
import { costIndexToCsv, type CostIndexDocument } from "../_shared/cost-index/release.ts";

const BASE = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "X-Content-Type-Options": "nosniff", "Vary": "Accept-Encoding" };
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const err = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { ...BASE, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE });
  if (req.method !== "GET" && req.method !== "HEAD") return err(405, "Method not allowed.");
  const q = new URL(req.url).searchParams;
  const admin = adminClient();

  if (q.get("list") === "1") {
    const { data, error } = await admin.from("cost_index_releases")
      .select("slug,period_key,release_seq,status,method_version,cells_hash,changelog,published_at,withdrawn_at,withdrawn_reason")
      .in("status", ["published", "superseded", "withdrawn"]).not("published_at", "is", null).order("published_at", { ascending: false }).limit(50);
    if (error) return err(500, "Unavailable.");
    return new Response(JSON.stringify({ releases: data ?? [] }), { headers: { ...BASE, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=3600" } });
  }

  const release = q.get("release") ?? "latest";
  const format = q.get("format") ?? "json";
  if (release !== "latest" && (!SLUG_RE.test(release) || release.length > 60)) return err(400, "Invalid release.");
  if (!["json", "csv"].includes(format)) return err(400, "Invalid format.");

  let query = admin.from("cost_index_releases").select("slug,status,cells_hash,document");
  query = release === "latest" ? query.eq("status", "published").order("published_at", { ascending: false }).limit(1) : query.eq("slug", release).limit(1);
  const { data, error } = await query;
  if (error) return err(500, "Unavailable.");
  const row = data?.[0];
  if (!row) return err(404, "no_published_release");
  if (row.status === "withdrawn") return err(410, "This release was withdrawn.");
  if (row.status !== "published" && row.status !== "superseded") return err(404, "no_published_release");

  const doc = row.document as CostIndexDocument;
  const cache = { "Cache-Control": "public, max-age=300, s-maxage=3600", ETag: `"${row.cells_hash}-${format}"` };
  if (req.headers.get("If-None-Match") === cache.ETag) return new Response(null, { status: 304, headers: { ...BASE, ...cache } });
  if (format === "csv") {
    return new Response(costIndexToCsv(doc), { headers: { ...BASE, ...cache, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="vireek-${doc.slug}.csv"` } });
  }
  return new Response(JSON.stringify({ ...doc, superseded: row.status === "superseded" }), { headers: { ...BASE, ...cache, "Content-Type": "application/json; charset=utf-8" } });
});
