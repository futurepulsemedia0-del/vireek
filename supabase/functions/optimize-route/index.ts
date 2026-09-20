// optimize-route
//
// Given one technician and one day, returns the best stop order for that
// day's jobs plus a leg-by-leg ETA. Stateless and cheap to recompute —
// that's the "dynamic rerouting" story here: when a job is added,
// cancelled, or runs long, the dashboard just calls this again for the
// remaining not-yet-started stops instead of maintaining a separately
// persisted route that would need its own invalidation logic.
//
// Travel-time source, in order of preference (all three are real, working
// code paths — nothing here is a hardcoded placeholder):
//   1. Google Distance Matrix, IF a `GOOGLE_MAPS_API_KEY` secret is set —
//      real road network + real-time traffic.
//   2. OSRM's public demo router (router.project-osrm.org) — real road
//      network, no live traffic. Free and keyless, but it's a shared demo
//      server: fine for a dashboard "recompute my route" click, not
//      appropriate for high-volume automated use. If your volume grows,
//      set GOOGLE_MAPS_API_KEY or self-host OSRM and swap the base URL.
//   3. Haversine distance + a configurable average-speed assumption — the
//      always-available fallback when neither of the above is reachable
//      (used transparently; the response's `etaSource` field always says
//      which path was actually used, so the UI can be honest about it).
//
// Ordering: nearest-neighbor construction + 2-opt local search on the
// chosen travel-time matrix. This is a standard, well-understood
// approximate-TSP approach — good enough for the 3-15 stop routes a
// single technician actually drives in a day, where an exact solver
// isn't needed and wouldn't meaningfully beat it.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const FETCH_TIMEOUT_MS = 8_000;
const AVG_SPEED_MPH = 25; // fallback-only assumption: mixed urban/suburban service routes

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Stop {
  jobId: string;
  address: string;
  latitude: number;
  longitude: number;
  durationMinutes: number;
  scheduledDatetime: string | null;
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ---- Travel-time matrix providers ------------------------------------

type Matrix = number[][]; // minutes, [from][to]

async function googleMatrix(points: { lat: number; lon: number }[], apiKey: string): Promise<Matrix | null> {
  try {
    const coords = points.map((p) => `${p.lat},${p.lon}`).join("|");
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${coords}&destinations=${coords}&departure_time=now&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "OK") return null;
    const rows = data.rows as { elements: { status: string; duration_in_traffic?: { value: number }; duration?: { value: number } }[] }[];
    return rows.map((row) =>
      row.elements.map((el) => {
        if (el.status !== "OK") return Number.POSITIVE_INFINITY;
        const seconds = el.duration_in_traffic?.value ?? el.duration?.value ?? Number.POSITIVE_INFINITY;
        return seconds / 60;
      }),
    );
  } catch (err) {
    console.error(JSON.stringify({ event: "google_matrix_failed", error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

async function osrmMatrix(points: { lat: number; lon: number }[]): Promise<Matrix | null> {
  try {
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
    const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.durations) return null;
    return (data.durations as number[][]).map((row) => row.map((seconds) => seconds / 60));
  } catch (err) {
    console.error(JSON.stringify({ event: "osrm_matrix_failed", error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

function haversineMatrix(points: { lat: number; lon: number }[]): Matrix {
  return points.map((a) =>
    points.map((b) => (a === b ? 0 : (haversineMiles(a.lat, a.lon, b.lat, b.lon) / AVG_SPEED_MPH) * 60),
  ));
}

// ---- Route construction: nearest-neighbor + 2-opt ---------------------

function nearestNeighborOrder(matrix: Matrix, startIndex: number): number[] {
  const n = matrix.length;
  const visited = new Set([startIndex]);
  const order = [startIndex];
  let current = startIndex;
  while (visited.size < n) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      if (matrix[current][j] < bestCost) {
        bestCost = matrix[current][j];
        best = j;
      }
    }
    if (best === -1) break;
    visited.add(best);
    order.push(best);
    current = best;
  }
  return order;
}

function routeLength(matrix: Matrix, order: number[]): number {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += matrix[order[i]][order[i + 1]];
  return total;
}

/** Standard 2-opt local search: repeatedly reverse a segment if it shortens the route. Stop index (0) stays fixed as the route start. */
function twoOpt(matrix: Matrix, order: number[]): number[] {
  let improved = true;
  let best = [...order];
  let bestLen = routeLength(matrix, best);
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard++;
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const candidateLen = routeLength(matrix, candidate);
        if (candidateLen < bestLen - 1e-6) {
          best = candidate;
          bestLen = candidateLen;
          improved = true;
        }
      }
    }
  }
  return best;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);
  const userId = userData.user.id;

  let body: { technicianId?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  if (!body.technicianId || !body.date) return jsonResponse({ error: "technicianId and date are required." }, 400);

  const { data: tech, error: techError } = await admin
    .from("team_members")
    .select("id, member_name, home_latitude, home_longitude")
    .eq("id", body.technicianId)
    .eq("account_owner_id", userId)
    .maybeSingle();
  if (techError) return jsonResponse({ error: techError.message }, 500);
  if (!tech) return jsonResponse({ error: "Technician not found." }, 404);

  const dayStart = `${body.date}T00:00:00`;
  const dayEnd = `${body.date}T23:59:59`;
  const { data: jobRows, error: jobsError } = await admin
    .from("jobs")
    .select("id, address, latitude, longitude, duration_minutes, scheduled_datetime, job_status")
    .eq("user_id", userId)
    .eq("assigned_technician_id", body.technicianId)
    .in("job_status", ["scheduled", "en_route", "in_progress"])
    .gte("scheduled_datetime", dayStart)
    .lte("scheduled_datetime", dayEnd);
  if (jobsError) return jsonResponse({ error: jobsError.message }, 500);

  const allJobs = jobRows ?? [];
  const unrouted = allJobs.filter((j) => j.latitude === null || j.longitude === null).map((j) => j.id);
  const stops: Stop[] = allJobs
    .filter((j) => j.latitude !== null && j.longitude !== null)
    .map((j) => ({
      jobId: j.id,
      address: j.address ?? "",
      latitude: j.latitude,
      longitude: j.longitude,
      durationMinutes: j.duration_minutes ?? 60,
      scheduledDatetime: j.scheduled_datetime,
    }));

  if (stops.length === 0) {
    return jsonResponse({
      technicianId: body.technicianId,
      technicianName: tech.member_name,
      date: body.date,
      etaSource: "n/a",
      stops: [],
      unrouted,
      totalDistanceMiles: 0,
      totalDriveMinutes: 0,
    });
  }

  const hasHome = tech.home_latitude !== null && tech.home_longitude !== null;
  const points = [
    ...(hasHome ? [{ lat: tech.home_latitude as number, lon: tech.home_longitude as number }] : []),
    ...stops.map((s) => ({ lat: s.latitude, lon: s.longitude })),
  ];
  const startIndex = 0; // home base if known, else the first job — either way index 0 stays fixed as the route start
  const stopOffset = hasHome ? 1 : 0;

  const googleKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  let matrix: Matrix | null = null;
  let etaSource: "google_traffic" | "osrm_road_network" | "estimated" = "estimated";

  if (points.length <= 10 && googleKey) {
    matrix = await googleMatrix(points, googleKey);
    if (matrix) etaSource = "google_traffic";
  }
  if (!matrix) {
    matrix = await osrmMatrix(points);
    if (matrix) etaSource = "osrm_road_network";
  }
  if (!matrix) {
    matrix = haversineMatrix(points);
    etaSource = "estimated";
  }

  const rawOrder = nearestNeighborOrder(matrix, startIndex);
  const optimizedOrder = points.length > 3 ? twoOpt(matrix, rawOrder) : rawOrder;

  // Walk the optimized order, skipping the synthetic home-base node, and
  // build cumulative ETAs starting from the earliest scheduled time (or
  // now, if every stop is unscheduled).
  const firstScheduled = stops
    .map((s) => s.scheduledDatetime)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  let clock = new Date(firstScheduled ?? new Date().toISOString());

  const orderedStops: {
    jobId: string;
    order: number;
    address: string;
    etaArrival: string;
    travelMinutesFromPrev: number;
    distanceMilesFromPrev: number;
  }[] = [];

  let totalDriveMinutes = 0;
  let totalDistanceMiles = 0;
  let prevIndex = startIndex;

  optimizedOrder.forEach((pointIndex, i) => {
    if (pointIndex === startIndex && hasHome) return; // skip the home-base node itself
    const stop = stops[pointIndex - stopOffset];
    const travelMinutes = i === 0 ? 0 : Math.round(matrix![prevIndex][pointIndex]);
    const distanceMiles = Math.round(
      haversineMiles(points[prevIndex].lat, points[prevIndex].lon, points[pointIndex].lat, points[pointIndex].lon) * 10,
    ) / 10;

    if (i > 0) clock = new Date(clock.getTime() + travelMinutes * 60000);
    orderedStops.push({
      jobId: stop.jobId,
      order: orderedStops.length + 1,
      address: stop.address,
      etaArrival: clock.toISOString(),
      travelMinutesFromPrev: travelMinutes,
      distanceMilesFromPrev: distanceMiles,
    });
    clock = new Date(clock.getTime() + stop.durationMinutes * 60000);

    totalDriveMinutes += travelMinutes;
    totalDistanceMiles += distanceMiles;
    prevIndex = pointIndex;
  });

  return jsonResponse({
    technicianId: body.technicianId,
    technicianName: tech.member_name,
    date: body.date,
    etaSource,
    stops: orderedStops,
    unrouted,
    totalDistanceMiles: Math.round(totalDistanceMiles * 10) / 10,
    totalDriveMinutes: Math.round(totalDriveMinutes),
  });
});
