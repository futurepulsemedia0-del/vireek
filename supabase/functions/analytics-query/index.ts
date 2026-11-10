// supabase/functions/analytics-query/index.ts
//
// Customer analytics API (Part A). Flag `analytics_layer` must be ON for the account (403 otherwise).
// POST { action: "get"|"csv", from, to, granularity?, teamIds? } | { action: "settings", ... }
//      | { action: "ack", alertId } | { action: "event", name, props }
// Auth: user JWT -> account owner. Owner, or a team member with billing access (reports_can_access).
// Settings changes are owner-only. All reads are scoped by the verified owner id (service client + explicit filter).
// Deploy: supabase functions deploy analytics-query

import { adminClient, authenticate, corsHeaders, json } from "../_shared/data-platform/http.ts";
import { CUSTOMER_METRICS, computeArAging, computeCustomerKpis, computeKpiSeries, seriesToCsv } from "../_shared/analytics/customerKpis.ts";
import { parseAnalyticsRequest } from "../_shared/analytics/request.ts";
import { DEFAULT_SETTINGS, ensureRollups, loadAr, loadRollups, loadSettings, loadTechs } from "../_shared/analytics/service.ts";

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const a = await authenticate(req);
    if (!a.ok) return a.res;
    const { ownerId, userId, canViewBilling } = a.caller;
    if (!canViewBilling) return json({ error: "You need billing access to view analytics." }, 403);

    const admin = adminClient();
    const { data: on } = await admin.rpc("analytics_feature_on", { p_owner: ownerId });
    if (on !== true) return json({ error: "Analytics is not enabled for this account.", code: "not_enabled" }, 403);

    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    const parsed = parseAnalyticsRequest(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const q = parsed.value;
    const today = new Date().toISOString().slice(0, 10);

    if (q.action === "get" || q.action === "csv") {
      await ensureRollups(admin, ownerId, today);
      const spanDays = Math.round((Date.parse(`${q.toDay}T00:00:00Z`) - Date.parse(`${q.fromDay}T00:00:00Z`)) / DAY_MS) + 1;
      const prevFrom = addDays(q.fromDay, -spanDays);
      const prevTo = addDays(q.fromDay, -1);
      const [{ rows, truncated }, techs, settings] = await Promise.all([
        loadRollups(admin, ownerId, prevFrom, q.toDay), loadTechs(admin, ownerId), loadSettings(admin, ownerId),
      ]);
      const opt = { fromDay: q.fromDay, toDay: q.toDay, teamIds: q.teamIds, hoursPerDay: settings.hoursPerDay };
      const series = computeKpiSeries(rows, techs.capacity, opt, q.granularity);
      if (q.action === "csv") {
        return json({ filename: `vireek-analytics-${q.fromDay}_${q.toDay}.csv`, csv: seriesToCsv(series) }, 200, { "Cache-Control": "private, no-store" });
      }
      const kpis = computeCustomerKpis(rows, techs.capacity, opt);
      const previous = computeCustomerKpis(rows, techs.capacity, { ...opt, fromDay: prevFrom, toDay: prevTo });
      const [ar, alerts] = await Promise.all([
        loadAr(admin, ownerId).then((r) => computeArAging(r, today)),
        admin.from("analytics_alerts").select("id, metric, severity, direction, bad, period_start, period_end, value, baseline_mean, z, created_at, acknowledged_at")
          .eq("user_id", ownerId).order("created_at", { ascending: false }).limit(20).then((r) => r.data ?? []),
      ]);
      return json({
        range: { from: q.fromDay, to: q.toDay, previousFrom: prevFrom, previousTo: prevTo }, kpis, previous, series, ar, alerts, settings,
        technicians: techs.names, definitions: CUSTOMER_METRICS, truncated, isOwner: userId === ownerId, generated_at: new Date().toISOString(),
      }, 200, { "Cache-Control": "private, no-store" });
    }

    if (q.action === "settings") {
      if (userId !== ownerId) return json({ error: "Only the account owner can change analytics settings." }, 403);
      const cur = await loadSettings(admin, ownerId);
      const next = {
        user_id: ownerId,
        hours_per_day: q.hoursPerDay ?? cur.hoursPerDay,
        digest_enabled: q.digestEnabled ?? cur.digestEnabled,
        digest_cadence: q.digestCadence ?? cur.digestCadence,
        alerts_enabled: q.alertsEnabled ?? cur.alertsEnabled,
        updated_at: new Date().toISOString(),
      };
      const { error } = await admin.from("analytics_settings").upsert(next, { onConflict: "user_id" });
      if (error) throw new Error(error.message);
      return json({ settings: { hoursPerDay: next.hours_per_day, digestEnabled: next.digest_enabled, digestCadence: next.digest_cadence, alertsEnabled: next.alerts_enabled } ?? DEFAULT_SETTINGS });
    }

    if (q.action === "ack") {
      const { error } = await admin.from("analytics_alerts").update({ acknowledged_at: new Date().toISOString() }).eq("id", q.alertId).eq("user_id", ownerId);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    // event (PII-free, allow-listed in parseAnalyticsRequest)
    await admin.from("analytics_events").insert({ user_id: ownerId, name: q.name, props: q.props });
    return json({ ok: true });
  } catch (err) {
    console.error("[analytics-query]", err instanceof Error ? err.message : err);
    return json({ error: "Could not load analytics. Please try again." }, 500);
  }
});
