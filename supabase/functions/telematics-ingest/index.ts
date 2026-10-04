// telematics-ingest — public webhook receiver (server-to-server, no user JWT).
//
// Two input shapes, one endpoint:
//   1) Generic normalized JSON (works with Geotab add-ins, Zapier, a custom gateway, ...)
//        POST /functions/v1/telematics-ingest        header: x-telematics-token: <token>
//        { "vehicles": [ { "external_id": "TRUCK-12",
//            "positions": [ { "timestamp": "2027-02-15T14:03:00Z", "latitude": 30.26, "longitude": -97.74,
//                             "speed_mph": 31, "engine_state": "on", "odometer_miles": 48210.4, "fuel_pct": 61 } ],
//            "events":    [ { "type": "harsh_brake", "timestamp": "...", "severity": "medium", "id": "evt-9" } ],
//            "faults":    [ { "code": "P0301", "description": "Cylinder 1 misfire", "severity": "high", "check_engine": true } ] } ] }
//      Optional integrity: x-telematics-timestamp + x-telematics-signature = hex HMAC-SHA256(token, `${ts}.${body}`)
//   2) Samsara alert webhooks:  POST .../telematics-ingest?t=<token>&provider=samsara
//      Signature (X-Samsara-Signature) is verified with the webhook secret you saved in Vireek.
//
// Deploy: supabase functions deploy telematics-ingest --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflight, decryptJson, jsonResponse, sha256Hex, verifyGenericSignature, verifySamsaraSignature } from "../_shared/telematics/security.ts";
import { EVENT_TYPES, VehicleSession, type EventType, type IncomingEvent, type IncomingFault, type IncomingFix } from "../_shared/telematics/ingest.ts";

const MAX_BODY_BYTES = 1_000_000;
const MAX_ITEMS = 500;

const num = (v: unknown): number | null => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };
const time = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000; // epoch ms or s
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
};
const engine = (v: unknown): IncomingFix["engine"] => { const s = String(v ?? "").toLowerCase(); return s === "on" || s === "off" || s === "idle" ? s : "unknown"; };

function parseFix(p: any): IncomingFix | null {
  const t = time(p?.timestamp ?? p?.time), lat = num(p?.latitude ?? p?.lat), lng = num(p?.longitude ?? p?.lng ?? p?.lon);
  if (t == null || lat == null || lng == null) return null;
  return {
    t, lat, lng, speedMph: num(p?.speed_mph), headingDeg: num(p?.heading), engine: engine(p?.engine_state),
    odometerMiles: num(p?.odometer_miles), engineHours: num(p?.engine_hours), fuelPct: num(p?.fuel_pct),
    checkEngine: typeof p?.check_engine === "boolean" ? p.check_engine : undefined,
    reverseGeo: typeof p?.address === "string" ? p.address : null,
  };
}

function parseEvent(e: any): IncomingEvent | null {
  const t = time(e?.timestamp ?? e?.time);
  const type = String(e?.type ?? "other") as EventType;
  if (t == null) return null;
  return {
    type: (EVENT_TYPES as readonly string[]).includes(type) ? type : "other", occurredAt: t, severity: e?.severity,
    lat: num(e?.latitude), lng: num(e?.longitude), speedMph: num(e?.speed_mph), speedLimitMph: num(e?.speed_limit_mph),
    durationSeconds: num(e?.duration_seconds), mediaUrl: typeof e?.media_url === "string" ? e.media_url : null,
    externalId: e?.id != null ? String(e.id).slice(0, 120) : null, details: typeof e?.details === "object" && e.details ? e.details : {},
  };
}

function parseFault(f: any): IncomingFault | null {
  if (!f?.code) return null;
  return { code: String(f.code), description: typeof f.description === "string" ? f.description : null, severity: f.severity, checkEngine: f.check_engine === true, cleared: f.cleared === true };
}

// ---- Samsara alert adapter (best-effort: unknown shapes degrade to an "other" event) ----------
function findVehicleId(o: any, depth = 0): string | null {
  if (!o || typeof o !== "object" || depth > 6) return null;
  if (o.vehicle && o.vehicle.id != null) return String(o.vehicle.id);
  for (const v of Object.values(o)) { const r = findVehicleId(v, depth + 1); if (r) return r; }
  return null;
}

