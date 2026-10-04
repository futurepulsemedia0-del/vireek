// Fleet telemetry ingest — the front door for GPS / OBD / dashcam data.
//
//   POST /functions/v1/fleet-telemetry-ingest
//
// Two ways to authenticate (the tenant is ALWAYS derived server-side, never
// taken from the payload):
//   1. `X-Fleet-Token: <token>`   — provider webhooks / gateways. Only the
//      SHA-256 hash of the token is stored (telematics_connections).
//   2. `Authorization: Bearer <user JWT>` — Vireek apps (e.g. the technician
//      phone reporting its truck position).
//
// Body (all arrays optional, hard caps below):
//   {
//     "pings": [{ "vehicle_id" | "device_id", "provider"?, "recorded_at",
//                 "latitude", "longitude", "speed_mph"?, "heading_deg"?,
//                 "odometer_miles"?, "fuel_level_pct"?, "ignition_on"? }],
//     "events": [{ "vehicle_id" | "device_id", "event_type", "occurred_at",
//                  "severity"?, "value"?, "unit"?, "latitude"?, "longitude"?,
//                  "job_id"?, "media_url"? }],
//     "diagnostics": [{ "vehicle_id" | "device_id", "code", "description"?,
//                       "severity"?, "status"?: "active" | "cleared",
//                       "odometer_miles"? }]
//   }
//
// Deploy: supabase functions deploy fleet-telemetry-ingest --no-verify-jwt
// (JWT is verified in code so token-authenticated webhooks can reach it.)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { deriveHarshEvents, haversineMeters, type Ping } from "../_shared/fleet/intelligence.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Fleet-Token",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_PINGS = 500;
const MAX_EVENTS = 200;
const MAX_DIAGNOSTICS = 100;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHUNK = 200;

const EVENT_TYPES = new Set([
  "harsh_braking", "harsh_acceleration", "harsh_cornering", "speeding",
  "excessive_idle", "geofence_enter", "geofence_exit", "dashcam_clip", "collision",
]);
const DIAG_SEVERITIES = new Set(["info", "warning", "critical"]);

interface VehicleRef {
  id: string;
  telematics_provider: string | null;
  telematics_device_id: string | null;
  assigned_technician_id: string | null;
  odometer_miles: number | null;
  last_seen_at: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
}

