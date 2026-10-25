// supabase/functions/metrics-query/index.ts
//
// The semantic metrics API. One endpoint, one definition of every number: dashboards, reports and
// the Metrics tab call this; the finance copilot and the warehouse snapshots use the same
// _shared/data-platform/metrics.ts.
//
// POST { metrics: string[], from: ISO, to: ISO, tz?: IANA, granularity?: none|day|week|month,
//        groupBy?: service_type|technician|customer_type, compare?: boolean, filters?: {dim: string[]} }
//   -> { ...MetricsResponse, truncated: boolean, generated_at }
//
// Auth: user JWT. Owner, or a team member with can_view_billing (same rule as Reports/Analytics).
// Deploy: supabase functions deploy metrics-query   (JWT is verified in code as well)

import { adminClient, authenticate, corsHeaders, json } from "../_shared/data-platform/http.ts";
import { computeMetrics, parseMetricQuery } from "../_shared/data-platform/metrics.ts";
import { loadMetricData } from "../_shared/data-platform/loader.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const a = await authenticate(req);
    if (!a.ok) return a.res;
    if (!a.caller.canViewBilling) return json({ error: "You need billing access to view business metrics." }, 403);

    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    const parsed = parseMetricQuery(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const q = parsed.query;

    const span = Date.parse(q.to) - Date.parse(q.from);
    const loadFrom = new Date(Date.parse(q.from) - (q.compare ? span : 0) - 86_400_000).toISOString();
    const { data, truncated } = await loadMetricData(adminClient(), a.caller.ownerId, loadFrom);
    const res = computeMetrics(data, q);
    return json({ ...res, truncated, generated_at: new Date().toISOString() }, 200, { "Cache-Control": "private, no-store" });
  } catch (err) {
    console.error("[metrics-query]", err instanceof Error ? err.message : err);
    return json({ error: "Could not compute metrics. Please try again." }, 500);
  }
});
