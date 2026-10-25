// supabase/functions/data-platform-admin/index.ts
//
// Configuration for the Data Platform. The browser never sees credentials and never writes the
// tables; every change goes through here, re-checks permission and validates every input.
//
//   save_destination   { id?, role, kind, name, config, credentials?, settings, auto_sync, interval_minutes }
//   test_destination   { id }
//   delete_destination { id }
//   create_embed       { name, config, rate_limit_per_minute? }  -> { embed, signing_secret }  (secret shown ONCE)
//   update_embed       { id, name?, config?, rate_limit_per_minute? }
//   rotate_embed_secret{ id }                                     -> { signing_secret }       (old tokens stop working)
//   revoke_embed       { id }
//
// Permission: owner, or a team member with can_export_data (can_manage_data_platform()).
// Required secret: DATA_PLATFORM_ENCRYPTION_KEY (openssl rand -base64 32).
// Deploy: supabase functions deploy data-platform-admin

import { adminClient, aad, authenticate, corsHeaders, encryptionKey, json, type Admin } from "../_shared/data-platform/http.ts";
import { randomSecret, sealSecret, openSecret } from "../_shared/data-platform/secrets.ts";
import { isDatasetKey, DEFAULT_DATASETS } from "../_shared/data-platform/catalog.ts";
import {
  validateWarehouseConfig, validateWarehouseCredentials, WAREHOUSE_KINDS, type WarehouseConfig, type WarehouseCredentials,
} from "../_shared/data-platform/warehouse.ts";
import { openAdapter } from "../_shared/data-platform/adapters/index.ts";
import { fetchAccessToken, parseServiceAccountJson, SCOPE_SHEETS } from "../_shared/data-platform/googleAuth.ts";
import { MODELS, REVERSE_KINDS, isModelKey, mailchimpDc, modelParam, validateReverseConfig, type ReverseDestinationKind } from "../_shared/data-platform/reverseEtl.ts";
import { sanitizeEmbedConfig } from "../_shared/data-platform/embed.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DESTINATIONS = 10;
const MAX_EMBEDS = 20;
const INTERVALS = [15, 60, 360, 1440];
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const uuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const cleanName = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

type Obj = Record<string, unknown>;

