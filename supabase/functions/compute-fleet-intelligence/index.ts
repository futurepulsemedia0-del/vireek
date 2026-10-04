// compute-fleet-intelligence — turns raw telematics into Fleet Intelligence.
//
//   Vehicle → GPS → Technician → Job → Drive → Arrival → Work → Outcome
//
// For every recently completed job it rebuilds the lifecycle from the
// technician's status timestamps + the vehicle's GPS pings, attributes a fully
// loaded cost (fuel, wear, idle, fixed, drive labor, on-site labor), writes the
// result to `fleet_trip_intelligence`, auto-links the vehicle in
// `job_vehicle_trips` (so the original Fleet Economics page fills itself), and
// rolls everything up into `fleet_intelligence_profiles` — the table Dispatch
// and Workforce Equilibrium read.
//
// Rule-based on purpose: fleet cost accounting must be auditable, not an LLM
// guess. All math lives in ../_shared/fleet/intelligence.ts (unit-tested).
//
// Auth:
//   • Dashboard "Refresh": the user's JWT → processes only that account.
//   • Scheduler: header `X-Cron-Secret` = FLEET_INTELLIGENCE_CRON_SECRET →
//     processes every account that has vehicles.
//
// Deploy:   supabase functions deploy compute-fleet-intelligence --no-verify-jwt
// Schedule: every 30–60 min (or at least daily), plus the Refresh button.
// Body:     { "days"?: 1-90 (default 30), "max_jobs"?: 1-500 (default 200) }

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  allocateFixedCost,
  buildProfiles,
  computeTripCosts,
  estimateVehicleCostPerMile,
  reconstructTrip,
  type Ping,
  type TripRowForProfile,
} from "../_shared/fleet/intelligence.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const COST_WINDOW_DAYS = 90;
const PROFILE_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
const PING_PAD_BEFORE_MS = 2 * 60_000;
const PING_PAD_AFTER_MS = 60_000;
const PING_LIMIT = 3000;
const CONCURRENCY = 8;

interface VehicleRow {
  id: string;
  assigned_technician_id: string | null;
  monthly_payment_cost: number | null;
  monthly_insurance_cost: number | null;
  fuel_type: string | null;
  rated_mpg: number | null;
  odometer_miles: number | null;
  last_latitude: number | null;
  last_longitude: number | null;
}
interface TechRow {
  id: string;
  hourly_cost_rate_cents: number | null;
  territory_id: string | null;
  home_latitude: number | null;
  home_longitude: number | null;
}
interface JobRow {
  id: string;
  assigned_technician_id: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  latitude: number | null;
  longitude: number | null;
  invoice_amount: number | null;
  invoice_status: string | null;
}
interface Staged {
  job: JobRow;
  vehicle: VehicleRow;
  tech: TechRow | null;
  trip: ReturnType<typeof reconstructTrip>;
  harsh: number;
  speeding: number;
  dayKey: string;
}

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const iso = (t: number | null): string | null => (t == null ? null : new Date(t).toISOString());

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function must<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>, label: string): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

