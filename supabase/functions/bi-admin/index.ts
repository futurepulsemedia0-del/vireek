// supabase/functions/bi-admin/index.ts
//
// Configuration for BI Connectors. The browser never sees credentials or token hashes and never writes
// the tables; every change goes through here, re-checks permission and validates every input.
//
//   create_token       { name, datasets, pii_mode, rate_limit_per_minute?, expires_in_days? } -> { token, secret }  (secret shown ONCE)
//   revoke_token       { id }
//   save_export_target { id?, kind, name, config, credentials?, settings, auto_sync, interval_minutes }
//   test_export_target { id }
//   delete_export_target { id }
//   probe_sftp_host    { host, port }  -> { fingerprint }   (to pin the host key)
//
// Permission: owner, or a team member with can_export_data (can_manage_data_platform()).
// Required secrets: DATA_PLATFORM_ENCRYPTION_KEY, CRON_SECRET (internal calls to bi-sftp-upload).
// Deploy: supabase functions deploy bi-admin

import { adminClient, authenticate, corsHeaders, encryptionKey, json, type Admin } from "../_shared/data-platform/http.ts";
import { openSecret, sealSecret } from "../_shared/data-platform/secrets.ts";
import { MAX_ACTIVE_TOKENS, generateToken, hashToken, tokenHint, validateTokenInput } from "../_shared/bi/access.ts";
import { EXPORT_INTERVALS, normalizeSettings, validateSftpConfig, validateSftpCredentials, type ExportKind } from "../_shared/bi/export.ts";
import { validateS3Config, validateS3Credentials, type S3Config, type S3Credentials } from "../_shared/bi/s3.ts";
import { createS3Transport } from "../_shared/bi/s3Transport.ts";
import { createSftpTransport } from "../_shared/bi/sftpTransport.ts";
import { isPublicHost } from "../_shared/data-platform/warehouse.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TARGETS = 10;
type Obj = Record<string, unknown>;
const fail = (error: string, status = 400, extra: Obj = {}) => json({ error, ...extra }, status);
const uuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const aad = (id: string) => `bi_target:${id}`;

const TOKEN_COLS = "id,name,token_hint,datasets,pii_mode,rate_limit_per_minute,expires_at,status,last_used_at,created_at,revoked_at";

async function createToken(admin: Admin, owner: string, userId: string, b: Obj): Promise<Response> {
  const v = validateTokenInput(b, { isOwner: userId === owner });
  if (!v.ok) return fail("Check the highlighted fields.", 400, { errors: v.errors });
  const { count } = await admin.from("bi_access_tokens").select("id", { count: "exact", head: true }).eq("user_id", owner).eq("status", "active");
  if ((count ?? 0) >= MAX_ACTIVE_TOKENS) return fail(`You can have up to ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`, 409);
  const secret = generateToken();
  const expires_at = v.value.expires_in_days === null ? null : new Date(Date.now() + v.value.expires_in_days * 86_400_000).toISOString();
  const { data, error } = await admin.from("bi_access_tokens").insert({
    user_id: owner, name: v.value.name, token_hash: await hashToken(secret), token_hint: tokenHint(secret), datasets: v.value.datasets,
    pii_mode: v.value.pii_mode, rate_limit_per_minute: v.value.rate_limit_per_minute, expires_at, created_by: userId,
  }).select(TOKEN_COLS).single();
  if (error) return error.code === "23505" ? fail("A token with this name already exists.", 409, { errors: { name: "Already in use." } }) : fail("Could not create the token.", 500);
  return json({ token: data, secret });
}

async function loadTarget(admin: Admin, owner: string, id: string) {
  const { data } = await admin.from("bi_export_targets").select("*").eq("id", id).eq("user_id", owner).maybeSingle();
  return data as (Obj & { id: string; kind: ExportKind; config: Obj }) | null;
}

async function buildTransport(admin: Admin, target: Obj & { id: string; kind: ExportKind; config: Obj }, owner: string) {
  const { data } = await admin.from("bi_secrets").select("secret_enc").eq("ref_id", target.id).eq("user_id", owner).maybeSingle();
  if (!data?.secret_enc) throw new Error("Stored credentials are missing. Edit the target and enter them again.");
  const creds = JSON.parse(await openSecret(data.secret_enc as string, encryptionKey(), aad(target.id)));
  if (target.kind === "s3") {
    const cfg = validateS3Config(target.config);
    if (!cfg.ok) throw new Error("Target settings are invalid. Edit and save them again.");
    return createS3Transport(cfg.value, creds as S3Credentials);
  }
  return createSftpTransport({ baseUrl: Deno.env.get("SUPABASE_URL") ?? "", cronSecret: Deno.env.get("CRON_SECRET") ?? "", targetId: target.id });
}

