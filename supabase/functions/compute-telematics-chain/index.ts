// compute-telematics-chain — turns raw GPS/events into the operational chain:
//   breadcrumbs -> vehicle_trips -> driver_safety_daily -> job miles -> job_operational_truth
// Deterministic and auditable (rules in _shared/telematics/engine.ts), never an LLM.
// It also writes real miles into the EXISTING job_vehicle_trips table, so
// compute-fleet-economics uses GPS-true mileage with zero changes.
//
// Auth: X-Cron-Secret (TELEMATICS_CRON_SECRET) / service-role bearer => all accounts;
//       a user JWT => only that user's account.  Body: { days?: 1..14 } (default 2)
// Deploy: supabase functions deploy compute-telematics-chain --no-verify-jwt ; schedule every 15 min.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflight, jsonResponse, timingSafeEqualStr } from "../_shared/telematics/security.ts";
import { deriveTrips, operationalTruth, round, safetyScore, type Fix } from "../_shared/telematics/engine.ts";

const DAY = 86_400_000;
const MAX_CRUMBS = 30_000;
const HARSH = new Set(["harsh_brake", "harsh_accel", "harsh_turn"]);
const OTHER_SAFETY = new Set(["collision", "distracted_driving", "seatbelt"]);

async function processAccount(admin: SupabaseClient, userId: string, days: number) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const res = { trips: 0, safety_days: 0, jobs_scored: 0, job_miles_written: 0 };

  const { data: vehicles } = await admin.from("vehicles").select("id, assigned_technician_id").eq("user_id", userId).not("telematics_external_id", "is", null);
  if (!vehicles?.length) return res;
  const vIds = vehicles.map((v) => v.id);

  const [{ data: events }, { data: visits }] = await Promise.all([
    admin.from("telematics_events").select("vehicle_id, event_type, occurred_at").in("vehicle_id", vIds).gte("occurred_at", since),
    admin.from("telematics_job_visits").select("id, job_id, vehicle_id, technician_id, arrived_at, departed_at, onsite_seconds, minutes_late").in("vehicle_id", vIds).gte("arrived_at", since),
  ]);

  const dayKey = (iso: string) => iso.slice(0, 10);
  const tripsByVehicle = new Map<string, any[]>();

  for (const v of vehicles) {
    const { data: crumbs } = await admin.from("vehicle_position_log").select("recorded_at, latitude, longitude, speed_mph, engine_state")
      .eq("vehicle_id", v.id).gte("recorded_at", since).order("recorded_at", { ascending: true }).limit(MAX_CRUMBS);
    const fixes: Fix[] = (crumbs ?? []).map((c) => ({ t: Date.parse(c.recorded_at), lat: c.latitude, lng: c.longitude, speedMph: c.speed_mph, engine: (c.engine_state ?? "unknown") as Fix["engine"] }));
    const vEvents = (events ?? []).filter((e) => e.vehicle_id === v.id);
    const vVisits = (visits ?? []).filter((x) => x.vehicle_id === v.id);

    const rows = deriveTrips(fixes).map((t) => {
      const linked = vVisits.find((x) => Math.abs(Date.parse(x.arrived_at) - t.endedAt) <= 15 * 60_000);
      const harsh = vEvents.filter((e) => HARSH.has(e.event_type) && Date.parse(e.occurred_at) >= t.startedAt && Date.parse(e.occurred_at) <= t.endedAt).length;
      return {
        user_id: userId, vehicle_id: v.id, technician_id: v.assigned_technician_id,
        started_at: new Date(t.startedAt).toISOString(), ended_at: new Date(t.endedAt).toISOString(),
        distance_miles: t.distanceMiles, driving_seconds: t.drivingSeconds, idle_seconds: t.idleSeconds, max_speed_mph: t.maxSpeedMph,
        start_latitude: t.start.lat, start_longitude: t.start.lng, end_latitude: t.end.lat, end_longitude: t.end.lng,
        harsh_event_count: harsh, linked_job_id: linked?.job_id ?? null, computed_at: new Date().toISOString(),
      };
    });
    if (rows.length) {
      const { error } = await admin.from("vehicle_trips").upsert(rows, { onConflict: "vehicle_id,started_at" });
      if (error) throw error;
      res.trips += rows.length;
    }
    tripsByVehicle.set(v.id, rows);

    // ---- daily safety rollup ----
    const days_ = new Set<string>([...rows.map((r) => dayKey(r.started_at)), ...vEvents.map((e) => dayKey(e.occurred_at))]);
    const safetyRows = [...days_].map((d) => {
      const dayTrips = rows.filter((r) => dayKey(r.started_at) === d);
      const dayEvents = vEvents.filter((e) => dayKey(e.occurred_at) === d);
      const c = (t: string) => dayEvents.filter((e) => e.event_type === t).length;
      const miles = dayTrips.reduce((s, r) => s + r.distance_miles, 0);
      const other = dayEvents.filter((e) => OTHER_SAFETY.has(e.event_type)).length;
      const inputs = { miles, harshBrake: c("harsh_brake"), harshAccel: c("harsh_accel"), harshTurn: c("harsh_turn"), speeding: c("speeding"), other };
      return {
        user_id: userId, vehicle_id: v.id, technician_id: v.assigned_technician_id, day: d, miles: round(miles, 1),
        driving_minutes: round(dayTrips.reduce((s, r) => s + r.driving_seconds, 0) / 60, 1), idle_minutes: round(dayTrips.reduce((s, r) => s + r.idle_seconds, 0) / 60, 1),
        harsh_brake: inputs.harshBrake, harsh_accel: inputs.harshAccel, harsh_turn: inputs.harshTurn, speeding_events: inputs.speeding, other_events: other,
        score: safetyScore(inputs), computed_at: new Date().toISOString(),
      };
    });
    if (safetyRows.length) {
      const { error } = await admin.from("driver_safety_daily").upsert(safetyRows, { onConflict: "vehicle_id,day" });
      if (error) throw error;
      res.safety_days += safetyRows.length;
    }
  }

  // ---- per-job chain ----
  const jobIds = [...new Set((visits ?? []).map((x) => x.job_id))];
  if (!jobIds.length) return res;

  const [{ data: jobs }, { data: profit }, { data: reviews }] = await Promise.all([
    admin.from("jobs").select("id, invoice_amount, invoice_status, is_rework, customer_disputed, assigned_technician_id").in("id", jobIds).eq("user_id", userId),
    admin.from("vehicle_job_profitability").select("job_id, truck_roll_cost").in("job_id", jobIds),
    admin.from("review_requests").select("job_id, rating").in("job_id", jobIds).eq("status", "completed"),
  ]);
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const costByJob = new Map((profit ?? []).map((p) => [p.job_id, Number(p.truck_roll_cost) || 0]));
  const ratingByJob = new Map((reviews ?? []).filter((r) => r.rating != null).map((r) => [r.job_id, r.rating as number]));

  for (const jobId of jobIds) {
    const job = jobById.get(jobId);
    const jv = (visits ?? []).filter((x) => x.job_id === jobId).sort((a, b) => Date.parse(a.arrived_at) - Date.parse(b.arrived_at));
    if (!job || !jv.length) continue;
    const vehicleId = jv[0].vehicle_id;
    const linkedTrips = (tripsByVehicle.get(vehicleId) ?? []).filter((t) => t.linked_job_id === jobId);
    const driveMiles = linkedTrips.reduce((s, t) => s + t.distance_miles, 0);
    const driveMin = linkedTrips.reduce((s, t) => s + t.driving_seconds, 0) / 60;
    const idleMin = linkedTrips.reduce((s, t) => s + t.idle_seconds, 0) / 60;
    const onsiteSec = jv.reduce((s, x) => s + (x.onsite_seconds ?? 0), 0);
    const closed = jv.every((x) => x.departed_at);

    const tripWindows = linkedTrips.map((t) => [Date.parse(t.started_at), Date.parse(t.ended_at)]);
    const jobEvents = (events ?? []).filter((e) => e.vehicle_id === vehicleId && tripWindows.some(([a, b]) => Date.parse(e.occurred_at) >= a && Date.parse(e.occurred_at) <= b));
    const harsh = jobEvents.filter((e) => HARSH.has(e.event_type)).length;
    const speeding = jobEvents.filter((e) => e.event_type === "speeding").length;

    const revenue = job.invoice_status === "not_sent" ? 0 : Number(job.invoice_amount) || 0;
    const travelCost = costByJob.get(jobId) ?? 0;
    const rating = ratingByJob.get(jobId) ?? null;
    const onsiteMin = closed ? onsiteSec / 60 : null;

    const truth = operationalTruth({
      arrivalVerified: true, minutesLate: jv[0].minutes_late, onsiteMinutes: onsiteMin, driveMiles, idleMinutes: idleMin,
      harshEvents: harsh, speedingEvents: speeding, revenue, travelCost, customerRating: rating,
      isRework: !!job.is_rework, customerDisputed: !!job.customer_disputed,
    });

    const { error } = await admin.from("job_operational_truth").upsert({
      user_id: userId, job_id: jobId, vehicle_id: vehicleId, technician_id: jv[0].technician_id ?? job.assigned_technician_id,
      drive_miles: round(driveMiles, 2), drive_minutes: round(driveMin, 1), idle_minutes: round(idleMin, 1), onsite_minutes: onsiteMin != null ? round(onsiteMin, 1) : null,
      minutes_late: jv[0].minutes_late, harsh_events: harsh, speeding_events: speeding, travel_cost: travelCost, revenue,
      value_per_onsite_hour: truth.valuePerOnsiteHour, customer_rating: rating, is_rework: !!job.is_rework, customer_disputed: !!job.customer_disputed,
      arrival_verified: true, integrity_score: truth.score, flags: truth.flags, computed_at: new Date().toISOString(),
    }, { onConflict: "job_id" });
    if (error) throw error;
    res.jobs_scored++;

    // GPS-true mileage into the existing Fleet Economics input table.
    if (driveMiles > 0) {
      const { error: tripErr } = await admin.from("job_vehicle_trips").upsert({
        user_id: userId, job_id: jobId, vehicle_id: vehicleId, miles_driven: round(driveMiles, 2), minutes_driven: Math.round(driveMin),
      }, { onConflict: "job_id,vehicle_id" });
      if (!tripErr) res.job_miles_written++;
    }
  }
  return res;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "", serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Server misconfiguration." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const days = Math.min(14, Math.max(1, Math.floor(Number(body?.days)) || 2));

  const cron = Deno.env.get("TELEMATICS_CRON_SECRET") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const system = (cron.length >= 16 && timingSafeEqualStr(req.headers.get("X-Cron-Secret") ?? "", cron)) || (!!bearer && timingSafeEqualStr(bearer, serviceKey));

  try {
    if (system) {
      const { data: owners } = await admin.from("telematics_connections").select("user_id").in("status", ["connected", "error"]);
      const ids = [...new Set((owners ?? []).map((o) => o.user_id))];
      const total = { accounts: ids.length, trips: 0, safety_days: 0, jobs_scored: 0, job_miles_written: 0 };
      for (const id of ids) {
        try { const r = await processAccount(admin, id, days); total.trips += r.trips; total.safety_days += r.safety_days; total.jobs_scored += r.jobs_scored; total.job_miles_written += r.job_miles_written; }
        catch (e) { console.error(JSON.stringify({ event: "telematics_chain_account_failed", account: id, error: String(e) })); }
      }
      return jsonResponse({ ok: true, ...total });
    }

    if (!authHeader || !anon) return jsonResponse({ error: "Unauthorized." }, 401);
    const caller = createClient(supabaseUrl, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return jsonResponse({ error: "Unauthorized." }, 401);
    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId) return jsonResponse({ error: "Could not resolve your account." }, 500);
    return jsonResponse({ ok: true, ...(await processAccount(admin, ownerId, days)) });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_telematics_chain_failed", error: String(error) }));
    return jsonResponse({ error: "Could not compute the telematics chain." }, 500);
  }
});
