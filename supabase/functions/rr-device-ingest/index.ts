// supabase/functions/rr-device-ingest/index.ts
//
// Vireek Remote Resolution Engine — sensor / IoT ingestion.
//
// A thermostat, leak sensor or any gateway POSTs readings for ONE piece of equipment:
//
//   POST /functions/v1/rr-device-ingest
//   x-device-key: rrk_...            (created once in Dashboard -> Remote Resolution -> Devices)
//   { "readings": [ { "metric": "supply_air_temp_f", "value": 71.5, "observed_at": "2027-03-15T10:00:00Z" } ] }
//
// Deploy with --no-verify-jwt (devices have no Supabase session). Security: the key is a 192-bit
// random secret, only its SHA-256 hash is stored, readings are range-checked against a metric
// whitelist, at most 50 per request, and each device is rate-limited inside the database.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { validReading } from "../_shared/remote-resolution/score.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Key",
};

const MAX_BODY_CHARS = 50_000;
const MAX_READINGS = 50;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = req.headers.get("x-device-key") ?? "";
  if (!/^rrk_[0-9a-f]{64}$/.test(key)) return json({ error: "Unauthorized" }, 401);

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return json({ error: "Payload too large" }, 413);

  let body: { readings?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.readings) || body.readings.length === 0 || body.readings.length > MAX_READINGS) {
    return json({ error: `Send 1 to ${MAX_READINGS} readings` }, 400);
  }

  const now = Date.now();
  const clean: { metric: string; value: number; observed_at: string }[] = [];
  let dropped = 0;
  for (const item of body.readings) {
    const o = (item ?? {}) as Record<string, unknown>;
    const metric = typeof o.metric === "string" ? o.metric : "";
    const value = typeof o.value === "number" ? o.value : Number(o.value);
    const t = o.observed_at ? Date.parse(String(o.observed_at)) : now;
    // Reject unknown metrics, out-of-range values, and timestamps from the future or older than 7 days.
    if (!validReading(metric, value) || !Number.isFinite(t) || t > now + 60_000 || t < now - 7 * 86_400_000) {
      dropped++;
      continue;
    }
    clean.push({ metric, value, observed_at: new Date(Math.min(t, now)).toISOString() });
  }
  if (clean.length === 0) return json({ error: "No valid readings", dropped }, 422);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc("rr_ingest_readings", { p_key: key, p_readings: clean });
  if (error) {
    console.error(JSON.stringify({ event: "rr_ingest_failed", error: error.message }));
    return json({ error: "Could not store readings" }, 500);
  }
  if (!data?.ok) {
    const status = data?.error === "rate_limited" ? 429 : data?.error === "unauthorized" ? 401 : 400;
    return json({ error: data?.error ?? "Rejected" }, status);
  }
  return json({ ok: true, inserted: data.inserted, dropped });
});
