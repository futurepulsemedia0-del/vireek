// telematics-connect — dashboard-called management API for telematics connections.
// Requires a signed-in user who is the account owner or has can_manage_team.
// Credentials are AES-GCM encrypted at rest and are never returned to the browser.
//
// Body: { action, ... }
//   connect_samsara   { api_token }                -> validates token, imports/maps vehicles
//   create_webhook    { label? }                   -> generic webhook connection; returns token ONCE
//   rotate_token      { connection_id }            -> new ingest token ONCE
//   set_webhook_secret{ connection_id, secret }    -> Samsara webhook signing secret
//   map_vehicle       { connection_id, vehicle_id, external_id }
//   save_settings     { connection_id, settings }
//   disconnect        { connection_id }
//
// Deploy: supabase functions deploy telematics-connect
// Secrets: TELEMATICS_ENCRYPTION_KEY (openssl rand -base64 32)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflight, decryptJson, encryptJson, jsonResponse, randomToken, sha256Hex } from "../_shared/telematics/security.ts";
import { normalizeSettings } from "../_shared/telematics/engine.ts";
import { listVehicles, SamsaraError } from "../_shared/telematics/samsara.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "", anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "", serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anon || !serviceKey) return jsonResponse({ error: "Server misconfiguration." }, 500);
  if (!authHeader) return jsonResponse({ error: "Not authenticated." }, 401);

  const caller = createClient(supabaseUrl, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return jsonResponse({ error: "Not authenticated." }, 401);
  const { data: ownerId } = await caller.rpc("get_account_owner_id");
  if (!ownerId) return jsonResponse({ error: "Could not resolve your account." }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  if (user.id !== ownerId) {
    const { data: tm } = await admin.from("team_members").select("permissions").eq("user_id", user.id).eq("account_owner_id", ownerId).maybeSingle();
    if (tm?.permissions?.can_manage_team !== true) return jsonResponse({ error: "You don't have permission to manage telematics." }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON." }, 400); }
  const action = String(body?.action ?? "");
  const ingestUrl = `${supabaseUrl}/functions/v1/telematics-ingest`;

  const ownConnection = async (id: unknown) => {
    if (typeof id !== "string" || !uuid.test(id)) return null;
    const { data } = await admin.from("telematics_connections").select("id, provider, settings").eq("id", id).eq("user_id", ownerId).maybeSingle();
    return data;
  };

  try {
    if (action === "connect_samsara") {
      const apiToken = String(body?.api_token ?? "").trim();
      if (apiToken.length < 20) return jsonResponse({ error: "Enter a valid Samsara API token." }, 400);
      let fleet;
      try { fleet = await listVehicles(apiToken); } catch (e) { return jsonResponse({ error: e instanceof SamsaraError ? e.message : "Could not reach Samsara." }, 400); }

      const { data: existing } = await admin.from("telematics_connections").select("id, ingest_token_hash").eq("user_id", ownerId).eq("provider", "samsara").maybeSingle();
      const ingestToken = existing?.ingest_token_hash ? null : randomToken(32);
      const row = { user_id: ownerId, provider: "samsara", label: "Samsara", status: "connected", last_error: null, last_sync_at: null };
      const { data: conn, error } = existing
        ? await admin.from("telematics_connections").update(row).eq("id", existing.id).select("id").single()
        : await admin.from("telematics_connections").insert({ ...row, ingest_token_hash: await sha256Hex(ingestToken!) }).select("id").single();
      if (error || !conn) throw error ?? new Error("insert failed");

      const prior = existing ? (await admin.from("telematics_credentials").select("encrypted").eq("connection_id", conn.id).maybeSingle()).data : null;
      const keep = prior ? await decryptJson<Record<string, string>>(prior.encrypted).catch(() => ({})) : {};
      await admin.from("telematics_credentials").upsert({ connection_id: conn.id, user_id: ownerId, encrypted: await encryptJson({ ...keep, api_token: apiToken }), updated_at: new Date().toISOString() }, { onConflict: "connection_id" });

      // Map by VIN, then by label, else create. Never duplicates an existing roster entry.
      const { data: roster } = await admin.from("vehicles").select("id, label, vin, telematics_external_id").eq("user_id", ownerId);
      const byVin = new Map((roster ?? []).filter((v) => v.vin).map((v) => [String(v.vin).toUpperCase(), v]));
      const byLabel = new Map((roster ?? []).map((v) => [String(v.label).trim().toLowerCase(), v]));
      let linked = 0, created = 0;
      for (const sv of fleet) {
        const match = (sv.vin && byVin.get(sv.vin.toUpperCase())) || byLabel.get(sv.name.trim().toLowerCase());
        if (match) {
          await admin.from("vehicles").update({ telematics_connection_id: conn.id, telematics_external_id: sv.id, vin: sv.vin ?? undefined }).eq("id", match.id);
          linked++;
        } else {
          const { error: insErr } = await admin.from("vehicles").insert({ user_id: ownerId, label: sv.name, vin: sv.vin, telematics_connection_id: conn.id, telematics_external_id: sv.id });
          if (!insErr) created++;
        }
      }
      return jsonResponse({ ok: true, connection_id: conn.id, vehicles_found: fleet.length, linked, created, ingest_url: ingestUrl, ingest_token: ingestToken });
    }

    if (action === "create_webhook") {
      const token = randomToken(32);
      const label = String(body?.label ?? "Webhook").slice(0, 60) || "Webhook";
      const { data: existing } = await admin.from("telematics_connections").select("id").eq("user_id", ownerId).eq("provider", "webhook").maybeSingle();
      const { data, error } = existing
        ? await admin.from("telematics_connections").update({ ingest_token_hash: await sha256Hex(token), status: "connected", label }).eq("id", existing.id).select("id").single()
        : await admin.from("telematics_connections").insert({ user_id: ownerId, provider: "webhook", label, status: "connected", ingest_token_hash: await sha256Hex(token) }).select("id").single();
      if (error) throw error;
      return jsonResponse({ ok: true, connection_id: data.id, ingest_url: ingestUrl, ingest_token: token });
    }

    if (action === "rotate_token") {
      const c = await ownConnection(body?.connection_id);
      if (!c) return jsonResponse({ error: "Connection not found." }, 404);
      const token = randomToken(32);
      await admin.from("telematics_connections").update({ ingest_token_hash: await sha256Hex(token) }).eq("id", c.id);
      return jsonResponse({ ok: true, ingest_url: ingestUrl, ingest_token: token });
    }

    if (action === "set_webhook_secret") {
      const c = await ownConnection(body?.connection_id);
      const secret = String(body?.secret ?? "").trim();
      if (!c || c.provider !== "samsara") return jsonResponse({ error: "Samsara connection not found." }, 404);
      if (secret.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(secret)) return jsonResponse({ error: "Paste the base64 signing secret from Samsara." }, 400);
      const { data: cred } = await admin.from("telematics_credentials").select("encrypted").eq("connection_id", c.id).maybeSingle();
      const cur = cred ? await decryptJson<Record<string, string>>(cred.encrypted) : {};
      await admin.from("telematics_credentials").upsert({ connection_id: c.id, user_id: ownerId, encrypted: await encryptJson({ ...cur, webhook_secret: secret }), updated_at: new Date().toISOString() }, { onConflict: "connection_id" });
      return jsonResponse({ ok: true });
    }

    if (action === "map_vehicle") {
      const c = await ownConnection(body?.connection_id);
      const ext = String(body?.external_id ?? "").trim().slice(0, 120);
      if (!c || !ext || typeof body?.vehicle_id !== "string" || !uuid.test(body.vehicle_id)) return jsonResponse({ error: "Invalid request." }, 400);
      const { error } = await admin.from("vehicles").update({ telematics_connection_id: c.id, telematics_external_id: ext }).eq("id", body.vehicle_id).eq("user_id", ownerId);
      if (error) return jsonResponse({ error: error.code === "23505" ? "That device id is already mapped to another vehicle." : "Could not map vehicle." }, 400);
      return jsonResponse({ ok: true });
    }

    if (action === "save_settings") {
      const c = await ownConnection(body?.connection_id);
      if (!c) return jsonResponse({ error: "Connection not found." }, 404);
      const settings = normalizeSettings(body?.settings);
      await admin.from("telematics_connections").update({ settings }).eq("id", c.id);
      return jsonResponse({ ok: true, settings });
    }

    if (action === "disconnect") {
      const c = await ownConnection(body?.connection_id);
      if (!c) return jsonResponse({ error: "Connection not found." }, 404);
      await admin.from("telematics_credentials").delete().eq("connection_id", c.id);
      await admin.from("telematics_connections").update({ status: "disconnected", ingest_token_hash: null, last_error: null }).eq("id", c.id);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error(JSON.stringify({ event: "telematics_connect_failed", action, error: String(error) }));
    return jsonResponse({ error: "Could not complete the request." }, 500);
  }
});