function adaptSamsara(body: any): { externalId: string | null; events: IncomingEvent[] } {
  const text = JSON.stringify(body?.data?.conditions ?? body?.data ?? {}).toLowerCase();
  const has = (...w: string[]) => w.every((x) => text.includes(x));
  let type: EventType = "other";
  let severity: IncomingEvent["severity"] = "low";
  if (has("harsh") && (has("brak") || has("decel"))) type = "harsh_brake";
  else if (has("harsh") && has("accel")) type = "harsh_accel";
  else if (has("harsh") && (has("turn") || has("corner"))) type = "harsh_turn";
  else if (text.includes("speed")) type = "speeding";
  else if (text.includes("crash") || text.includes("collision")) { type = "collision"; severity = "critical"; }
  else if (text.includes("seatbelt")) type = "seatbelt";
  else if (text.includes("distract") || text.includes("phone")) type = "distracted_driving";
  const at = time(body?.data?.happenedAtTime) ?? time(body?.eventMs) ?? Date.now();
  return { externalId: findVehicleId(body), events: [{ type, occurredAt: at, severity, externalId: body?.eventId ? String(body.eventId) : null, details: { source_event_type: body?.eventType ?? null } }] };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const url = new URL(req.url);
  const token = req.headers.get("x-telematics-token") ?? url.searchParams.get("t") ?? "";
  if (token.length < 32) return jsonResponse({ error: "Unauthorized." }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonResponse({ error: "Payload too large." }, 413);

  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Server misconfiguration." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: conn } = await admin.from("telematics_connections")
    .select("id, user_id, provider, status, settings").eq("ingest_token_hash", await sha256Hex(token)).neq("status", "disconnected").maybeSingle();
  if (!conn) return jsonResponse({ error: "Unauthorized." }, 401);

  let body: any;
  try { body = JSON.parse(raw); } catch { return jsonResponse({ error: "Invalid JSON." }, 400); }

  const isSamsara = url.searchParams.get("provider") === "samsara" || req.headers.has("x-samsara-signature");
  const ts = req.headers.get("x-samsara-timestamp") ?? req.headers.get("x-telematics-timestamp") ?? "";

  try {
    if (isSamsara) {
      const { data: cred } = await admin.from("telematics_credentials").select("encrypted").eq("connection_id", conn.id).maybeSingle();
      const secret = cred ? (await decryptJson<{ webhook_secret?: string }>(cred.encrypted)).webhook_secret : undefined;
      if (!secret) return jsonResponse({ error: "Save the Samsara webhook secret in Vireek first." }, 401);
      if (!(await verifySamsaraSignature(raw, ts, req.headers.get("x-samsara-signature") ?? "", secret))) return jsonResponse({ error: "Invalid signature." }, 401);
      if (body?.eventType === "Ping") return jsonResponse({ ok: true, ping: true });
    } else if (req.headers.has("x-telematics-signature")) {
      if (!(await verifyGenericSignature(raw, ts, req.headers.get("x-telematics-signature") ?? "", token))) return jsonResponse({ error: "Invalid signature." }, 401);
    }

    const groups: { externalId: string | null; positions: unknown[]; events: unknown[]; faults: unknown[]; preEvents?: IncomingEvent[] }[] = [];
    if (isSamsara) {
      const a = adaptSamsara(body);
      groups.push({ externalId: a.externalId, positions: [], events: [], faults: [], preEvents: a.events });
    } else {
      const list = Array.isArray(body?.vehicles) ? body.vehicles : [body];
      for (const v of list.slice(0, 200)) {
        groups.push({ externalId: v?.external_id != null ? String(v.external_id) : null, positions: Array.isArray(v?.positions) ? v.positions.slice(0, MAX_ITEMS) : [], events: Array.isArray(v?.events) ? v.events.slice(0, MAX_ITEMS) : [], faults: Array.isArray(v?.faults) ? v.faults.slice(0, 100) : [] });
      }
    }

    const { data: vehicles } = await admin.from("vehicles").select("id, user_id, assigned_technician_id, telematics_external_id").eq("telematics_connection_id", conn.id);
    const byExt = new Map((vehicles ?? []).map((v) => [String(v.telematics_external_id), v]));

    const summary = { vehicles: 0, fixes: 0, events: 0, arrivals: 0, departures: 0, unmapped: [] as string[] };
    for (const g of groups) {
      const v = g.externalId ? byExt.get(g.externalId) : undefined;
      if (!v) { if (g.externalId) summary.unmapped.push(g.externalId); continue; }
      const session = new VehicleSession(admin, v, conn.settings);
      await session.init();
      const fixes = g.positions.map(parseFix).filter((x): x is IncomingFix => !!x).sort((a, b) => a.t - b.t);
      for (const f of fixes) await session.push(f);
      for (const e of [...(g.preEvents ?? []), ...g.events.map(parseEvent).filter((x): x is IncomingEvent => !!x)]) await session.event(e);
      for (const f of g.faults.map(parseFault).filter((x): x is IncomingFault => !!x)) await session.fault(f);
      await session.flush();
      summary.vehicles++; summary.fixes += session.stats.fixes; summary.events += session.stats.events;
      summary.arrivals += session.stats.arrivals; summary.departures += session.stats.departures;
    }

    await admin.from("telematics_connections").update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: null }).eq("id", conn.id);
    return jsonResponse({ ok: true, ...summary });
  } catch (error) {
    console.error(JSON.stringify({ event: "telematics_ingest_failed", error: String(error) }));
    return jsonResponse({ error: "Could not process telematics payload." }, 500);
  }
});
