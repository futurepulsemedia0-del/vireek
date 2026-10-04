// supabase/functions/telemetry-ingest/index.ts
//
// Public ingest endpoint for Building Telemetry Intelligence. Any BACnet /
// Modbus / MQTT bridge, BMS/BAS export, smart thermostat, smart meter or
// IoT gateway posts readings here with a per-gateway token
// (Authorization: Bearer vrk_tg_...). Token = SHA-256 looked up in
// telemetry_gateways (same scheme as api_keys); raw token is never stored.
//
//   POST /telemetry-ingest
//   { "readings": [
//       { "point": "AHU-1/SAT", "value": 13.2, "ts": "2027-02-05T10:00:00Z",
//         "metric": "supply_air_temp", "unit": "C", "label": "AHU-1 supply air",
//         "equipment_id": "<optional uuid>" } ] }
//
// Limits: 500 readings / request, 1 MB body, timestamps within
// [now-7d, now+5min]. Idempotent: (point, ts) duplicates are ignored.
//
// Deploy: supabase functions deploy telemetry-ingest --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { METRIC_KINDS } from "../_shared/telemetry/anomaly.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const MAX_READINGS = 500;
const MAX_BODY_BYTES = 1_000_000;
const MAX_PAST_MS = 7 * 24 * 3600_000;
const MAX_FUTURE_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseTs(raw: unknown, now: number): number | null {
  if (raw === undefined || raw === null || raw === "") return now;
  let ms: number;
  if (typeof raw === "number") {
    ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : NaN; // epoch ms or seconds
  } else if (typeof raw === "string") {
    ms = Date.parse(raw);
  } else return null;
  if (!Number.isFinite(ms)) return null;
  if (ms < now - MAX_PAST_MS || ms > now + MAX_FUTURE_MS) return null;
  return ms;
}

