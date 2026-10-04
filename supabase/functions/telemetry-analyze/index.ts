// supabase/functions/telemetry-analyze/index.ts
//
// The Telemetry -> Anomaly -> Failure probability -> Parts prediction stages.
//
// Two ways to call it:
//   1. Scheduler (pg_cron / external, every 15 min):
//        POST  header  x-cron-secret: <TELEMETRY_CRON_SECRET>   -> all accounts
//   2. Dashboard "Run analysis now" button:
//        POST  header  Authorization: Bearer <user JWT>          -> that account only
//
// Rule-based + robust statistics on purpose: every flag must be explainable
// to a technician, and per-account outcome feedback recalibrates it.
//
// Deploy:  supabase functions deploy telemetry-analyze --no-verify-jwt
// Secret:  supabase secrets set TELEMETRY_CRON_SECRET=<long random string>

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  computeBaseline, detectAnomalies, MIN_BASELINE_N,
  type Baseline, type DetectedAnomaly, type MetricKind,
} from "../_shared/telemetry/anomaly.ts";
import {
  applyCalibration, matchParts, MODEL_VERSION, scoreFailureModes, type Signal,
} from "../_shared/telemetry/failureModes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-cron-secret",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const HOUR = 3_600_000;
const MAX_POINTS_PER_RUN = 300;
const BASELINE_REFRESH_MS = 6 * HOUR;
const MIN_PROBABILITY = 0.15;
const NOTIFY_PROBABILITY = 0.6;

type Admin = SupabaseClient;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface PointRow {
  id: string; equipment_id: string | null; metric: MetricKind;
  min_valid: number | null; max_valid: number | null;
  baseline_median: number | null; baseline_mad: number | null; baseline_mean: number | null;
  baseline_std: number | null; baseline_n: number; baseline_updated_at: string | null;
}

interface OpenAnomaly { id: string; point_id: string; kind: string; detected_at: string }

async function analyzePoints(admin: Admin, userId: string, now: number) {
  const { data: pts, error } = await admin
    .from("telemetry_points")
    .select("id, equipment_id, metric, min_valid, max_valid, baseline_median, baseline_mad, baseline_mean, baseline_std, baseline_n, baseline_updated_at")
    .eq("user_id", userId).eq("status", "active")
    .gte("last_ts", new Date(now - 7 * 24 * HOUR).toISOString())
    .order("last_analyzed_at", { ascending: true, nullsFirst: true })
    .limit(MAX_POINTS_PER_RUN);
  if (error) throw new Error(`points: ${error.message}`);
  const points = (pts ?? []) as PointRow[];
  if (points.length === 0) return { points: 0, newAnomalies: 0, resolved: 0 };

  const open = new Map<string, OpenAnomaly>();
  for (const ids of chunk(points.map((p) => p.id), 100)) {
    const { data } = await admin.from("telemetry_anomalies")
      .select("id, point_id, kind, detected_at").eq("status", "open").in("point_id", ids);
    (data ?? []).forEach((a) => open.set(`${a.point_id}|${a.kind}`, a as OpenAnomaly));
  }

  let newAnomalies = 0;
  let resolved = 0;
  const nowIso = new Date(now).toISOString();

  for (const group of chunk(points, 10)) {
    await Promise.all(group.map(async (p) => {
      const { data: recentRows } = await admin.from("telemetry_readings")
        .select("ts, value").eq("point_id", p.id)
        .gte("ts", new Date(now - 24 * HOUR).toISOString())
        .order("ts", { ascending: true }).limit(2000);
      const recent = (recentRows ?? []).map((r) => ({ ts: Date.parse(r.ts as string), value: r.value as number }));

      // Baseline: learned from the 13 days BEFORE the analysis window, so a
      // developing fault can never contaminate its own "normal".
      let baseline: Baseline;
      const stored = p.baseline_n >= MIN_BASELINE_N && p.baseline_median !== null && p.baseline_updated_at &&
        now - Date.parse(p.baseline_updated_at) < BASELINE_REFRESH_MS;
      let baselineUpdate: Record<string, unknown> = {};
      if (stored) {
        baseline = { median: p.baseline_median!, mad: p.baseline_mad ?? 0, mean: p.baseline_mean ?? 0, std: p.baseline_std ?? 0, n: p.baseline_n };
      } else {
        const { data: hist } = await admin.from("telemetry_readings")
          .select("value").eq("point_id", p.id)
          .gte("ts", new Date(now - 14 * 24 * HOUR).toISOString())
          .lt("ts", new Date(now - 24 * HOUR).toISOString())
          .order("ts", { ascending: false }).limit(4000);
        baseline = computeBaseline((hist ?? []).map((r) => r.value as number));
        baselineUpdate = {
          baseline_median: baseline.median, baseline_mad: baseline.mad, baseline_mean: baseline.mean,
          baseline_std: baseline.std, baseline_n: baseline.n, baseline_updated_at: nowIso,
        };
      }

      const detected: DetectedAnomaly[] = recent.length
        ? detectAnomalies({ metric: p.metric, minValid: p.min_valid, maxValid: p.max_valid }, recent, baseline)
        : [];
      const detectedKinds = new Set(detected.map((d) => d.kind));

      for (const d of detected) {
        const fields = {
          equipment_id: p.equipment_id, severity: d.severity, direction: d.direction, z_score: d.zScore,
          observed: d.observed, expected: d.expected, persistence_hours: d.persistenceHours,
          explanation: d.explanation, last_seen_at: nowIso,
        };
        const existing = open.get(`${p.id}|${d.kind}`);
        if (existing) {
          await admin.from("telemetry_anomalies").update(fields).eq("id", existing.id);
        } else {
          const { error: insErr } = await admin.from("telemetry_anomalies")
            .insert({ user_id: userId, point_id: p.id, metric: p.metric, kind: d.kind, status: "open", ...fields });
          if (!insErr) newAnomalies++;
        }
      }

      // Auto-resolve conditions that have cleared (>= 1h old, to avoid flapping).
      for (const [key, a] of open) {
        if (a.point_id !== p.id) continue;
        const kind = key.split("|")[1];
        if (!detectedKinds.has(kind as DetectedAnomaly["kind"]) && now - Date.parse(a.detected_at) > HOUR && recent.length > 0) {
          await admin.from("telemetry_anomalies").update({ status: "resolved", resolved_at: nowIso }).eq("id", a.id);
          resolved++;
        }
      }

      await admin.from("telemetry_points").update({ ...baselineUpdate, last_analyzed_at: nowIso }).eq("id", p.id);
    }));
  }

  return { points: points.length, newAnomalies, resolved };
}

