// supabase/functions/state-of-calls-public/index.ts
//
// The ONLY public egress of the report data. Serves the frozen, published edition document.
//   GET ?edition=latest|<slug>&format=json            (default)
//   GET ?edition=...&format=csv                       aggregates as CSV
//   GET ?edition=...&format=svg&metric=answer_rate&dim=trade   embeddable chart (SVG, attribution included)
// Deploy with --no-verify-jwt (public, read-only, cacheable). No cookies, no identifiers, no per-visitor logging.

import { adminClient } from "../_shared/data-platform/http.ts";
import { toCsv } from "../_shared/state-of-calls/csv.ts";
import { chartCells, renderBarChartSvg } from "../_shared/state-of-calls/chart.ts";
import { METRICS, metricByKey, type PublishedCell } from "../_shared/state-of-calls/schema.ts";
import type { EditionDocument } from "../_shared/state-of-calls/edition.ts";

const BASE = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "X-Content-Type-Options": "nosniff", "Vary": "Accept-Encoding" };
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIMS = ["national", "trade", "region", "season", "language"];
const err = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { ...BASE, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE });
  if (req.method !== "GET" && req.method !== "HEAD") return err(405, "Method not allowed.");
  const q = new URL(req.url).searchParams;
  const edition = q.get("edition") ?? "latest";
  const format = q.get("format") ?? "json";
  if (edition !== "latest" && (!SLUG_RE.test(edition) || edition.length > 60)) return err(400, "Invalid edition.");
  if (!["json", "csv", "svg"].includes(format)) return err(400, "Invalid format.");

  const admin = adminClient();
  let query = admin.from("report_editions").select("id,slug,status,cells_hash,published_at,document");
  query = edition === "latest"
    ? query.eq("status", "published").eq("document->>synthetic", "false").order("published_at", { ascending: false }).limit(1)
    : query.eq("slug", edition).limit(1);
  const { data, error } = await query;
  if (error) { console.error("[state-of-calls-public]", error.message); return err(500, "Unavailable."); }
  const row = data?.[0];
  if (!row) return err(404, "no_published_edition");
  if (row.status === "withdrawn") return err(410, "This edition was withdrawn.");
  if (row.status !== "published") return err(404, "no_published_edition");

  const doc = row.document as EditionDocument;
  const cache = { "Cache-Control": "public, max-age=300, s-maxage=3600", ETag: `"${row.cells_hash}-${format}-${q.get("metric") ?? ""}-${q.get("dim") ?? ""}"` };
  if (req.headers.get("If-None-Match") === cache.ETag) return new Response(null, { status: 304, headers: { ...BASE, ...cache } });
  admin.rpc("report_count_download", { p_edition: row.id, p_format: format === "svg" ? "embed" : format }).then(() => {}, () => {});

  if (format === "csv") {
    return new Response(toCsv(doc.cells, { slug: doc.slug, title: doc.title }), {
      headers: { ...BASE, ...cache, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="vireek-${doc.slug}.csv"` },
    });
  }
  if (format === "svg") {
    const metric = q.get("metric") ?? "";
    const dim = q.get("dim") ?? "";
    if (!metricByKey(metric) || !DIMS.includes(dim)) return err(400, `metric must be one of ${METRICS.map((m) => m.key).join(", ")} and dim one of ${DIMS.join(", ")}.`);
    const cells: PublishedCell[] = chartCells(doc.cells, metric, dim, doc.period_key);
    if (!cells.length) return err(404, "No data for that chart.");
    const svg = renderBarChartSvg({ title: `${metricByKey(metric)!.label} by ${dim}`, edition: doc.title, url: "vireek.com/state-of-home-service-calls", cells, synthetic: doc.synthetic });
    return new Response(svg, { headers: { ...BASE, ...cache, "Content-Type": "image/svg+xml; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  return new Response(JSON.stringify(doc), { headers: { ...BASE, ...cache, "Content-Type": "application/json; charset=utf-8" } });
});
