// supabase/functions/trust-keys/index.ts
//
// Customer-managed encryption keys (CMEK) for the Enterprise Trust Pack.
//
// Actions (POST JSON, account OWNER only):
//   { action: "setup_info" }                      -> { configured, principalArn, policyStatement }
//   { action: "register", keyArn, label? }        -> { key }      validates with KMS, activates (rotating any active key)
//   { action: "validate", keyId }                 -> { key }      re-checks KMS access; records last_validated_at / last_error
//   { action: "rewrap", fromKeyId, toKeyId }      -> { rewrapped, remaining, failed }   one batch of data-key re-wrapping
//   { action: "revoke", keyId }                   -> { key }      Vireek stops using the key (data stays encrypted)
//
// Secrets (Supabase function secrets):
//   TRUST_AWS_ACCESS_KEY_ID / TRUST_AWS_SECRET_ACCESS_KEY [/ TRUST_AWS_SESSION_TOKEN]
//   TRUST_AWS_PRINCIPAL_ARN   (the IAM principal customers grant in their key policy)
//
// Deploy: supabase functions deploy trust-keys

import { authenticate, audit, corsHeaders, json, readJson } from "../_shared/trust/http.ts";
import { activeKey, kmsProvider, rewrapBatch, VaultError } from "../_shared/trust/vault.ts";
import {
  KmsError, buildKeyPolicyStatement, describeKmsError, parseKmsArn, validateKey,
} from "../../../src/lib/trustPack/kms.ts";
import { isUuid } from "../../../src/lib/trustPack/regions.ts";

const KEY_COLUMNS = "id,provider,key_arn,label,status,last_validated_at,last_error,created_at,activated_at,revoked_at";
const MAX_KEYS_PER_ACCOUNT = 10;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  if (!auth.isOwner) return json({ error: "Only the account owner can manage encryption keys." }, 403);
  const { admin, ownerId } = auth;

  const body = await readJson(req);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const principalArn = Deno.env.get("TRUST_AWS_PRINCIPAL_ARN") ?? "";
  const configured = !!Deno.env.get("TRUST_AWS_ACCESS_KEY_ID") && !!Deno.env.get("TRUST_AWS_SECRET_ACCESS_KEY") && !!principalArn;

  if (body.action === "setup_info") {
    return json({
      configured,
      principalArn: configured ? principalArn : null,
      policyStatement: configured ? buildKeyPolicyStatement(principalArn, ownerId) : null,
    });
  }
  if (!configured) return json({ error: describeKmsError("NOT_CONFIGURED"), code: "NOT_CONFIGURED" }, 503);

  const kms = kmsProvider();

  // ---------------------------------------------------------------- register
  if (body.action === "register") {
    const keyArn = typeof body.keyArn === "string" ? body.keyArn.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : null;
    const parsed = parseKmsArn(keyArn);
    if (!parsed) return json({ error: "Enter a valid AWS KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>)." }, 400);

    const { count } = await admin.from("tenant_encryption_keys").select("id", { count: "exact", head: true }).eq("user_id", ownerId);
    if ((count ?? 0) >= MAX_KEYS_PER_ACCOUNT) return json({ error: "Key limit reached. Revoke an unused key first." }, 400);

    const check = await validateKey(kms, keyArn, ownerId);
    if (!check.ok) {
      await audit(auth, "encryption_key_validation_failed", "tenant_encryption_keys", null, { code: check.code });
      return json({ error: describeKmsError(check.code), code: check.code }, 422);
    }

    const now = new Date().toISOString();
    const previous = await activeKey(admin, ownerId);

    // Insert as pending first so a half-finished rotation never leaves two active keys.
    const { data: inserted, error: insErr } = await admin.from("tenant_encryption_keys")
      .insert({ user_id: ownerId, key_arn: keyArn, label, status: "pending", created_by: auth.userId, last_validated_at: now })
      .select(KEY_COLUMNS).single();
    if (insErr || !inserted) {
      return json({ error: insErr?.code === "23505" ? "This key is already registered." : "Could not save the key." }, insErr?.code === "23505" ? 409 : 500);
    }

    if (previous) {
      const { error } = await admin.from("tenant_encryption_keys").update({ status: "retired" }).eq("id", previous.id);
      if (error) return json({ error: "Could not rotate keys." }, 500);
    }
    const { data: active, error: actErr } = await admin.from("tenant_encryption_keys")
      .update({ status: "active", activated_at: now, last_error: null }).eq("id", inserted.id).select(KEY_COLUMNS).single();
    if (actErr || !active) {
      if (previous) await admin.from("tenant_encryption_keys").update({ status: "active" }).eq("id", previous.id); // roll back
      return json({ error: "Could not activate the key." }, 500);
    }
    await audit(auth, previous ? "rotated_encryption_key" : "registered_encryption_key", "tenant_encryption_keys", active.id, { region: parsed.region });
    return json({ key: active, rotatedFrom: previous?.id ?? null });
  }

  // ---------------------------------------------------------------- validate / revoke / rewrap
  const keyId = typeof body.keyId === "string" ? body.keyId : "";

  if (body.action === "validate") {
    if (!isUuid(keyId)) return json({ error: "Invalid key id" }, 400);
    const { data: key } = await admin.from("tenant_encryption_keys").select("id,key_arn,status").eq("id", keyId).eq("user_id", ownerId).maybeSingle();
    if (!key) return json({ error: "Key not found" }, 404);
    if (key.status === "revoked") return json({ error: "This key was revoked." }, 409);
    const check = await validateKey(kms, key.key_arn, ownerId);
    const { data: updated } = await admin.from("tenant_encryption_keys")
      .update({ last_validated_at: new Date().toISOString(), last_error: check.ok ? null : check.code })
      .eq("id", keyId).select(KEY_COLUMNS).single();
    return json({ key: updated, ok: check.ok, ...(check.ok ? {} : { error: describeKmsError(check.code), code: check.code }) });
  }

  if (body.action === "revoke") {
    if (!isUuid(keyId)) return json({ error: "Invalid key id" }, 400);
    const { data: key } = await admin.from("tenant_encryption_keys").select("id,status").eq("id", keyId).eq("user_id", ownerId).maybeSingle();
    if (!key) return json({ error: "Key not found" }, 404);
    const { data: revoked, error } = await admin.from("tenant_encryption_keys")
      .update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", keyId).select(KEY_COLUMNS).single();
    if (error) return json({ error: "Could not revoke the key." }, 500);
    await audit(auth, "revoked_encryption_key", "tenant_encryption_keys", keyId, { wasActive: key.status === "active" });
    return json({ key: revoked });
  }

  if (body.action === "rewrap") {
    const toKeyId = typeof body.toKeyId === "string" ? body.toKeyId : "";
    const fromKeyId = typeof body.fromKeyId === "string" ? body.fromKeyId : "";
    if (!isUuid(fromKeyId) || !isUuid(toKeyId) || fromKeyId === toKeyId) return json({ error: "Invalid key ids" }, 400);
    try {
      const r = await rewrapBatch(admin, ownerId, fromKeyId, toKeyId, 100, kms);
      if (r.rewrapped > 0) await audit(auth, "rewrapped_encryption_keys", "tenant_encryption_keys", toKeyId, { rewrapped: r.rewrapped, remaining: r.remaining });
      return json(r);
    } catch (e) {
      if (e instanceof VaultError || e instanceof KmsError) return json({ error: e.message }, 422);
      throw e;
    }
  }

  return json({ error: "Unknown action" }, 400);
});
