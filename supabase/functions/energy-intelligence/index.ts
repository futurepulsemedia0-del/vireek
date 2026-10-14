// supabase/functions/energy-intelligence/index.ts
//
// Vireek Energy Intelligence.
// Bills + Property Intelligence (climate, sqft, rates) + Equipment (+ Equipment Health:
// telemetry anomalies, failure predictions, measured kWh) + Weather alerts -> one report.
//
// Deterministic on purpose: no LLM. This function only GATHERS data and hands it to the
// pure engine in _shared/energy-intelligence/engine.ts.
//
// Security model
//   - Caller identity comes from their own JWT; every read goes through a client scoped to
//     that JWT, so RLS enforces the account boundary (a stranger's customerId simply 404s).
//   - The analysis row is written with the service-role client so it cannot be forged.
//   - Advisory only: nothing here sends, books or files anything.
//
// Modes
//   { mode: "site", customerId, siteId?, escalation_pct? }  full report for one customer
//   { mode: "portfolio" }                                   ranked summary across customers

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  analyzeEnergy,
  ENGINE_VERSION,
  type EnergyInput,
  type EnergyReport,
  type EquipmentInput,
  type PredictionInput,
  type PropertyInput,
  type TelemetryAnomalyInput,
  type UsagePeriod,
  type WeatherEventInput,
} from "../_shared/energy-intelligence/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_PER_MINUTE = 20;
const PORTFOLIO_MAX_CUSTOMERS = 150;
const DAY_MS = 86_400_000;
const EQUIPMENT_COLS = "id, equipment_type, make, model, install_date, expected_lifespan_years, last_service_date, service_interval_months";

type Db = SupabaseClient;
type Rec = Record<string, unknown>;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function propertyFrom(row: Rec | null): PropertyInput {
  const climate = (row?.climate ?? null) as { monthly_mean_c?: unknown } | null;
  const energy = (row?.energy ?? null) as { residential_cents_per_kwh_12m_avg?: unknown; residential_cents_per_kwh?: unknown } | null;
  const monthly = Array.isArray(climate?.monthly_mean_c) && climate!.monthly_mean_c.length === 12 && climate!.monthly_mean_c.every((v) => typeof v === "number")
    ? (climate!.monthly_mean_c as number[])
    : null;
  return {
    living_sqft: numOrNull(row?.living_sqft),
    year_built: numOrNull(row?.year_built),
    monthly_mean_c: monthly,
    eia_cents_per_kwh: numOrNull(energy?.residential_cents_per_kwh_12m_avg) ?? numOrNull(energy?.residential_cents_per_kwh),
  };
}

function usageFrom(rows: Rec[] | null): UsagePeriod[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    fuel: r.fuel === "gas" ? "gas" : "electric",
    period_start: String(r.period_start),
    period_end: String(r.period_end),
    usage: Number(r.usage),
    cost_cents: r.cost_cents === null || r.cost_cents === undefined ? null : Number(r.cost_cents),
  }));
}

/** PostgREST-safe IN() over many ids. */
async function fetchIn(db: Db, table: string, select: string, col: string, ids: string[], tweak?: (q: any) => any): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    let q = db.from(table).select(select).in(col, ids.slice(i, i + 50));
    if (tweak) q = tweak(q);
    const { data } = await q;
    out.push(...((data ?? []) as Rec[]));
  }
  return out;
}