interface Rejection { index: number; kind: "ping" | "event" | "diagnostic"; reason: string }

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function resolveTenant(
  req: Request,
  admin: SupabaseClient,
  supabaseUrl: string,
  anonKey: string,
): Promise<{ ownerId: string; connectionId: string | null; provider: string | null } | { error: string; status: number }> {
  const token = req.headers.get("X-Fleet-Token");
  if (token) {
    const hash = await sha256Hex(token.trim());
    const { data, error } = await admin
      .from("telematics_connections")
      .select("id, user_id, provider, status")
      .eq("token_hash", hash)
      .maybeSingle();
    if (error || !data || data.status !== "active") return { error: "Invalid or paused ingest token.", status: 401 };
    return { ownerId: data.user_id as string, connectionId: data.id as string, provider: data.provider as string };
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authHeader)) return { error: "Missing credentials.", status: 401 };
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData?.user) return { error: "Invalid or expired session.", status: 401 };
  const { data: ownerId, error: ownerError } = await authClient.rpc("get_account_owner_id");
  if (ownerError || !ownerId) return { error: "Could not resolve account.", status: 401 };
  return { ownerId: ownerId as string, connectionId: null, provider: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error(JSON.stringify({ event: "fleet_ingest_failed", error: "Missing Supabase env." }));
    return json({ error: "Server misconfiguration." }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const tenant = await resolveTenant(req, admin, supabaseUrl, anonKey);
  if ("error" in tenant) return json({ error: tenant.error }, tenant.status);
  const { ownerId, connectionId } = tenant;

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "Payload too large." }, 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Payload too large." }, 413);

  let body: { pings?: unknown; events?: unknown; diagnostics?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Body must be valid JSON." }, 400);
  }
  const pingsIn = Array.isArray(body.pings) ? body.pings : [];
  const eventsIn = Array.isArray(body.events) ? body.events : [];
  const diagsIn = Array.isArray(body.diagnostics) ? body.diagnostics : [];
  if (pingsIn.length > MAX_PINGS || eventsIn.length > MAX_EVENTS || diagsIn.length > MAX_DIAGNOSTICS) {
    return json({ error: `Limits per request: ${MAX_PINGS} pings, ${MAX_EVENTS} events, ${MAX_DIAGNOSTICS} diagnostics.` }, 413);
  }

  try {
    // ---- Vehicle lookup (tenant-scoped).
    const { data: vehicleRows, error: vehicleError } = await admin
      .from("vehicles")
      .select("id, telematics_provider, telematics_device_id, assigned_technician_id, odometer_miles, last_seen_at, last_latitude, last_longitude")
      .eq("user_id", ownerId);
    if (vehicleError) throw vehicleError;
    const vehicles = (vehicleRows ?? []) as VehicleRef[];
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const byDevice = new Map<string, VehicleRef[]>();
    for (const v of vehicles) {
      if (!v.telematics_device_id) continue;
      const list = byDevice.get(v.telematics_device_id) ?? [];
      list.push(v);
      byDevice.set(v.telematics_device_id, list);
    }

    const resolveVehicle = (item: Record<string, unknown>): VehicleRef | null => {
      if (typeof item.vehicle_id === "string") return byId.get(item.vehicle_id) ?? null;
      if (typeof item.device_id === "string") {
        const candidates = byDevice.get(item.device_id) ?? [];
        const provider = (typeof item.provider === "string" ? item.provider : tenant.provider) ?? null;
        const matched = provider ? candidates.filter((c) => c.telematics_provider === provider) : candidates;
        return matched.length === 1 ? matched[0] : null;
      }
      return null;
    };

    const rejected: Rejection[] = [];
    const now = Date.now();

    // ---- Pings.
    const pingRows: Record<string, unknown>[] = [];
    const pingsByVehicle = new Map<string, Ping[]>();
    pingsIn.forEach((item, index) => {
      const p = (item ?? {}) as Record<string, unknown>;
      const vehicle = resolveVehicle(p);
      if (!vehicle) return void rejected.push({ index, kind: "ping", reason: "unknown_vehicle" });
      const lat = num(p.latitude);
      const lng = num(p.longitude);
      if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return void rejected.push({ index, kind: "ping", reason: "invalid_coordinates" });
      }
      const t = typeof p.recorded_at === "string" ? Date.parse(p.recorded_at) : NaN;
      if (!Number.isFinite(t) || t > now + MAX_FUTURE_MS || t < now - MAX_AGE_MS) {
        return void rejected.push({ index, kind: "ping", reason: "invalid_or_stale_timestamp" });
      }
      const speed = num(p.speed_mph);
      const heading = num(p.heading_deg);
      const odo = num(p.odometer_miles);
      const fuel = num(p.fuel_level_pct);
      const ignition = typeof p.ignition_on === "boolean" ? p.ignition_on : null;
      pingRows.push({
        user_id: ownerId,
        vehicle_id: vehicle.id,
        technician_id: vehicle.assigned_technician_id,
        recorded_at: new Date(t).toISOString(),
        latitude: lat,
        longitude: lng,
        speed_mph: speed !== null && speed >= 0 && speed < 250 ? speed : null,
        heading_deg: heading !== null && heading >= 0 && heading <= 360 ? heading : null,
        odometer_miles: odo !== null && odo >= 0 ? odo : null,
        fuel_level_pct: fuel !== null && fuel >= 0 && fuel <= 100 ? fuel : null,
        ignition_on: ignition,
        source: typeof p.source === "string" ? p.source.slice(0, 40) : tenant.provider ?? "api",
      });
      const list = pingsByVehicle.get(vehicle.id) ?? [];
      list.push({ t, lat, lng, speedMph: speed, ignitionOn: ignition, odometer: odo });
      pingsByVehicle.set(vehicle.id, list);
    });

    let acceptedPings = 0;
    for (const batch of chunks(pingRows)) {
      const { data, error } = await admin
        .from("vehicle_telemetry_pings")
        .upsert(batch, { onConflict: "vehicle_id,recorded_at", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      acceptedPings += data?.length ?? 0;
    }

    // ---- Events: native + derived + geofence transitions.
    const eventRows: Record<string, unknown>[] = [];

    const jobIdsToCheck = Array.from(new Set(
      eventsIn.map((e) => (e as Record<string, unknown>)?.job_id).filter((v): v is string => typeof v === "string"),
    ));
    const ownedJobIds = new Set<string>();
    if (jobIdsToCheck.length > 0) {
      const { data: jobRows } = await admin.from("jobs").select("id").eq("user_id", ownerId).in("id", jobIdsToCheck);
      (jobRows ?? []).forEach((j) => ownedJobIds.add(j.id as string));
    }

    eventsIn.forEach((item, index) => {
      const e = (item ?? {}) as Record<string, unknown>;
      const vehicle = resolveVehicle(e);
      if (!vehicle) return void rejected.push({ index, kind: "event", reason: "unknown_vehicle" });
      if (typeof e.event_type !== "string" || !EVENT_TYPES.has(e.event_type)) {
        return void rejected.push({ index, kind: "event", reason: "unsupported_event_type" });
      }
      const t = typeof e.occurred_at === "string" ? Date.parse(e.occurred_at) : NaN;
      if (!Number.isFinite(t) || t > now + MAX_FUTURE_MS || t < now - 30 * 24 * 60 * 60 * 1000) {
        return void rejected.push({ index, kind: "event", reason: "invalid_or_stale_timestamp" });
      }
      const severity = Math.min(3, Math.max(1, Math.round(num(e.severity) ?? 1)));
      eventRows.push({
        user_id: ownerId,
        vehicle_id: vehicle.id,
        technician_id: vehicle.assigned_technician_id,
        job_id: typeof e.job_id === "string" && ownedJobIds.has(e.job_id) ? e.job_id : null,
        event_type: e.event_type,
        severity,
        value: num(e.value),
        unit: typeof e.unit === "string" ? e.unit.slice(0, 20) : null,
        latitude: num(e.latitude),
        longitude: num(e.longitude),
        occurred_at: new Date(t).toISOString(),
        media_url: typeof e.media_url === "string" && /^https:\/\//i.test(e.media_url) ? e.media_url.slice(0, 1000) : null,
        source: tenant.provider ?? "api",
      });
    });

    // Derived harsh events + geofence transitions from this batch's pings.
    const { data: fenceRows } = await admin
      .from("fleet_geofences")
      .select("id, name, geofence_type, latitude, longitude, radius_meters")
      .eq("user_id", ownerId)
      .eq("active", true)
      .in("geofence_type", ["depot", "restricted"]);
    const fences = (fenceRows ?? []) as { id: string; name: string; geofence_type: string; latitude: number; longitude: number; radius_meters: number }[];

    for (const [vehicleId, list] of pingsByVehicle) {
      const vehicle = byId.get(vehicleId) as VehicleRef;
      const ordered = [...list].sort((a, b) => a.t - b.t);

      for (const d of deriveHarshEvents(ordered)) {
        eventRows.push({
          user_id: ownerId, vehicle_id: vehicleId, technician_id: vehicle.assigned_technician_id, job_id: null,
          event_type: d.type, severity: d.severity, value: d.value, unit: d.unit,
          latitude: d.lat, longitude: d.lng, occurred_at: new Date(d.t).toISOString(), source: "derived",
        });
      }

      if (fences.length > 0) {
        const lastSeen = vehicle.last_seen_at ? Date.parse(vehicle.last_seen_at) : NaN;
        let prev: { lat: number; lng: number } | null =
          vehicle.last_latitude != null && vehicle.last_longitude != null && Number.isFinite(lastSeen) && lastSeen < ordered[0].t
            ? { lat: vehicle.last_latitude, lng: vehicle.last_longitude }
            : null;
        for (const p of ordered) {
          if (prev) {
            for (const f of fences) {
              const was = haversineMeters(prev.lat, prev.lng, f.latitude, f.longitude) <= f.radius_meters;
              const is = haversineMeters(p.lat, p.lng, f.latitude, f.longitude) <= f.radius_meters;
              if (was === is) continue;
              eventRows.push({
                user_id: ownerId, vehicle_id: vehicleId, technician_id: vehicle.assigned_technician_id, job_id: null,
                event_type: is ? "geofence_enter" : "geofence_exit",
                severity: is && f.geofence_type === "restricted" ? 2 : 1,
                latitude: p.lat, longitude: p.lng, occurred_at: new Date(p.t).toISOString(),
                metadata: { geofence_id: f.id, geofence_name: f.name, geofence_type: f.geofence_type },
                source: "derived",
              });
            }
          }
          prev = { lat: p.lat, lng: p.lng };
        }
      }
    }

    let eventsCreated = 0;
    for (const batch of chunks(eventRows)) {
      const { data, error } = await admin
        .from("vehicle_safety_events")
        .upsert(batch, { onConflict: "vehicle_id,event_type,occurred_at", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      eventsCreated += data?.length ?? 0;
    }

    // ---- Diagnostics (active codes are unique per vehicle).
    let diagnosticsChanged = 0;
    if (diagsIn.length > 0) {
      const vehicleIds = new Set<string>();
      const parsed: { vehicle: VehicleRef; code: string; description: string | null; severity: string; status: string; odometer: number | null }[] = [];
      diagsIn.forEach((item, index) => {
        const d = (item ?? {}) as Record<string, unknown>;
        const vehicle = resolveVehicle(d);
        if (!vehicle) return void rejected.push({ index, kind: "diagnostic", reason: "unknown_vehicle" });
        const code = typeof d.code === "string" ? d.code.trim().toUpperCase().slice(0, 32) : "";
        if (!code) return void rejected.push({ index, kind: "diagnostic", reason: "missing_code" });
        vehicleIds.add(vehicle.id);
        parsed.push({
          vehicle, code,
          description: typeof d.description === "string" ? d.description.slice(0, 300) : null,
          severity: typeof d.severity === "string" && DIAG_SEVERITIES.has(d.severity) ? d.severity : "warning",
          status: d.status === "cleared" ? "cleared" : "active",
          odometer: num(d.odometer_miles),
        });
      });

      if (parsed.length > 0) {
        const { data: activeRows, error: activeError } = await admin
          .from("vehicle_diagnostics")
          .select("id, vehicle_id, code")
          .eq("user_id", ownerId)
          .eq("status", "active")
          .in("vehicle_id", Array.from(vehicleIds));
        if (activeError) throw activeError;
        const active = new Map((activeRows ?? []).map((r) => [`${r.vehicle_id}:${r.code}`, r.id as string]));
        const nowIso = new Date().toISOString();

        for (const d of parsed) {
          const existingId = active.get(`${d.vehicle.id}:${d.code}`);
          if (d.status === "cleared") {
            if (existingId) {
              await admin.from("vehicle_diagnostics").update({ status: "cleared", cleared_at: nowIso, last_seen_at: nowIso }).eq("id", existingId);
              diagnosticsChanged++;
            }
          } else if (existingId) {
            await admin.from("vehicle_diagnostics").update({ last_seen_at: nowIso }).eq("id", existingId);
          } else {
            const { error } = await admin.from("vehicle_diagnostics").insert({
              user_id: ownerId, vehicle_id: d.vehicle.id, code: d.code, description: d.description,
              severity: d.severity, odometer_miles: d.odometer,
            });
            if (error && error.code !== "23505") throw error; // 23505 = raced with another request
            if (!error) diagnosticsChanged++;
          }
        }
      }
    }

    // ---- Vehicle live position + odometer (only if this batch is newer).
    for (const [vehicleId, list] of pingsByVehicle) {
      const vehicle = byId.get(vehicleId) as VehicleRef;
      const newest = list.reduce((a, b) => (b.t > a.t ? b : a));
      const lastSeen = vehicle.last_seen_at ? Date.parse(vehicle.last_seen_at) : 0;
      const maxOdo = list.reduce((m, p) => (p.odometer != null && p.odometer > m ? p.odometer : m), 0);
      const update: Record<string, unknown> = {};
      if (newest.t > lastSeen) {
        Object.assign(update, {
          last_latitude: newest.lat, last_longitude: newest.lng, last_speed_mph: newest.speedMph,
          last_ignition_on: newest.ignitionOn, last_seen_at: new Date(newest.t).toISOString(),
        });
      }
      if (maxOdo > Number(vehicle.odometer_miles ?? 0)) update.odometer_miles = maxOdo;
      if (Object.keys(update).length > 0) {
        const { error } = await admin.from("vehicles").update(update).eq("id", vehicleId).eq("user_id", ownerId);
        if (error) throw error;
      }
    }

    if (connectionId) {
      await admin.from("telematics_connections").update({ last_event_at: new Date().toISOString() }).eq("id", connectionId);
    }

    return json({
      accepted_pings: acceptedPings,
      duplicate_pings: Math.max(0, pingRows.length - acceptedPings),
      events_created: eventsCreated,
      diagnostics_changed: diagnosticsChanged,
      rejected: rejected.slice(0, 25),
      rejected_total: rejected.length,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "fleet_ingest_failed", owner: ownerId, error: String((error as Error)?.message ?? error) }));
    return json({ error: "Could not process telemetry." }, 500);
  }
});