async function processOwner(admin: SupabaseClient, ownerId: string, days: number, maxJobs: number) {
  const runStartedAt = new Date();
  const since = new Date(runStartedAt.getTime() - days * DAY_MS).toISOString();
  const costSince = new Date(runStartedAt.getTime() - COST_WINDOW_DAYS * DAY_MS);

  const vehicles = await must<VehicleRow[]>(
    admin.from("vehicles")
      .select("id, assigned_technician_id, monthly_payment_cost, monthly_insurance_cost, fuel_type, rated_mpg, odometer_miles, last_latitude, last_longitude")
      .eq("user_id", ownerId).neq("status", "retired"),
    "vehicles",
  );
  if (vehicles.length === 0) return { owner: ownerId, vehicles: 0, jobs_considered: 0, trips_scored: 0, trips_linked: 0, profiles_written: 0 };
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const vehiclesByTech = new Map<string, VehicleRow[]>();
  for (const v of vehicles) {
    if (!v.assigned_technician_id) continue;
    vehiclesByTech.set(v.assigned_technician_id, [...(vehiclesByTech.get(v.assigned_technician_id) ?? []), v]);
  }

  const techs = await must<TechRow[]>(
    admin.from("team_members").select("id, hourly_cost_rate_cents, territory_id, home_latitude, home_longitude").eq("account_owner_id", ownerId).eq("role", "technician"),
    "team_members",
  );
  const techById = new Map(techs.map((t) => [t.id, t]));

  const jobs = await must<JobRow[]>(
    admin.from("jobs")
      .select("id, assigned_technician_id, service_type, scheduled_datetime, arrived_at, started_at, completed_at, latitude, longitude, invoice_amount, invoice_status")
      .eq("user_id", ownerId).eq("job_status", "completed").not("assigned_technician_id", "is", null)
      .gte("completed_at", since).order("completed_at", { ascending: false }).limit(maxJobs),
    "jobs",
  );

  // Trips someone already logged by hand always win the vehicle choice.
  const existingTrips = jobs.length
    ? await must<{ job_id: string; vehicle_id: string; source: string }[]>(
        admin.from("job_vehicle_trips").select("job_id, vehicle_id, source").eq("user_id", ownerId).in("job_id", jobs.map((j) => j.id)),
        "job_vehicle_trips",
      )
    : [];
  const tripByJob = new Map(existingTrips.map((t) => [t.job_id, t]));

  // ---- Pass 1: reconstruct each job's lifecycle.
  const staged: (Staged | null)[] = await mapLimit(jobs, CONCURRENCY, async (job) => {
    const manual = tripByJob.get(job.id);
    const candidates = manual
      ? [vehicleById.get(manual.vehicle_id)].filter((v): v is VehicleRow => !!v)
      : (vehiclesByTech.get(job.assigned_technician_id) ?? []).slice(0, 3);
    if (candidates.length === 0) return null;

    const enRouteAt = ms(job.arrived_at);
    const startedAt = ms(job.started_at);
    const completedAt = ms(job.completed_at);
    const windowEnd = (startedAt ?? completedAt ?? (enRouteAt != null ? enRouteAt + 3 * 3_600_000 : null));
    const tech = techById.get(job.assigned_technician_id) ?? null;

    let best: { vehicle: VehicleRow; trip: ReturnType<typeof reconstructTrip> } | null = null;
    for (const vehicle of candidates) {
      let pings: Ping[] = [];
      if (enRouteAt != null && windowEnd != null) {
        const rows = await must<{ recorded_at: string; latitude: number; longitude: number; speed_mph: number | null; ignition_on: boolean | null; odometer_miles: number | null }[]>(
          admin.from("vehicle_telemetry_pings")
            .select("recorded_at, latitude, longitude, speed_mph, ignition_on, odometer_miles")
            .eq("vehicle_id", vehicle.id)
            .gte("recorded_at", new Date(enRouteAt - PING_PAD_BEFORE_MS).toISOString())
            .lte("recorded_at", new Date(windowEnd + PING_PAD_AFTER_MS).toISOString())
            .order("recorded_at", { ascending: true }).limit(PING_LIMIT),
          "pings",
        );
        pings = rows.map((r) => ({
          t: Date.parse(r.recorded_at),
          lat: Number(r.latitude),
          lng: Number(r.longitude),
          speedMph: r.speed_mph == null ? null : Number(r.speed_mph),
          ignitionOn: r.ignition_on,
          odometer: r.odometer_miles == null ? null : Number(r.odometer_miles),
        }));
      }
      const startFallback =
        tech?.home_latitude != null && tech?.home_longitude != null
          ? { lat: tech.home_latitude, lng: tech.home_longitude }
          : vehicle.last_latitude != null && vehicle.last_longitude != null
            ? { lat: vehicle.last_latitude, lng: vehicle.last_longitude }
            : null;

      const trip = reconstructTrip({
        job: { latitude: job.latitude, longitude: job.longitude, scheduledAt: ms(job.scheduled_datetime), enRouteAt, startedAt, completedAt },
        pings, startFallback,
      });
      // With several candidate vans, the one whose GPS actually reached the job wins.
      if (!best || (trip.arrivalVerified && !best.trip.arrivalVerified)) best = { vehicle, trip };
    }
    if (!best) return null;

    const dayMs = best.trip.departedAt ?? completedAt ?? ms(job.scheduled_datetime) ?? Date.now();
    return { job, vehicle: best.vehicle, tech, trip: best.trip, harsh: 0, speeding: 0, dayKey: new Date(dayMs).toISOString().slice(0, 10) };
  });
  const rows = staged.filter((s): s is Staged => s !== null);

  // ---- Safety events per trip window (one query per vehicle).
  if (rows.length > 0) {
    const byVehicle = new Map<string, Staged[]>();
    rows.forEach((s) => byVehicle.set(s.vehicle.id, [...(byVehicle.get(s.vehicle.id) ?? []), s]));
    await mapLimit(Array.from(byVehicle.entries()), CONCURRENCY, async ([vehicleId, list]) => {
      const starts = list.map((s) => s.trip.departedAt).filter((t): t is number => t != null);
      const ends = list.map((s) => s.trip.arrivedAt).filter((t): t is number => t != null);
      if (starts.length === 0 || ends.length === 0) return;
      const events = await must<{ event_type: string; occurred_at: string }[]>(
        admin.from("vehicle_safety_events").select("event_type, occurred_at")
          .eq("vehicle_id", vehicleId)
          .in("event_type", ["harsh_braking", "harsh_acceleration", "harsh_cornering", "speeding"])
          .gte("occurred_at", new Date(Math.min(...starts)).toISOString())
          .lte("occurred_at", new Date(Math.max(...ends)).toISOString()).limit(5000),
        "safety events",
      );
      for (const e of events) {
        const t = Date.parse(e.occurred_at);
        for (const s of list) {
          if (s.trip.departedAt != null && s.trip.arrivedAt != null && t >= s.trip.departedAt && t <= s.trip.arrivedAt) {
            if (e.event_type === "speeding") s.speeding++;
            else s.harsh++;
          }
        }
      }
    });
  }

  // ---- Per-vehicle cost basis (trailing 90 days).
  const vehicleIdsInBatch = Array.from(new Set(rows.map((s) => s.vehicle.id)));
  const costBasis = new Map<string, { cost: ReturnType<typeof estimateVehicleCostPerMile>; dailyFixedCents: number }>();
  if (vehicleIdsInBatch.length > 0) {
    const expenses = await must<{ vehicle_id: string; expense_type: string; amount: number; odometer_miles: number | null }[]>(
      admin.from("vehicle_expenses").select("vehicle_id, expense_type, amount, odometer_miles")
        .eq("user_id", ownerId).in("vehicle_id", vehicleIdsInBatch).gte("expense_date", costSince.toISOString().slice(0, 10)),
      "vehicle_expenses",
    );
    const stored = await must<{ job_id: string; vehicle_id: string; distance_miles: number | null }[]>(
      admin.from("fleet_trip_intelligence").select("job_id, vehicle_id, distance_miles")
        .eq("user_id", ownerId).in("vehicle_id", vehicleIdsInBatch).gte("work_completed_at", costSince.toISOString()),
      "fleet_trip_intelligence",
    );
    const batchJobIds = new Set(rows.map((s) => s.job.id));

    for (const vehicleId of vehicleIdsInBatch) {
      const v = vehicleById.get(vehicleId) as VehicleRow;
      let fuel = 0, maint = 0, extras = 0;
      let minOdo: number | null = null;
      for (const e of expenses) {
        if (e.vehicle_id !== vehicleId) continue;
        const cents = Math.round((Number(e.amount) || 0) * 100);
        if (e.expense_type === "fuel") fuel += cents;
        else if (e.expense_type === "maintenance" || e.expense_type === "repair") maint += cents;
        else extras += cents; // insurance, downtime, other → fixed
        if (e.odometer_miles != null) minOdo = minOdo == null ? Number(e.odometer_miles) : Math.min(minOdo, Number(e.odometer_miles));
      }
      const tripMiles =
        stored.filter((s) => s.vehicle_id === vehicleId && !batchJobIds.has(s.job_id)).reduce((s, r) => s + (Number(r.distance_miles) || 0), 0) +
        rows.filter((s) => s.vehicle.id === vehicleId).reduce((s, r) => s + (r.trip.distanceMiles ?? 0), 0);
      const odoDelta = minOdo != null && v.odometer_miles != null ? Math.max(0, Number(v.odometer_miles) - minOdo) : 0;
      costBasis.set(vehicleId, {
        cost: estimateVehicleCostPerMile({
          fuelExpenseCents: fuel, maintenanceExpenseCents: maint, windowMiles: Math.max(tripMiles, odoDelta),
          ratedMpg: v.rated_mpg == null ? null : Number(v.rated_mpg), fuelType: v.fuel_type,
        }),
        dailyFixedCents: Math.round((((Number(v.monthly_payment_cost) || 0) + (Number(v.monthly_insurance_cost) || 0)) / 30) * 100 + extras / COST_WINDOW_DAYS),
      });
    }
  }

  // ---- Fixed-cost allocation: one vehicle-day split by time across its jobs.
  const fixedByJob = new Map<string, number>();
  const byVehicleDay = new Map<string, Staged[]>();
  rows.forEach((s) => {
    const k = `${s.vehicle.id}:${s.dayKey}`;
    byVehicleDay.set(k, [...(byVehicleDay.get(k) ?? []), s]);
  });
  for (const [key, list] of byVehicleDay) {
    const basis = costBasis.get(key.split(":")[0]);
    const alloc = allocateFixedCost(
      list.map((s) => ({ id: s.job.id, weightMinutes: (s.trip.driveMinutes ?? 0) + (s.trip.onSiteMinutes ?? 0) || 60 })),
      basis?.dailyFixedCents ?? 0,
    );
    alloc.forEach((cents, jobId) => fixedByJob.set(jobId, cents));
  }

  // ---- Pass 2: costs + output rows.
  const computedAt = runStartedAt.toISOString();
  const outputRows = rows.map((s) => {
    const basis = costBasis.get(s.vehicle.id);
    const invoiced = s.job.invoice_status != null && s.job.invoice_status !== "not_sent";
    const costs = computeTripCosts({
      distanceMiles: s.trip.distanceMiles,
      driveMinutes: s.trip.driveMinutes,
      idleMinutes: s.trip.idleMinutes,
      onSiteMinutes: s.trip.onSiteMinutes,
      hourlyCostCents: s.tech?.hourly_cost_rate_cents ?? null,
      cost: basis?.cost ?? estimateVehicleCostPerMile({ fuelExpenseCents: 0, maintenanceExpenseCents: 0, windowMiles: 0, ratedMpg: null, fuelType: s.vehicle.fuel_type }),
      fixedCostCents: fixedByJob.get(s.job.id) ?? 0,
      fuelType: s.vehicle.fuel_type,
      revenueCents: invoiced ? Math.round((Number(s.job.invoice_amount) || 0) * 100) : 0,
    });
    return {
      user_id: ownerId,
      job_id: s.job.id,
      vehicle_id: s.vehicle.id,
      technician_id: s.job.assigned_technician_id,
      territory_id: s.tech?.territory_id ?? null,
      service_type: s.job.service_type,
      outcome: "completed",
      scheduled_at: s.job.scheduled_datetime,
      departed_at: iso(s.trip.departedAt),
      arrived_at: iso(s.trip.arrivedAt),
      work_started_at: s.job.started_at,
      work_completed_at: s.job.completed_at,
      arrival_verified: s.trip.arrivalVerified,
      drive_minutes: s.trip.driveMinutes,
      idle_minutes: s.trip.idleMinutes,
      on_site_minutes: s.trip.onSiteMinutes,
      arrival_delay_minutes: s.trip.arrivalDelayMinutes,
      distance_miles: s.trip.distanceMiles,
      distance_source: s.trip.distanceSource,
      avg_speed_mph: s.trip.avgSpeedMph,
      harsh_event_count: s.harsh,
      speeding_event_count: s.speeding,
      fuel_cost_cents: costs.fuelCostCents,
      wear_cost_cents: costs.wearCostCents,
      idle_cost_cents: costs.idleCostCents,
      fixed_cost_cents: costs.fixedCostCents,
      vehicle_cost_cents: costs.vehicleCostCents,
      drive_labor_cost_cents: costs.driveLaborCostCents,
      on_site_labor_cost_cents: costs.onSiteLaborCostCents,
      fully_loaded_cost_cents: costs.fullyLoadedCostCents,
      revenue_cents: costs.revenueCents,
      contribution_cents: costs.contributionCents,
      margin_pct: costs.marginPct,
      confidence: s.trip.confidence,
      data_quality: {
        flags: s.trip.flags,
        ping_count: s.trip.pingCount,
        gps_coverage: s.trip.gpsCoverage,
        cost_basis: basis?.cost.basis ?? "modeled",
        cost_per_mile_cents: basis ? Number((basis.cost.fuelCentsPerMile + basis.cost.wearCentsPerMile).toFixed(2)) : null,
        tech_rate_known: s.tech?.hourly_cost_rate_cents != null,
      },
      computed_at: computedAt,
    };
  });

  for (const batch of chunks(outputRows, 100)) {
    const { error } = await admin.from("fleet_trip_intelligence").upsert(batch, { onConflict: "job_id" });
    if (error) throw new Error(`fleet_trip_intelligence upsert: ${error.message}`);
  }

  // ---- Auto-link vehicle trips so Fleet Economics fills itself (manual rows are never overwritten).
  let tripsLinked = 0;
  const linkRows = rows
    .filter((s) => s.trip.distanceMiles != null && tripByJob.get(s.job.id)?.source !== "manual" && !(tripByJob.has(s.job.id) && tripByJob.get(s.job.id)?.vehicle_id !== s.vehicle.id))
    .map((s) => ({
      user_id: ownerId,
      job_id: s.job.id,
      vehicle_id: s.vehicle.id,
      miles_driven: s.trip.distanceMiles as number,
      minutes_driven: s.trip.driveMinutes,
      source: "telematics",
      created_at: s.job.completed_at ?? computedAt, // uniform keys: bulk upsert would null missing columns
    }));
  for (const batch of chunks(linkRows, 100)) {
    const { error } = await admin.from("job_vehicle_trips").upsert(batch, { onConflict: "job_id,vehicle_id" });
    if (error) throw new Error(`job_vehicle_trips upsert: ${error.message}`);
    tripsLinked += batch.length;
  }

  // ---- Profiles from the full trailing window (not just this batch).
  const windowRows = await must<(TripRowForProfile & { work_completed_at: string | null })[]>(
    admin.from("fleet_trip_intelligence")
      .select("technician_id, vehicle_id, territory_id, service_type, drive_minutes, idle_minutes, on_site_minutes, arrival_delay_minutes, distance_miles, harsh_event_count, fuel_cost_cents, wear_cost_cents, idle_cost_cents, vehicle_cost_cents, fully_loaded_cost_cents, revenue_cents, contribution_cents, margin_pct, confidence, work_completed_at")
      .eq("user_id", ownerId)
      .gte("work_completed_at", new Date(runStartedAt.getTime() - PROFILE_WINDOW_DAYS * DAY_MS).toISOString())
      .order("work_completed_at", { ascending: false }).limit(5000),
    "profile window",
  );
  const num = (v: unknown) => (v == null ? null : Number(v));
  const profiles = buildProfiles(
    windowRows.map((r) => ({
      ...r,
      drive_minutes: num(r.drive_minutes), idle_minutes: num(r.idle_minutes), on_site_minutes: num(r.on_site_minutes),
      arrival_delay_minutes: num(r.arrival_delay_minutes), distance_miles: num(r.distance_miles), margin_pct: num(r.margin_pct),
      harsh_event_count: Number(r.harsh_event_count) || 0, fuel_cost_cents: Number(r.fuel_cost_cents) || 0,
      wear_cost_cents: Number(r.wear_cost_cents) || 0, idle_cost_cents: Number(r.idle_cost_cents) || 0, vehicle_cost_cents: Number(r.vehicle_cost_cents) || 0,
      fully_loaded_cost_cents: Number(r.fully_loaded_cost_cents) || 0, revenue_cents: Number(r.revenue_cents) || 0,
      contribution_cents: Number(r.contribution_cents) || 0,
    })),
  );
  const profileRows = profiles.map((p) => ({ ...p, user_id: ownerId, window_days: PROFILE_WINDOW_DAYS, computed_at: computedAt }));
  for (const batch of chunks(profileRows, 100)) {
    const { error } = await admin.from("fleet_intelligence_profiles").upsert(batch, { onConflict: "user_id,profile_key" });
    if (error) throw new Error(`fleet_intelligence_profiles upsert: ${error.message}`);
  }
  // Anything not refreshed this run no longer exists in the window.
  const { error: staleError } = await admin.from("fleet_intelligence_profiles").delete().eq("user_id", ownerId).lt("computed_at", computedAt);
  if (staleError) throw new Error(`stale profile cleanup: ${staleError.message}`);

  const confidence = { high: 0, medium: 0, low: 0 };
  outputRows.forEach((r) => { confidence[r.confidence]++; });

  return {
    owner: ownerId,
    vehicles: vehicles.length,
    jobs_considered: jobs.length,
    trips_scored: outputRows.length,
    trips_linked: tripsLinked,
    profiles_written: profileRows.length,
    confidence,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error(JSON.stringify({ event: "compute_fleet_intelligence_failed", error: "Missing Supabase env." }));
    return json({ error: "Server misconfiguration." }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let days = 30;
  let maxJobs = 200;
  try {
    const body = await req.json();
    if (Number.isFinite(body?.days)) days = Math.min(90, Math.max(1, Math.round(body.days)));
    if (Number.isFinite(body?.max_jobs)) maxJobs = Math.min(500, Math.max(1, Math.round(body.max_jobs)));
  } catch { /* empty body → defaults */ }

  const cronSecret = Deno.env.get("FLEET_INTELLIGENCE_CRON_SECRET");
  const isCron = !!cronSecret && req.headers.get("X-Cron-Secret") === cronSecret;

  try {
    if (isCron) {
      const owners = await must<{ user_id: string }[]>(admin.from("vehicles").select("user_id").neq("status", "retired"), "owners");
      const results = [];
      for (const ownerId of Array.from(new Set(owners.map((o) => o.user_id)))) {
        try {
          results.push(await processOwner(admin, ownerId, days, maxJobs));
        } catch (error) {
          console.error(JSON.stringify({ event: "compute_fleet_intelligence_owner_failed", owner: ownerId, error: String((error as Error).message) }));
          results.push({ owner: ownerId, error: "failed" });
        }
      }
      return json({ accounts: results.length, results });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(authHeader)) return json({ error: "Unauthorized." }, 401);
    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const { data: ownerId, error: ownerError } = await authClient.rpc("get_account_owner_id");
    if (ownerError || !ownerId) return json({ error: "Could not resolve account." }, 401);

    const result = await processOwner(admin, ownerId as string, days, maxJobs);
    return json({
      vehicles_scanned: result.vehicles,
      jobs_considered: result.jobs_considered,
      trips_scored: result.trips_scored,
      trips_linked: result.trips_linked,
      profiles_written: result.profiles_written,
      confidence: "confidence" in result ? result.confidence : undefined,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_fleet_intelligence_failed", error: String((error as Error)?.message ?? error) }));
    return json({ error: "Could not compute fleet intelligence." }, 500);
  }
});