function measuredKwh30d(points: Rec[], rollups: Rec[]): Record<string, number> {
  const byPoint = new Map<string, Rec[]>();
  for (const r of rollups) {
    const k = String(r.point_id);
    byPoint.set(k, [...(byPoint.get(k) ?? []), r]);
  }
  const perEquipment = new Map<string, { kwh: number; days: Set<string> }>();
  for (const p of points) {
    const eqId = String(p.equipment_id ?? "");
    if (!eqId) continue;
    const slot = perEquipment.get(eqId) ?? { kwh: 0, days: new Set<string>() };
    for (const r of byPoint.get(String(p.id)) ?? []) {
      const day = String(r.day);
      if (p.metric === "power_kw" && Number(r.n) >= 6) {
        slot.kwh += Number(r.avg_value) * 24;
        slot.days.add(day);
      } else if (p.metric === "energy_kwh") {
        // Treated as a cumulative meter register: a day's use is max - min.
        slot.kwh += Math.max(0, Number(r.max_value) - Number(r.min_value));
        slot.days.add(day);
      }
    }
    perEquipment.set(eqId, slot);
  }
  const out: Record<string, number> = {};
  for (const [id, s] of perEquipment) if (s.days.size >= 7 && s.kwh > 0) out[id] = s.kwh;
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const caller = createClient(supabaseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const nowIso = new Date().toISOString();
    const escRaw = Number(body.escalation_pct);
    const escalation_pct = Number.isFinite(escRaw) ? Math.min(15, Math.max(0, escRaw)) : 2.5;

    // ------------------------------------------------------------------ portfolio
    if (body.mode === "portfolio") {
      const { data: periodRows, error: pErr } = await caller
        .from("energy_usage_periods")
        .select("id, customer_id, site_id, fuel, period_start, period_end, usage, cost_cents")
        .order("period_start", { ascending: false })
        .limit(20000);
      if (pErr) return json({ error: "Could not load billing history." }, 500);

      const byCustomer = new Map<string, Rec[]>();
      for (const r of (periodRows ?? []) as Rec[]) {
        const k = String(r.customer_id);
        byCustomer.set(k, [...(byCustomer.get(k) ?? []), r]);
      }
      const ids = [...byCustomer.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, PORTFOLIO_MAX_CUSTOMERS).map(([k]) => k);
      if (ids.length === 0) return json({ rows: [] });

      const [customers, sites, equipment] = await Promise.all([
        fetchIn(caller, "customers", "id, name", "id", ids),
        fetchIn(caller, "customer_sites", "id, customer_id, is_primary", "customer_id", ids),
        fetchIn(caller, "equipment", EQUIPMENT_COLS + ", customer_id", "customer_id", ids, (q) => q.eq("status", "active")),
      ]);
      const siteFor = new Map<string, string>();
      for (const s of sites.sort((a, b) => Number(b.is_primary === true) - Number(a.is_primary === true))) {
        if (!siteFor.has(String(s.customer_id))) siteFor.set(String(s.customer_id), String(s.id));
      }
      const profiles = await fetchIn(caller, "property_intelligence_profiles", "site_id, living_sqft, year_built, climate, energy", "site_id", [...siteFor.values()]);
      const profileBySite = new Map(profiles.map((p) => [String(p.site_id), p]));
      const nameOf = new Map(customers.map((c) => [String(c.id), String(c.name ?? "Customer")]));

      const rows = ids.map((cid) => {
        const siteId = siteFor.get(cid);
        const report: EnergyReport = analyzeEnergy({
          now: nowIso,
          usage: usageFrom(byCustomer.get(cid) ?? []),
          property: propertyFrom(siteId ? profileBySite.get(siteId) ?? null : null),
          equipment: equipment.filter((e) => String(e.customer_id) === cid) as unknown as EquipmentInput[],
          telemetry_anomalies: [], predictions: [], weather_events: [], measured_kwh_30d: {},
          escalation_pct,
        });
        return {
          customer_id: cid,
          name: nameOf.get(cid) ?? "Customer",
          months_covered: report.data_quality.months_covered,
          annual_cost_cents: report.totals.annual_cost_cents,
          expected_savings_cents: report.portfolio.savings_cents?.expected ?? null,
          high_anomalies: report.anomalies.filter((a) => a.severity === "high").length,
          grade: report.totals.grade,
          score: report.totals.efficiency_score,
          confidence: report.confidence,
          top_opportunity: report.opportunities[0]?.title ?? null,
        };
      }).sort((a, b) => (b.expected_savings_cents ?? -1) - (a.expected_savings_cents ?? -1));
      return json({ rows });
    }

    // ------------------------------------------------------------------ single site
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    if (!UUID_RE.test(customerId)) return json({ error: "Missing or invalid customerId." }, 400);
    const siteIdIn = typeof body.siteId === "string" && UUID_RE.test(body.siteId) ? body.siteId : null;

    const { data: customer } = await caller.from("customers").select("id, user_id").eq("id", customerId).maybeSingle();
    if (!customer) return json({ error: "Customer not found." }, 404);
    const ownerId: string = customer.user_id;

    const since = new Date(Date.now() - 60_000).toISOString();
    const { count: recent } = await admin.from("energy_analyses").select("id", { count: "exact", head: true }).eq("user_id", ownerId).gte("created_at", since);
    if ((recent ?? 0) >= RATE_LIMIT_PER_MINUTE) return json({ error: "Too many analyses in the last minute. Please wait a moment." }, 429);

    // Site: the one asked for, else the primary, else the first.
    const { data: siteRows } = await caller.from("customer_sites").select("id, is_primary").eq("customer_id", customerId).order("is_primary", { ascending: false }).limit(50);
    const sites = (siteRows ?? []) as { id: string; is_primary: boolean }[];
    if (siteIdIn && !sites.some((s) => s.id === siteIdIn)) return json({ error: "Site not found for this customer." }, 404);
    const siteId = siteIdIn ?? sites[0]?.id ?? null;

    let usageQuery = caller.from("energy_usage_periods").select("id, fuel, period_start, period_end, usage, cost_cents").eq("customer_id", customerId).order("period_start", { ascending: true }).limit(1000);
    if (siteId) usageQuery = usageQuery.or(`site_id.is.null,site_id.eq.${siteId}`);

    const [usageRes, profileRes, equipmentRes, weatherRes] = await Promise.all([
      usageQuery,
      siteId ? caller.from("property_intelligence_profiles").select("living_sqft, year_built, climate, energy").eq("site_id", siteId).maybeSingle() : Promise.resolve({ data: null }),
      caller.from("equipment").select(EQUIPMENT_COLS).eq("customer_id", customerId).eq("status", "active").limit(200),
      caller.from("weather_surge_events").select("event_type, severity, effective_at").gte("created_at", new Date(Date.now() - 365 * DAY_MS).toISOString()).limit(500),
    ]);
    if (usageRes.error) return json({ error: "Could not load billing history." }, 500);

    const equipment = (equipmentRes.data ?? []) as unknown as EquipmentInput[];
    const eqIds = equipment.map((e) => e.id);

    // Equipment Health: open telemetry anomalies, failure predictions, measured kWh (30 days).
    let telemetry_anomalies: TelemetryAnomalyInput[] = [];
    let predictions: PredictionInput[] = [];
    let measured: Record<string, number> = {};
    if (eqIds.length > 0) {
      const day30 = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const [anoms, preds, points] = await Promise.all([
        caller.from("telemetry_anomalies").select("id, equipment_id, metric, kind, severity, direction, explanation, detected_at").in("equipment_id", eqIds).eq("status", "open").limit(100),
        caller.from("equipment_failure_predictions").select("equipment_id, failure_label, probability, horizon_days").in("equipment_id", eqIds).in("status", ["open", "prepared"]).limit(200),
        caller.from("telemetry_points").select("id, equipment_id, metric").in("equipment_id", eqIds).in("metric", ["power_kw", "energy_kwh"]).eq("status", "active").limit(200),
      ]);
      telemetry_anomalies = ((anoms.data ?? []) as Rec[]).map((a) => ({
        id: String(a.id), equipment_id: (a.equipment_id as string | null) ?? null, metric: String(a.metric), kind: String(a.kind),
        severity: a.severity as TelemetryAnomalyInput["severity"], direction: a.direction === "low" ? "low" : "high",
        explanation: String(a.explanation ?? ""), detected_at: String(a.detected_at),
      }));
      predictions = ((preds.data ?? []) as Rec[]).map((p) => ({
        equipment_id: String(p.equipment_id), failure_label: String(p.failure_label), probability: Number(p.probability), horizon_days: Number(p.horizon_days),
      }));
      const pointRows = (points.data ?? []) as Rec[];
      if (pointRows.length > 0) {
        const rollups = await fetchIn(caller, "telemetry_rollups_daily", "point_id, day, n, min_value, max_value, avg_value", "point_id", pointRows.map((p) => String(p.id)), (q) => q.gte("day", day30));
        measured = measuredKwh30d(pointRows, rollups);
      }
    }

    const input: EnergyInput = {
      now: nowIso,
      usage: usageFrom(usageRes.data as Rec[] | null),
      property: propertyFrom((profileRes.data ?? null) as Rec | null),
      equipment, telemetry_anomalies, predictions,
      weather_events: ((weatherRes.data ?? []) as Rec[]).map((w) => ({ event_type: String(w.event_type), severity: (w.severity as string | null) ?? null, effective_at: (w.effective_at as string | null) ?? null })) as WeatherEventInput[],
      measured_kwh_30d: measured,
      escalation_pct,
    };
    const report = analyzeEnergy(input);

    let analysisId: string | null = null;
    let persisted = true;
    const { data: saved, error: saveError } = await admin
      .from("energy_analyses")
      .insert({
        user_id: ownerId, customer_id: customerId, site_id: siteId, requested_by: user.id, engine_version: ENGINE_VERSION,
        annual_cost_cents: report.totals.annual_cost_cents, expected_savings_cents: report.portfolio.savings_cents?.expected ?? null,
        anomaly_count: report.anomalies.length, efficiency_score: report.totals.efficiency_score, confidence: report.confidence, report,
      })
      .select("id")
      .single();
    if (saveError || !saved) persisted = false;
    else analysisId = saved.id;

    return json({ analysis_id: analysisId, persisted, site_id: siteId, report });
  } catch (err) {
    console.error("energy-intelligence error", err);
    return json({ error: "Unexpected error while analyzing energy." }, 500);
  }
});