async function predictFailures(admin: Admin, userId: string, now: number) {
  const nowIso = new Date(now).toISOString();

  const { data: anomalies } = await admin.from("telemetry_anomalies")
    .select("equipment_id, metric, kind, direction, z_score, persistence_hours")
    .eq("user_id", userId).eq("status", "open").not("equipment_id", "is", null)
    .gte("last_seen_at", new Date(now - 72 * HOUR).toISOString());

  const byEquipment = new Map<string, Signal[]>();
  for (const a of anomalies ?? []) {
    const kind = a.kind as Signal["kind"];
    const zAbs = kind === "out_of_range" ? 8 : kind === "flatline" ? 4 : Math.abs(a.z_score as number);
    const list = byEquipment.get(a.equipment_id as string) ?? [];
    list.push({ metric: a.metric as MetricKind, kind, direction: a.direction as Signal["direction"], zAbs, persistenceHours: a.persistence_hours as number });
    byEquipment.set(a.equipment_id as string, list);
  }

  // Active predictions (need to be refreshed / expired even with no new signals).
  const { data: activePreds } = await admin.from("equipment_failure_predictions")
    .select("id, equipment_id, failure_mode, status, notified_at")
    .eq("user_id", userId).in("status", ["open", "prepared"]);
  const predKey = new Map((activePreds ?? []).map((p) => [`${p.equipment_id}|${p.failure_mode}`, p]));

  const equipmentIds = [...new Set([...byEquipment.keys(), ...(activePreds ?? []).map((p) => p.equipment_id as string)])];
  if (equipmentIds.length === 0) return { predictions: 0, notified: 0, expired: 0 };

  const equipment = new Map<string, { label: string; customer_id: string | null }>();
  for (const ids of chunk(equipmentIds, 100)) {
    const { data } = await admin.from("equipment")
      .select("id, equipment_type, make, model, customer_id").eq("user_id", userId).eq("status", "active").in("id", ids);
    (data ?? []).forEach((e) => equipment.set(e.id as string, {
      label: [e.equipment_type, e.make, e.model].filter(Boolean).join(" "), customer_id: e.customer_id as string | null,
    }));
  }

  const { data: outcomes } = await admin.from("telemetry_outcomes").select("failure_mode, outcome").eq("user_id", userId);
  const calib = new Map<string, { c: number; f: number }>();
  for (const o of outcomes ?? []) {
    const cur = calib.get(o.failure_mode as string) ?? { c: 0, f: 0 };
    if (o.outcome === "confirmed") cur.c++; else cur.f++;
    calib.set(o.failure_mode as string, cur);
  }

  const { data: catalogue } = await admin.from("inventory_parts")
    .select("id, name, part_number").eq("user_id", userId).eq("active", true).limit(2000);
  const stockByPart = new Map<string, number>();
  if ((catalogue ?? []).length > 0) {
    const { data: stock } = await admin.from("inventory_stock_levels")
      .select("part_id, quantity_on_hand, quantity_reserved").eq("user_id", userId);
    (stock ?? []).forEach((s) => stockByPart.set(
      s.part_id as string,
      (stockByPart.get(s.part_id as string) ?? 0) + Math.max(0, (s.quantity_on_hand as number) - (s.quantity_reserved as number)),
    ));
  }

  const { data: profile } = await admin.from("profiles").select("notify_ai_insight").eq("id", userId).maybeSingle();
  const canNotify = profile?.notify_ai_insight !== false;

  let predictions = 0, notified = 0, expired = 0;
  const seen = new Set<string>();

  for (const [equipmentId, info] of equipment) {
    const scores = scoreFailureModes(info.label, byEquipment.get(equipmentId) ?? []);
    for (const s of scores) {
      const c = calib.get(s.mode.id) ?? { c: 0, f: 0 };
      const probability = applyCalibration(s.probability, c.c, c.f);
      if (probability < MIN_PROBABILITY) continue;

      const parts = matchParts(s.mode.parts, catalogue ?? []).map((p) => ({
        ...p, in_stock: p.part_id ? (stockByPart.get(p.part_id) ?? 0) : null,
      }));
      const key = `${equipmentId}|${s.mode.id}`;
      seen.add(key);
      const existing = predKey.get(key);
      const common = {
        probability: Number(probability.toFixed(3)), confidence: Number(s.confidence.toFixed(3)),
        drivers: s.drivers, predicted_parts: parts, recommended_action: s.mode.action,
        horizon_days: s.mode.horizonDays, model_version: MODEL_VERSION,
      };

      let predId: string | null = existing?.id as string ?? null;
      let alreadyNotified = Boolean(existing?.notified_at);
      if (existing) {
        await admin.from("equipment_failure_predictions").update(common).eq("id", existing.id);
      } else {
        const { data: ins, error } = await admin.from("equipment_failure_predictions")
          .insert({ user_id: userId, equipment_id: equipmentId, failure_mode: s.mode.id, failure_label: s.mode.label, status: "open", ...common })
          .select("id").single();
        if (error) { console.error("telemetry-analyze: prediction insert", error.message); continue; }
        predId = ins.id as string;
        alreadyNotified = false;
      }
      predictions++;

      if (canNotify && !alreadyNotified && probability >= NOTIFY_PROBABILITY && predId) {
        const { error: nErr } = await admin.from("notifications").insert({
          user_id: userId, type: "ai_insight",
          title: `Likely failure: ${s.mode.label}`,
          message: `${info.label} — ${Math.round(probability * 100)}% probability within ${s.mode.horizonDays} days based on live telemetry. Prepare parts and schedule a proactive visit.`,
          action_url: "/dashboard/building-telemetry",
        });
        if (!nErr) {
          await admin.from("equipment_failure_predictions").update({ notified_at: nowIso }).eq("id", predId);
          notified++;
        }
      }
    }
  }

  // Expire open predictions whose evidence disappeared (never touch 'prepared').
  for (const [key, p] of predKey) {
    if (!seen.has(key) && p.status === "open") {
      await admin.from("equipment_failure_predictions").update({ status: "expired" }).eq("id", p.id);
      expired++;
    }
  }

  return { predictions, notified, expired };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const cronSecret = Deno.env.get("TELEMETRY_CRON_SECRET");
  const presented = req.headers.get("x-cron-secret");
  let accountIds: string[] = [];
  let isCron = false;

  if (cronSecret && presented && presented === cronSecret) {
    isCron = true;
    const { data } = await admin.from("telemetry_gateways").select("user_id").is("revoked_at", null);
    accountIds = [...new Set((data ?? []).map((g) => g.user_id as string))];
  } else {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !anonKey) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } }, auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "Unauthorized" }, 401);
    const { data: owner, error } = await userClient.rpc("get_account_owner_id");
    if (error || !owner) return json({ error: "Could not resolve account" }, 403);
    accountIds = [owner as string];
  }

  const now = Date.now();
  const summary = { accounts: accountIds.length, points: 0, newAnomalies: 0, resolved: 0, predictions: 0, notified: 0, expired: 0, failedAccounts: 0 };

  for (const userId of accountIds) {
    try {
      const a = await analyzePoints(admin, userId, now);
      const p = await predictFailures(admin, userId, now);
      summary.points += a.points; summary.newAnomalies += a.newAnomalies; summary.resolved += a.resolved;
      summary.predictions += p.predictions; summary.notified += p.notified; summary.expired += p.expired;
    } catch (e) {
      summary.failedAccounts++;
      console.error(`telemetry-analyze: account ${userId} failed`, e instanceof Error ? e.message : e);
    }
  }

  if (isCron) {
    const { error } = await admin.rpc("telemetry_housekeeping", { p_retention_days: 30 });
    if (error) console.error("telemetry-analyze: housekeeping failed", error.message);
  }

  return json(summary);
});