async function putSecret(admin: Admin, kind: "destination" | "embed", id: string, owner: string, plain: string) {
  const secret_enc = await sealSecret(plain, encryptionKey(), aad(kind, id));
  const { error } = await admin.from("dp_secrets").upsert({ ref_id: id, user_id: owner, kind, secret_enc, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

function validateReverseCredentials(kind: ReverseDestinationKind, raw: Obj): { ok: true; secret: string } | { ok: false; errors: Obj } {
  if (kind === "sheets") {
    const p = parseServiceAccountJson(typeof raw.service_account_json === "string" ? raw.service_account_json : "");
    return p.ok ? { ok: true, secret: JSON.stringify({ type: "service_account", client_email: p.key.client_email, private_key: p.key.private_key }) } : { ok: false, errors: { service_account_json: p.error } };
  }
  const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
  if (kind === "mailchimp") return mailchimpDc(key) ? { ok: true, secret: key } : { ok: false, errors: { api_key: "Paste a Mailchimp API key (looks like 0123…cdef-us21)." } };
  return /^pk_[A-Za-z0-9]{20,}$/.test(key) ? { ok: true, secret: key } : { ok: false, errors: { api_key: "Paste a Klaviyo private API key (starts with pk_)." } };
}

function cleanSettings(role: string, raw: Obj): Obj | string {
  if (role === "warehouse") {
    const ds = (Array.isArray(raw.datasets) ? raw.datasets : []).filter(isDatasetKey);
    return { datasets: ds.length ? [...new Set(ds)] : [...DEFAULT_DATASETS], pii_mode: raw.pii_mode === "full" || raw.pii_mode === "omit" ? raw.pii_mode : "hashed" };
  }
  if (!isModelKey(raw.model)) return "Choose what to send.";
  return { model: raw.model, ...(MODELS[raw.model].param ? { param: modelParam(raw.model, raw.param) } : {}) };
}

async function saveDestination(admin: Admin, owner: string, userId: string, b: Obj): Promise<Response> {
  const role = b.role === "reverse" ? "reverse" : "warehouse";
  const kind = String(b.kind ?? "");
  const name = cleanName(b.name);
  if (!name) return fail("Give the destination a name.", 400, { errors: { name: "Required." } });
  const id = uuid(b.id);
  const existing = id ? (await admin.from("dp_destinations").select("id,role,kind").eq("id", id).eq("user_id", owner).maybeSingle()).data : null;
  if (id && !existing) return fail("Destination not found.", 404);
  if (existing && (existing.role !== role || existing.kind !== kind)) return fail("The type of a destination can't be changed. Create a new one.");

  let config: Obj;
  let secret: string | null = null;
  const credsIn = (b.credentials ?? {}) as Obj;
  const haveCreds = Object.keys(credsIn).length > 0;
  if (!existing && !haveCreds) return fail("Enter the credentials.", 400, { errors: { credentials: "Required." } });

  if (role === "warehouse") {
    if (!(WAREHOUSE_KINDS as readonly string[]).includes(kind)) return fail("Unknown warehouse type.");
    const c = validateWarehouseConfig(kind as "bigquery", b.config);
    if (!c.ok) return fail("Please fix the highlighted fields.", 400, { errors: c.errors });
    config = c.value as unknown as Obj;
    if (haveCreds) {
      const cr = validateWarehouseCredentials(kind as "bigquery", credsIn);
      if (!cr.ok) return fail("Please fix the highlighted fields.", 400, { errors: cr.errors });
      secret = JSON.stringify(cr.value);
    }
  } else {
    if (!(REVERSE_KINDS as readonly string[]).includes(kind)) return fail("Unknown destination type.");
    const c = validateReverseConfig(kind as ReverseDestinationKind, b.config);
    if (!c.ok) return fail("Please fix the highlighted fields.", 400, { errors: c.errors });
    config = c.value as unknown as Obj;
    if (haveCreds) {
      const cr = validateReverseCredentials(kind as ReverseDestinationKind, credsIn);
      if (!cr.ok) return fail("Please fix the highlighted fields.", 400, { errors: cr.errors });
      secret = cr.secret;
    }
  }
  delete config.kind;

  const settings = cleanSettings(role, (b.settings ?? {}) as Obj);
  if (typeof settings === "string") return fail(settings, 400, { errors: { model: settings } });
  if (role === "reverse") {
    const model = MODELS[(settings as Obj).model as keyof typeof MODELS];
    if (!(model.destinations as readonly string[]).includes(kind)) return fail(`"${model.label}" can't be sent to this destination.`, 400, { errors: { model: "Not available for this destination." } });
  }
  const interval = INTERVALS.includes(Number(b.interval_minutes)) ? Number(b.interval_minutes) : 360;
  const row = { role, kind, name, config, settings, interval_minutes: interval, auto_sync: b.auto_sync !== false };

  if (!existing) {
    const { count } = await admin.from("dp_destinations").select("id", { count: "exact", head: true }).eq("user_id", owner);
    if ((count ?? 0) >= MAX_DESTINATIONS) return fail(`You can connect up to ${MAX_DESTINATIONS} destinations.`);
  }
  const q = existing
    ? admin.from("dp_destinations").update({ ...row, status: "connected", last_error: null, consecutive_failures: 0 }).eq("id", existing.id).eq("user_id", owner)
    : admin.from("dp_destinations").insert({ ...row, user_id: owner, created_by: userId });
  const { data, error } = await q.select("id,role,kind,name,config,settings,status,auto_sync,interval_minutes,next_run_at,last_run_at,last_success_at,last_error,created_at").single();
  if (error) return fail(error.code === "23505" ? "A destination with this name already exists." : "Could not save the destination.", error.code === "23505" ? 409 : 500);
  if (secret) await putSecret(admin, "destination", data.id as string, owner, secret);
  return json({ destination: data });
}

async function testDestination(admin: Admin, owner: string, id: string): Promise<Response> {
  const { data: d } = await admin.from("dp_destinations").select("*").eq("id", id).eq("user_id", owner).maybeSingle();
  if (!d) return fail("Destination not found.", 404);
  const { data: s } = await admin.from("dp_secrets").select("secret_enc").eq("ref_id", id).maybeSingle();
  if (!s) return fail("Credentials are missing. Edit the destination and enter them again.");
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let ok = true;
  let message: string | null = null;
  try {
    const secret = await openSecret(s.secret_enc as string, encryptionKey(), aad("destination", id));
    if (d.role === "warehouse") {
      const cfg = validateWarehouseConfig(d.kind, { ...d.config });
      if (!cfg.ok) throw new Error("Settings are invalid. Edit and save them again.");
      const adapter = await openAdapter(cfg.value as WarehouseConfig, JSON.parse(secret) as WarehouseCredentials);
      try { checks.push(...(await adapter.test())); } finally { await adapter.close().catch(() => {}); }
    } else if (d.kind === "sheets") {
      const p = parseServiceAccountJson(secret);
      if (!p.ok) throw new Error(p.error);
      const token = await fetchAccessToken(p.key, [SCOPE_SHEETS]);
      checks.push({ name: "Service account", ok: true, detail: p.key.client_email });
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${(d.config as Obj).spreadsheet_id}?fields=properties.title`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`The sheet is not shared with ${p.key.client_email} as Editor (${r.status}).`);
      checks.push({ name: "Spreadsheet", ok: true, detail: ((await r.json()) as { properties?: { title?: string } }).properties?.title ?? "Reachable" });
    } else if (d.kind === "mailchimp") {
      const dc = mailchimpDc(secret);
      if (!dc) throw new Error("The Mailchimp API key looks invalid.");
      const r = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${(d.config as Obj).list_id}?fields=name`, { headers: { Authorization: `Basic ${btoa(`vireek:${secret}`)}` } });
      if (!r.ok) throw new Error(r.status === 404 ? "Audience not found for this API key." : `Mailchimp rejected the key (${r.status}).`);
      checks.push({ name: "Audience", ok: true, detail: ((await r.json()) as { name?: string }).name ?? "Reachable" });
    } else {
      const r = await fetch(`https://a.klaviyo.com/api/lists/${(d.config as Obj).list_id}`, { headers: { Authorization: `Klaviyo-API-Key ${secret}`, revision: "2024-10-15", Accept: "application/vnd.api+json" } });
      if (!r.ok) throw new Error(r.status === 404 ? "List not found for this API key." : `Klaviyo rejected the key (${r.status}). It needs lists:read, profiles:write and lists:write.`);
      checks.push({ name: "List", ok: true, detail: "Reachable" });
    }
  } catch (e) {
    ok = false;
    message = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    checks.push({ name: "Test failed", ok: false, detail: message });
  }
  await admin.from("dp_destinations").update({ status: ok ? "connected" : "error", last_error: message }).eq("id", id);
  return json({ ok, checks });
}

async function embedAction(admin: Admin, owner: string, userId: string, action: string, b: Obj): Promise<Response> {
  if (action === "create_embed") {
    const name = cleanName(b.name);
    if (!name) return fail("Give the embed a name.");
    const cfg = sanitizeEmbedConfig(b.config);
    if (!cfg.ok) return fail(cfg.error);
    const { count } = await admin.from("dp_embeds").select("id", { count: "exact", head: true }).eq("user_id", owner).eq("status", "active");
    if ((count ?? 0) >= MAX_EMBEDS) return fail(`You can have up to ${MAX_EMBEDS} active embeds.`);
    const rate = Math.min(600, Math.max(1, Math.floor(Number(b.rate_limit_per_minute) || 60)));
    const { data, error } = await admin.from("dp_embeds").insert({ user_id: owner, name, config: cfg.config, rate_limit_per_minute: rate, created_by: userId }).select("id,name,config,status,rate_limit_per_minute,created_at,last_used_at").single();
    if (error) return fail(error.code === "23505" ? "An embed with this name already exists." : "Could not create the embed.", error.code === "23505" ? 409 : 500);
    const signing_secret = randomSecret();
    await putSecret(admin, "embed", data.id as string, owner, signing_secret);
    return json({ embed: data, signing_secret });
  }
  const id = uuid(b.id);
  if (!id) return fail("Invalid embed.");
  const { data: e } = await admin.from("dp_embeds").select("id,status").eq("id", id).eq("user_id", owner).maybeSingle();
  if (!e) return fail("Embed not found.", 404);
  if (action === "revoke_embed") {
    await admin.from("dp_embeds").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", id);
    await admin.from("dp_secrets").delete().eq("ref_id", id);
    return json({ ok: true });
  }
  if (e.status !== "active") return fail("This embed has been revoked.");
  if (action === "rotate_embed_secret") {
    const signing_secret = randomSecret();
    await putSecret(admin, "embed", id, owner, signing_secret);
    return json({ signing_secret });
  }
  // update_embed
  const patch: Obj = {};
  if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return fail("Give the embed a name."); patch.name = n; }
  if (b.config !== undefined) { const c = sanitizeEmbedConfig(b.config); if (!c.ok) return fail(c.error); patch.config = c.config; }
  if (b.rate_limit_per_minute !== undefined) patch.rate_limit_per_minute = Math.min(600, Math.max(1, Math.floor(Number(b.rate_limit_per_minute) || 60)));
  const { data, error } = await admin.from("dp_embeds").update(patch).eq("id", id).eq("user_id", owner).select("id,name,config,status,rate_limit_per_minute,created_at,last_used_at").single();
  if (error) return fail(error.code === "23505" ? "An embed with this name already exists." : "Could not update the embed.", error.code === "23505" ? 409 : 500);
  return json({ embed: data });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed.", 405);
  try {
    const a = await authenticate(req);
    if (!a.ok) return a.res;
    if (!a.caller.canManage) return fail("You do not have permission to manage the Data Platform.", 403);
    let b: Obj;
    try { b = await req.json(); } catch { return fail("Invalid request body."); }
    const admin = adminClient();
    const owner = a.caller.ownerId;
    const action = String(b.action ?? "");

    switch (action) {
      case "save_destination": return await saveDestination(admin, owner, a.caller.userId, b);
      case "test_destination": { const id = uuid(b.id); return id ? await testDestination(admin, owner, id) : fail("Invalid destination."); }
      case "delete_destination": {
        const id = uuid(b.id);
        if (!id) return fail("Invalid destination.");
        await admin.from("dp_secrets").delete().eq("ref_id", id).eq("user_id", owner);
        await admin.from("dp_destinations").delete().eq("id", id).eq("user_id", owner);
        return json({ ok: true });
      }
      case "create_embed": case "update_embed": case "rotate_embed_secret": case "revoke_embed":
        return await embedAction(admin, owner, a.caller.userId, action, b);
      default: return fail("Unknown action.");
    }
  } catch (err) {
    console.error("[data-platform-admin]", err instanceof Error ? err.message : err);
    const msg = err instanceof Error && err.message.includes("DATA_PLATFORM_ENCRYPTION_KEY") ? "The server is missing its encryption key. See docs/DATA_PLATFORM.md." : "Something went wrong. Please try again.";
    return fail(msg, 500);
  }
});