async function saveTarget(admin: Admin, owner: string, userId: string, b: Obj): Promise<Response> {
  const kind = b.kind === "sftp" ? "sftp" : b.kind === "s3" ? "s3" : null;
  if (!kind) return fail("Choose S3 or SFTP.");
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (!name) return fail("Give the target a name.", 400, { errors: { name: "Required." } });
  const id = uuid(b.id);
  const existing = id ? await loadTarget(admin, owner, id) : null;
  if (id && !existing) return fail("Target not found.", 404);
  if (existing && existing.kind !== kind) return fail("The type of a target can't be changed. Create a new one.");
  const interval = Number(b.interval_minutes);
  if (!(EXPORT_INTERVALS as readonly number[]).includes(interval)) return fail("Choose how often to export.", 400, { errors: { interval_minutes: "Pick one of the options." } });
  if (!existing) {
    const { count } = await admin.from("bi_export_targets").select("id", { count: "exact", head: true }).eq("user_id", owner);
    if ((count ?? 0) >= MAX_TARGETS) return fail(`You can have up to ${MAX_TARGETS} export targets.`, 409);
  }

  const cfg = kind === "s3" ? validateS3Config(b.config) : validateSftpConfig(b.config);
  if (!cfg.ok) return fail("Check the highlighted fields.", 400, { errors: cfg.errors });
  const credsIn = (b.credentials ?? {}) as Obj;
  let secret: string | null = null;
  if (Object.keys(credsIn).length || !existing) {
    const c = kind === "s3" ? validateS3Credentials(credsIn) : validateSftpCredentials(credsIn);
    if (!c.ok) return fail("Check the highlighted fields.", 400, { errors: c.errors });
    secret = JSON.stringify(c.value);
  }
  const settings = normalizeSettings((b.settings ?? {}) as Obj);
  const row = { user_id: owner, kind, name, config: cfg.value, settings, auto_sync: b.auto_sync !== false, interval_minutes: interval, created_by: userId };
  const query = existing
    ? admin.from("bi_export_targets").update({ name, config: cfg.value, settings, auto_sync: row.auto_sync, interval_minutes: interval, status: "connected", last_error: null, consecutive_failures: 0, next_run_at: new Date().toISOString() }).eq("id", existing.id).eq("user_id", owner)
    : admin.from("bi_export_targets").insert(row);
  const { data, error } = await query.select("*").single();
  if (error) return error.code === "23505" ? fail("A target with this name already exists.", 409, { errors: { name: "Already in use." } }) : fail("Could not save the target.", 500);
  if (secret) {
    const secret_enc = await sealSecret(secret, encryptionKey(), aad(data.id as string));
    const { error: se } = await admin.from("bi_secrets").upsert({ ref_id: data.id, user_id: owner, secret_enc, updated_at: new Date().toISOString() });
    if (se) {
      if (!existing) await admin.from("bi_export_targets").delete().eq("id", data.id).eq("user_id", owner);
      return fail("Could not store the credentials securely.", 500);
    }
  }
  return json({ target: data });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed.", 405);
  let body: Obj = {};
  try { body = await req.json(); } catch { return fail("Invalid request."); }

  try {
    const a = await authenticate(req);
    if (!a.ok) return a.res;
    const { caller } = a;
    if (!caller.canManage) return fail("You do not have permission to manage BI connectors.", 403);
    const admin = adminClient();

    switch (body.action) {
      case "create_token":
        return await createToken(admin, caller.ownerId, caller.userId, body);
      case "revoke_token": {
        const id = uuid(body.id);
        if (!id) return fail("Invalid token.");
        const { data } = await admin.from("bi_access_tokens").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", id).eq("user_id", caller.ownerId).select("id").maybeSingle();
        return data ? json({ ok: true }) : fail("Token not found.", 404);
      }
      case "save_export_target":
        return await saveTarget(admin, caller.ownerId, caller.userId, body);
      case "delete_export_target": {
        const id = uuid(body.id);
        if (!id) return fail("Invalid target.");
        const { data } = await admin.from("bi_export_targets").delete().eq("id", id).eq("user_id", caller.ownerId).select("id").maybeSingle();
        return data ? json({ ok: true }) : fail("Target not found.", 404);
      }
      case "test_export_target": {
        const id = uuid(body.id);
        const target = id ? await loadTarget(admin, caller.ownerId, id) : null;
        if (!target) return fail("Target not found.", 404);
        try {
          const checks = await (await buildTransport(admin, target, caller.ownerId)).test();
          return json({ ok: checks.every((c) => c.ok), checks });
        } catch (e) {
          return json({ ok: false, checks: [{ name: "Connection", ok: false, detail: e instanceof Error ? e.message : "Could not connect." }] });
        }
      }
      case "probe_sftp_host": {
        const host = typeof body.host === "string" ? body.host.trim().toLowerCase() : "";
        const port = body.port === undefined || body.port === "" ? 22 : Number(body.port);
        if (!isPublicHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return fail("Enter a valid public host and port.");
        const res = await fetch(`${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/bi-sftp-upload`, {
          method: "POST",
          headers: { "X-Cron-Secret": Deno.env.get("CRON_SECRET") ?? "", "X-Action": "probe", "Content-Type": "application/json" },
          body: JSON.stringify({ host, port }),
          signal: AbortSignal.timeout(30_000),
        });
        const payload = (await res.json().catch(() => ({}))) as { fingerprint?: string; error?: string };
        return res.ok && payload.fingerprint ? json({ fingerprint: payload.fingerprint }) : fail(payload.error ?? "Could not read the server's host key.", 502);
      }
      default:
        return fail("Unknown action.");
    }
  } catch (err) {
    console.error("[bi-admin]", err instanceof Error ? err.message : err);
    return fail("Something went wrong. Please try again.", 500);
  }
});
