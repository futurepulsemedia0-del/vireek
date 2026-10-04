// supabase/functions/iot-ingest/index.ts
//
// Telemetry ingestion endpoint for sensors / gateways / BMS bridges.
//
//   POST /functions/v1/iot-ingest
//   Header:  X-Device-Key: vpk_xxxxxxxx_<48 hex>      (or Authorization: Bearer <key>)
//   Body:    { "readings": [ { "metric": "vibration_mm_s", "value": 4.2, "ts": "2027-01-10T12:00:00Z" } ],
//              "battery_pct": 87 }
//            or a single reading: { "metric": "current_a", "value": 11.8 }
//
// Safety
//   * Keys are stored only as SHA-256 hashes; compared in constant time.
//   * Revoked / paused devices are rejected. Unknown keys get the same 401 as bad keys.
//   * Readings are validated (metric name, finite value, sane timestamp window) and
//     inserted idempotently — a gateway can safely retry the same batch.
//   * Hard caps: 256 KB body, 500 readings per request.
//
// Deploy: supabase functions deploy iot-ingest --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Key",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_READINGS = 500;
const METRIC_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_PAST_MS = 7 * 86_400_000;
const MAX_FUTURE_MS = 5 * 60_000;
const KEY_RE = /^(vpk_[0-9a-f]{8})_[0-9a-f]{48}$/;

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = (req.headers.get("X-Device-Key") ?? (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")).trim();
  const m = KEY_RE.exec(key);
  if (!m) return json({ error: "Invalid device key." }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Payload too large." }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json({ error: "Body must be valid JSON." }, 400); }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: device, error: dErr } = await admin
    .from("pio_devices").select("id, user_id, equipment_id, key_hash, status").eq("key_prefix", m[1]).maybeSingle();
  if (dErr) return json({ error: "Temporary error, retry." }, 503);
  if (!device || !safeEqual(device.key_hash as string, await sha256Hex(key))) return json({ error: "Invalid device key." }, 401);
  if (device.status !== "active") return json({ error: `Device is ${device.status}.` }, 403);

  const list = Array.isArray(body.readings) ? body.readings : body.metric !== undefined ? [body] : [];
  if (list.length === 0) return json({ error: "No readings supplied." }, 400);
  if (list.length > MAX_READINGS) return json({ error: `Max ${MAX_READINGS} readings per request.` }, 413);

  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  let rejected = 0;
  for (const r of list as Record<string, unknown>[]) {
    const metric = typeof r?.metric === "string" ? r.metric.trim().toLowerCase() : "";
    const value = typeof r?.value === "number" ? r.value : typeof r?.value === "string" ? Number(r.value) : NaN;
    const t = r?.ts === undefined || r?.ts === null ? now : new Date(r.ts as string).getTime();
    if (!METRIC_RE.test(metric) || !Number.isFinite(value) || Math.abs(value) > 1e9 || !Number.isFinite(t) ||
        t < now - MAX_PAST_MS || t > now + MAX_FUTURE_MS) { rejected++; continue; }
    rows.push({
      user_id: device.user_id, device_id: device.id, equipment_id: device.equipment_id,
      metric, value, recorded_at: new Date(t).toISOString(),
    });
  }

  if (rows.length > 0) {
    const { error } = await admin.from("pio_telemetry").upsert(rows, { onConflict: "device_id,metric,recorded_at", ignoreDuplicates: true });
    if (error) {
      console.error(JSON.stringify({ event: "iot_ingest_failed", device_id: device.id, error: error.message }));
      return json({ error: "Temporary error, retry." }, 503);
    }
  }

  const battery = typeof body.battery_pct === "number" && body.battery_pct >= 0 && body.battery_pct <= 100 ? Math.round(body.battery_pct) : undefined;
  await admin.from("pio_devices").update({
    last_seen_at: new Date().toISOString(), offline_alerted_at: null, ...(battery !== undefined ? { battery_pct: battery } : {}),
  }).eq("id", device.id);

  return json({ accepted: rows.length, rejected });
});