interface Clean {
  externalId: string; ts: number; value: number;
  metric: string; unit: string | null; label: string | null; equipmentId: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- Authenticate gateway ------------------------------------------------
  const auth = req.headers.get("Authorization") || "";
  const rawToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!rawToken.startsWith("vrk_tg_")) {
    return json({ error: "Missing or malformed token. Use: Authorization: Bearer vrk_tg_..." }, 401);
  }
  const { data: gw } = await admin
    .from("telemetry_gateways")
    .select("id, user_id, auto_register, max_points, revoked_at")
    .eq("token_hash", await sha256Hex(rawToken))
    .maybeSingle();
  if (!gw || gw.revoked_at) return json({ error: "Invalid or revoked gateway token" }, 401);

  // ---- Parse + validate ----------------------------------------------------
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "Payload too large (max 1 MB)" }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: "Body must be valid JSON" }, 400); }

  const list: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { readings?: unknown })?.readings)
      ? (body as { readings: unknown[] }).readings
      : body && typeof body === "object" ? [body] : [];
  if (list.length === 0) return json({ error: "No readings supplied" }, 400);
  if (list.length > MAX_READINGS) return json({ error: `Too many readings (max ${MAX_READINGS} per request)` }, 413);

  const now = Date.now();
  const errors: { index: number; reason: string }[] = [];
  const dedup = new Map<string, Clean>();

  list.forEach((item, index) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const externalId = typeof r.point === "string" ? r.point.trim() : "";
    if (!externalId || externalId.length > 200) return errors.push({ index, reason: "invalid_point" });
    const value = typeof r.value === "number" ? r.value : typeof r.value === "string" ? Number(r.value) : NaN;
    if (!Number.isFinite(value) || Math.abs(value) > 1e9) return errors.push({ index, reason: "invalid_value" });
    const ts = parseTs(r.ts, now);
    if (ts === null) return errors.push({ index, reason: "invalid_or_out_of_window_ts" });
    const metric = typeof r.metric === "string" && r.metric ? r.metric : "other";
    if (!(METRIC_KINDS as readonly string[]).includes(metric)) return errors.push({ index, reason: "invalid_metric" });
    const equipmentId = typeof r.equipment_id === "string" && UUID_RE.test(r.equipment_id) ? r.equipment_id : null;
    dedup.set(`${externalId}|${ts}`, {
      externalId, ts, value, metric,
      unit: typeof r.unit === "string" ? r.unit.slice(0, 20) : null,
      label: typeof r.label === "string" ? r.label.slice(0, 120) : null,
      equipmentId,
    });
  });

  const clean = [...dedup.values()];
  if (clean.length === 0) return json({ accepted: 0, rejected: errors.length, errors: errors.slice(0, 20) }, 422);

  // ---- Resolve / auto-register points ---------------------------------------
  const externalIds = [...new Set(clean.map((c) => c.externalId))];
  const { data: existing, error: exErr } = await admin
    .from("telemetry_points").select("id, external_id").eq("gateway_id", gw.id);
  if (exErr) return json({ error: "Could not load points" }, 500);
  const pointByExt = new Map<string, string>((existing ?? []).map((p) => [p.external_id as string, p.id as string]));

  const unknown = externalIds.filter((e) => !pointByExt.has(e));
  if (unknown.length > 0) {
    const room = Math.max(0, gw.max_points - pointByExt.size);
    const allowed = gw.auto_register ? unknown.slice(0, room) : [];

    // Only accept equipment links that really belong to this account.
    const wantedEq = [...new Set(clean.map((c) => c.equipmentId).filter(Boolean))] as string[];
    let validEq = new Set<string>();
    if (wantedEq.length > 0) {
      const { data: eq } = await admin.from("equipment").select("id").eq("user_id", gw.user_id).in("id", wantedEq);
      validEq = new Set((eq ?? []).map((e) => e.id as string));
    }

    if (allowed.length > 0) {
      const rows = allowed.map((ext) => {
        const first = clean.find((c) => c.externalId === ext)!;
        return {
          user_id: gw.user_id, gateway_id: gw.id, external_id: ext, metric: first.metric,
          unit: first.unit, label: first.label,
          equipment_id: first.equipmentId && validEq.has(first.equipmentId) ? first.equipmentId : null,
        };
      });
      const { error: insErr } = await admin
        .from("telemetry_points").upsert(rows, { onConflict: "gateway_id,external_id", ignoreDuplicates: true });
      if (insErr) return json({ error: "Could not register points" }, 500);
      const { data: again } = await admin
        .from("telemetry_points").select("id, external_id").eq("gateway_id", gw.id).in("external_id", allowed);
      (again ?? []).forEach((p) => pointByExt.set(p.external_id as string, p.id as string));
    }
  }

  const rowsToInsert: { point_id: string; user_id: string; ts: string; value: number }[] = [];
  const latest = new Map<string, { ts: number; value: number }>();
  let unknownPointRejects = 0;
  for (const c of clean) {
    const pid = pointByExt.get(c.externalId);
    if (!pid) { unknownPointRejects++; continue; }
    rowsToInsert.push({ point_id: pid, user_id: gw.user_id, ts: new Date(c.ts).toISOString(), value: c.value });
    const cur = latest.get(pid);
    if (!cur || c.ts > cur.ts) latest.set(pid, { ts: c.ts, value: c.value });
  }
  if (unknownPointRejects > 0) {
    errors.push({ index: -1, reason: `${unknownPointRejects} reading(s) rejected: unknown point and auto-registration is off or the point limit (${gw.max_points}) is reached` });
  }

  // ---- Persist ---------------------------------------------------------------
  for (let i = 0; i < rowsToInsert.length; i += 500) {
    const { error } = await admin
      .from("telemetry_readings")
      .upsert(rowsToInsert.slice(i, i + 500), { onConflict: "point_id,ts", ignoreDuplicates: true });
    if (error) {
      console.error("telemetry-ingest: insert failed", error.message);
      return json({ error: "Could not store readings" }, 500);
    }
  }

  const updates = [...latest.entries()];
  for (let i = 0; i < updates.length; i += 25) {
    await Promise.all(updates.slice(i, i + 25).map(([pid, v]) =>
      admin.from("telemetry_points")
        .update({ last_value: v.value, last_ts: new Date(v.ts).toISOString() })
        .eq("id", pid)
        .or(`last_ts.is.null,last_ts.lt.${new Date(v.ts).toISOString()}`),
    ));
  }
  await admin.from("telemetry_gateways").update({ last_seen_at: new Date().toISOString() }).eq("id", gw.id);

  return json({ accepted: rowsToInsert.length, rejected: list.length - rowsToInsert.length, errors: errors.slice(0, 20) }, 202);
});
