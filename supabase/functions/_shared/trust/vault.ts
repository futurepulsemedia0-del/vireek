// supabase/functions/_shared/trust/vault.ts
//
// Enterprise Trust Pack — sealing (customer-managed-key encryption), region-routed storage,
// purge, re-wrap and region migration. Imported by:
//   trust-vault / trust-keys edge functions, vapi-webhook (sealCallArtifacts),
//   delete-account (purgeTenant).
//
// Pure logic lives in src/lib/trustPack/* (tested); this file is the I/O glue.
//
// Invariants:
//   * Plaintext never touches a plane: only AES-GCM ciphertext + a KMS-wrapped data key.
//   * The plane is chosen from the tenant's residency row and FAILS CLOSED.
//   * Every sealed item has a content-free row in `sealed_inventory` (control plane) so purge,
//     rewrap and region migration can find it wherever it lives.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  decryptBytes, decryptString, encryptBytes, encryptString, isSealableField, objectAad, sealAad,
  sealedMarker, wipe,
} from "../../../../src/lib/trustPack/envelope.ts";
import {
  AwsKmsProvider, KmsError, awsCredentialsFromEnv, tenantContext, type KmsProvider,
} from "../../../../src/lib/trustPack/kms.ts";
import {
  MAX_RECORDING_BYTES, RegionNotProvisionedError, bucketFor, isRegionCode, isSafeRecordingUrl, isUuid,
  objectPathFor, resolveDataPlane, type DataPlane, type RegionCode,
} from "../../../../src/lib/trustPack/regions.ts";

export const env = (k: string): string | undefined => Deno.env.get(k);

export type Isolation = "shared" | "dedicated";

export class VaultError extends Error {
  constructor(
    public readonly code:
      | "NO_KEY" | "KEY_UNAVAILABLE" | "NOT_FOUND" | "FORBIDDEN" | "NOT_SEALABLE" | "TOO_LARGE"
      | "FETCH_FAILED" | "PLANE_UNAVAILABLE" | "INTEGRITY" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export const SEALED_UNAVAILABLE = "sealed://unavailable";

// ---------------------------------------------------------------------------
// Clients / lookups
// ---------------------------------------------------------------------------

export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL") ?? "", env("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
}

function planClient(plane: DataPlane, admin: SupabaseClient): SupabaseClient {
  // The primary project is already open as `admin`.
  if (plane.isolation === "shared" && plane.url === (env("SUPABASE_URL") ?? "").replace(/\/+$/, "")) return admin;
  return createClient(plane.url, plane.serviceKey, { auth: { persistSession: false } });
}

export interface Target { region: RegionCode; isolation: Isolation }

interface DedicatedRow { status: string; region: string; endpoint_url: string | null; secret_ref: string | null }

async function loadDedicated(admin: SupabaseClient, ownerId: string): Promise<DedicatedRow | null> {
  const { data } = await admin.from("dedicated_tenants").select("status,region,endpoint_url,secret_ref").eq("user_id", ownerId).maybeSingle();
  return (data as DedicatedRow | null) ?? null;
}

/** Where NEW data for this tenant must go right now. */
export async function currentTarget(admin: SupabaseClient, ownerId: string): Promise<Target> {
  const { data } = await admin.from("tenant_residency").select("region").eq("user_id", ownerId).maybeSingle();
  const region = isRegionCode(data?.region) ? data.region : "us";
  const dedicated = await loadDedicated(admin, ownerId);
  return { region, isolation: dedicated?.status === "active" && dedicated.region === region ? "dedicated" : "shared" };
}

export async function openPlane(admin: SupabaseClient, ownerId: string, t: Target): Promise<{ plane: DataPlane; db: SupabaseClient }> {
  try {
    const dedicated = t.isolation === "dedicated" ? await loadDedicated(admin, ownerId) : null;
    if (t.isolation === "dedicated" && dedicated?.status !== "active") {
      throw new RegionNotProvisionedError(t.region, "dedicated tenant is not active");
    }
    const plane = resolveDataPlane(t.region, dedicated, env);
    return { plane, db: planClient(plane, admin) };
  } catch (e) {
    if (e instanceof RegionNotProvisionedError) throw new VaultError("PLANE_UNAVAILABLE", e.message);
    throw e;
  }
}

export function kmsProvider(): KmsProvider {
  const creds = awsCredentialsFromEnv(env);
  if (!creds) throw new KmsError("NOT_CONFIGURED", "Customer-managed keys are not configured on this deployment");
  return new AwsKmsProvider(creds);
}

export interface KeyRow { id: string; user_id: string; key_arn: string; status: string }

export async function activeKey(admin: SupabaseClient, ownerId: string): Promise<KeyRow | null> {
  const { data } = await admin.from("tenant_encryption_keys").select("id,user_id,key_arn,status").eq("user_id", ownerId).eq("status", "active").maybeSingle();
  return (data as KeyRow | null) ?? null;
}

/** Keys that may still decrypt: active or retired (rotation window). Revoked keys never do. */
async function usableKey(admin: SupabaseClient, ownerId: string, keyId: string): Promise<KeyRow> {
  const { data } = await admin.from("tenant_encryption_keys").select("id,user_id,key_arn,status").eq("id", keyId).eq("user_id", ownerId).maybeSingle();
  const k = data as KeyRow | null;
  if (!k || (k.status !== "active" && k.status !== "retired")) {
    throw new VaultError("KEY_UNAVAILABLE", "The encryption key for this item is not available.");
  }
  return k;
}

function wrapKms<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof KmsError) throw new VaultError("KEY_UNAVAILABLE", `Encryption key unavailable (${e.code}).`);
    throw e;
  });
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface SealPolicy { recordings: boolean; transcripts: boolean }

export async function getSealPolicy(admin: SupabaseClient, ownerId: string): Promise<SealPolicy> {
  const { data } = await admin.from("tenant_encryption_policy").select("seal_recordings,seal_transcripts").eq("user_id", ownerId).maybeSingle();
  return { recordings: !!data?.seal_recordings, transcripts: !!data?.seal_transcripts };
}

// ---------------------------------------------------------------------------
// Sealed fields
// ---------------------------------------------------------------------------

async function recordInventory(admin: SupabaseClient, row: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from("sealed_inventory").upsert(row, { onConflict: "id" });
  if (error) throw new VaultError("INTEGRITY", `Could not record sealed item: ${error.message}`);
}

export async function sealField(
  admin: SupabaseClient,
  a: { ownerId: string; table: string; rowId: string; column: string; value: string },
  kms: KmsProvider = kmsProvider(),
): Promise<string> {
  if (!isSealableField(a.table, a.column)) throw new VaultError("NOT_SEALABLE", "This field cannot be sealed.");
  if (!isUuid(a.ownerId) || !isUuid(a.rowId)) throw new VaultError("BAD_REQUEST", "Invalid identifiers.");
  const key = await activeKey(admin, a.ownerId);
  if (!key) throw new VaultError("NO_KEY", "No active encryption key.");
  const target = await currentTarget(admin, a.ownerId);
  const { db } = await openPlane(admin, a.ownerId, target);

  const dk = await wrapKms(() => kms.generateDataKey(key.key_arn, tenantContext(a.ownerId)));
  try {
    const aad = sealAad({ userId: a.ownerId, table: a.table, rowId: a.rowId, column: a.column });
    const { iv, ciphertext } = await encryptString(a.value, dk.plaintext, aad);

    // Re-sealing the same cell (webhook retry) reuses its id.
    const { data: existing } = await db.from("sealed_values").select("id").eq("user_id", a.ownerId)
      .eq("table_name", a.table).eq("row_id", a.rowId).eq("column_name", a.column).maybeSingle();
    const id: string = existing?.id ?? crypto.randomUUID();

    const { error } = await db.from("sealed_values").upsert({
      id, user_id: a.ownerId, key_id: key.id, table_name: a.table, row_id: a.rowId, column_name: a.column,
      ciphertext, iv, wrapped_dek: dk.wrapped,
    }, { onConflict: "id" });
    if (error) throw new VaultError("PLANE_UNAVAILABLE", `Could not store sealed value: ${error.message}`);

    try {
      await recordInventory(admin, {
        id, user_id: a.ownerId, kind: "field", source_table: a.table, source_row_id: a.rowId, source_column: a.column,
        region: target.region, isolation: target.isolation, key_id: key.id, purge_requested_at: null,
      });
    } catch (e) {
      await db.from("sealed_values").delete().eq("id", id); // never leave an unindexed ciphertext behind
      throw e;
    }
    return sealedMarker(id);
  } finally {
    wipe(dk.plaintext);
  }
}

interface InventoryRow {
  id: string; user_id: string; kind: "field" | "recording"; source_table: string; source_row_id: string;
  source_column: string | null; region: RegionCode; isolation: Isolation; key_id: string; purge_requested_at: string | null;
}

async function inventoryItem(admin: SupabaseClient, ownerId: string, id: string, kind: InventoryRow["kind"]): Promise<InventoryRow> {
  if (!isUuid(id)) throw new VaultError("BAD_REQUEST", "Invalid item id.");
  const { data } = await admin.from("sealed_inventory").select("*").eq("id", id).eq("user_id", ownerId).eq("kind", kind).maybeSingle();
  const row = data as InventoryRow | null;
  if (!row || row.purge_requested_at) throw new VaultError("NOT_FOUND", "Item not found.");
  return row;
}

export async function openField(admin: SupabaseClient, ownerId: string, sealedId: string, kms: KmsProvider = kmsProvider()): Promise<{ value: string; source: InventoryRow }> {
  const inv = await inventoryItem(admin, ownerId, sealedId, "field");
  const { db } = await openPlane(admin, ownerId, { region: inv.region, isolation: inv.isolation });
  const { data } = await db.from("sealed_values").select("*").eq("id", inv.id).eq("user_id", ownerId).maybeSingle();
  if (!data) throw new VaultError("NOT_FOUND", "Item not found.");
  const key = await usableKey(admin, ownerId, data.key_id);
  const dek = await wrapKms(() => kms.unwrap(key.key_arn, data.wrapped_dek, tenantContext(ownerId)));
  try {
    const aad = sealAad({ userId: ownerId, table: data.table_name, rowId: data.row_id, column: data.column_name });
    return { value: await decryptString(data.ciphertext, dek, data.iv, aad), source: inv };
  } catch (e) {
    if (e instanceof Error && e.name === "EnvelopeError") throw new VaultError("INTEGRITY", "Stored value failed its integrity check.");
    throw e;
  } finally {
    wipe(dek);
  }
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

async function fetchRecording(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const suffixes = (env("TRUST_RECORDING_HOSTS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!isSafeRecordingUrl(url, suffixes)) throw new VaultError("FETCH_FAILED", "Recording URL is not allowed.");
  let res: Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new VaultError("FETCH_FAILED", "Could not download the recording.");
  }
  if (!res.ok || !res.body) throw new VaultError("FETCH_FAILED", `Recording download failed (${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_RECORDING_BYTES) throw new VaultError("TOO_LARGE", "Recording is too large to archive.");

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RECORDING_BYTES) { await reader.cancel(); throw new VaultError("TOO_LARGE", "Recording is too large to archive."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  const ct = (res.headers.get("content-type") ?? "audio/wav").split(";")[0].trim().toLowerCase();
  return { bytes, contentType: /^(audio|video)\/[a-z0-9.+-]+$/.test(ct) ? ct : "audio/wav" };
}

export async function archiveRecording(
  admin: SupabaseClient,
  a: { ownerId: string; callId: string; sourceUrl: string },
  kms: KmsProvider = kmsProvider(),
): Promise<string> {
  if (!isUuid(a.ownerId) || !isUuid(a.callId)) throw new VaultError("BAD_REQUEST", "Invalid identifiers.");
  const key = await activeKey(admin, a.ownerId);
  if (!key) throw new VaultError("NO_KEY", "No active encryption key.");
  const target = await currentTarget(admin, a.ownerId);
  const { plane, db } = await openPlane(admin, a.ownerId, target);

  const { bytes, contentType } = await fetchRecording(a.sourceUrl);
  const dk = await wrapKms(() => kms.generateDataKey(key.key_arn, tenantContext(a.ownerId)));
  const bucket = bucketFor("recordings", plane.region);
  const path = objectPathFor(a.ownerId, a.callId);
  try {
    const { iv, ciphertext } = await encryptBytes(bytes, dk.plaintext, objectAad(a.ownerId, a.callId));
    const up = await db.storage.from(bucket).upload(path, ciphertext, { contentType: "application/octet-stream", upsert: true });
    if (up.error) throw new VaultError("PLANE_UNAVAILABLE", `Could not store recording: ${up.error.message}`);

    const { data: existing } = await db.from("sealed_objects").select("id").eq("user_id", a.ownerId).eq("kind", "call_recording").eq("source_row_id", a.callId).maybeSingle();
    const id: string = existing?.id ?? crypto.randomUUID();
    const { error } = await db.from("sealed_objects").upsert({
      id, user_id: a.ownerId, key_id: key.id, kind: "call_recording", source_row_id: a.callId, bucket, object_path: path,
      iv: btoa(String.fromCharCode(...iv)), wrapped_dek: dk.wrapped, size_bytes: ciphertext.byteLength, content_type: contentType,
    }, { onConflict: "id" });
    if (error) {
      await db.storage.from(bucket).remove([path]);
      throw new VaultError("PLANE_UNAVAILABLE", `Could not index recording: ${error.message}`);
    }
    try {
      await recordInventory(admin, {
        id, user_id: a.ownerId, kind: "recording", source_table: "calls", source_row_id: a.callId, source_column: null,
        region: target.region, isolation: target.isolation, key_id: key.id, purge_requested_at: null,
      });
    } catch (e) {
      await db.from("sealed_objects").delete().eq("id", id);
      await db.storage.from(bucket).remove([path]);
      throw e;
    }
    return sealedMarker(id);
  } finally {
    wipe(dk.plaintext, bytes);
  }
}

export async function openRecording(
  admin: SupabaseClient, ownerId: string, sealedId: string, kms: KmsProvider = kmsProvider(),
): Promise<{ bytes: Uint8Array; contentType: string; source: InventoryRow }> {
  const inv = await inventoryItem(admin, ownerId, sealedId, "recording");
  const { db } = await openPlane(admin, ownerId, { region: inv.region, isolation: inv.isolation });
  const { data } = await db.from("sealed_objects").select("*").eq("id", inv.id).eq("user_id", ownerId).maybeSingle();
  if (!data) throw new VaultError("NOT_FOUND", "Recording not found.");
  const key = await usableKey(admin, ownerId, data.key_id);
  const dl = await db.storage.from(data.bucket).download(data.object_path);
  if (dl.error || !dl.data) throw new VaultError("NOT_FOUND", "Recording file is missing.");
  const ciphertext = new Uint8Array(await dl.data.arrayBuffer());
  const dek = await wrapKms(() => kms.unwrap(key.key_arn, data.wrapped_dek, tenantContext(ownerId)));
  try {
    const iv = Uint8Array.from(atob(data.iv), (c) => c.charCodeAt(0));
    const bytes = await decryptBytes(ciphertext, dek, iv, objectAad(ownerId, data.source_row_id));
    return { bytes, contentType: data.content_type, source: inv };
  } catch (e) {
    if (e instanceof Error && e.name === "EnvelopeError") throw new VaultError("INTEGRITY", "Stored recording failed its integrity check.");
    throw e;
  } finally {
    wipe(dek);
  }
}

// ---------------------------------------------------------------------------
// Webhook integration
// ---------------------------------------------------------------------------

export interface SealedCallPatch {
  transcript: string | null;
  recording_url: string | null;
  /** Human-readable problems — surface in the audit log / notifications. */
  problems: string[];
}

/**
 * Call right before persisting an ended call. Returns the values to store in `calls`.
 * - Tenants without a policy get their values back untouched (zero behaviour change).
 * - Transcripts fail CLOSED: if sealing is required but impossible, plaintext is NOT stored.
 * - Recordings fail OPEN to the existing link so nothing is lost and archiving can be retried;
 *   the problem is reported either way.
 */
export async function sealCallArtifacts(
  admin: SupabaseClient,
  a: { ownerId: string; callId: string; transcript: string | null; recordingUrl: string | null },
): Promise<SealedCallPatch> {
  const out: SealedCallPatch = { transcript: a.transcript, recording_url: a.recordingUrl, problems: [] };
  let policy: SealPolicy;
  try {
    policy = await getSealPolicy(admin, a.ownerId);
  } catch {
    return out;
  }
  if (!policy.transcripts && !policy.recordings) return out;

  if (policy.transcripts && a.transcript) {
    try {
      out.transcript = await sealField(admin, { ownerId: a.ownerId, table: "calls", rowId: a.callId, column: "transcript", value: a.transcript });
    } catch (e) {
      out.transcript = SEALED_UNAVAILABLE;
      out.problems.push(`transcript not stored: ${e instanceof VaultError ? e.code : "ERROR"}`);
    }
  }
  if (policy.recordings && a.recordingUrl) {
    try {
      out.recording_url = await archiveRecording(admin, { ownerId: a.ownerId, callId: a.callId, sourceUrl: a.recordingUrl });
    } catch (e) {
      out.problems.push(`recording not archived: ${e instanceof VaultError ? e.code : "ERROR"}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Purge / rewrap / migrate
// ---------------------------------------------------------------------------

async function deleteFromPlane(admin: SupabaseClient, inv: InventoryRow): Promise<void> {
  const { db } = await openPlane(admin, inv.user_id, { region: inv.region, isolation: inv.isolation });
  if (inv.kind === "recording") {
    const { data } = await db.from("sealed_objects").select("bucket,object_path").eq("id", inv.id).maybeSingle();
    if (data) {
      const rm = await db.storage.from(data.bucket).remove([data.object_path]);
      if (rm.error) throw new VaultError("PLANE_UNAVAILABLE", rm.error.message);
    }
    await db.from("sealed_objects").delete().eq("id", inv.id);
  } else {
    await db.from("sealed_values").delete().eq("id", inv.id);
  }
}

/** Removes everything flagged by the purge triggers (or by purgeTenant). Safe to run repeatedly. */
export async function purgePending(admin: SupabaseClient, opts: { ownerId?: string; limit?: number } = {}): Promise<{ purged: number; failed: number }> {
  let q = admin.from("sealed_inventory").select("*").not("purge_requested_at", "is", null).limit(opts.limit ?? 100);
  if (opts.ownerId) q = q.eq("user_id", opts.ownerId);
  const { data } = await q;
  let purged = 0;
  let failed = 0;
  for (const inv of (data ?? []) as InventoryRow[]) {
    try {
      await deleteFromPlane(admin, inv);
      await admin.from("sealed_inventory").delete().eq("id", inv.id);
      purged++;
    } catch {
      failed++;
    }
  }
  return { purged, failed };
}

/** Full-account erasure helper (call from delete-account BEFORE rows are removed). */
export async function purgeTenant(admin: SupabaseClient, ownerId: string): Promise<{ purged: number; failed: number }> {
  await admin.from("sealed_inventory").update({ purge_requested_at: new Date().toISOString() }).eq("user_id", ownerId).is("purge_requested_at", null);
  let purged = 0;
  let failed = 0;
  for (let i = 0; i < 50; i++) { // bounded loop: 50 x 100 items
    const r = await purgePending(admin, { ownerId, limit: 100 });
    purged += r.purged;
    failed += r.failed;
    if (r.purged === 0) break;
  }
  return { purged, failed };
}

/** Re-wraps data keys from an old (retired) key to the new active key. Ciphertext is untouched. */
export async function rewrapBatch(
  admin: SupabaseClient, ownerId: string, fromKeyId: string, toKeyId: string, limit = 100, kms: KmsProvider = kmsProvider(),
): Promise<{ rewrapped: number; remaining: number; failed: number }> {
  const from = await usableKey(admin, ownerId, fromKeyId);
  const to = await usableKey(admin, ownerId, toKeyId);
  const ctx = tenantContext(ownerId);
  const { data } = await admin.from("sealed_inventory").select("*").eq("user_id", ownerId).eq("key_id", fromKeyId).is("purge_requested_at", null).limit(limit);
  let rewrapped = 0;
  let failed = 0;
  for (const inv of (data ?? []) as InventoryRow[]) {
    try {
      const { db } = await openPlane(admin, ownerId, { region: inv.region, isolation: inv.isolation });
      const table = inv.kind === "recording" ? "sealed_objects" : "sealed_values";
      const { data: row } = await db.from(table).select("wrapped_dek").eq("id", inv.id).maybeSingle();
      if (!row) throw new VaultError("NOT_FOUND", "missing");
      const dek = await kms.unwrap(from.key_arn, row.wrapped_dek, ctx);
      try {
        const wrapped = await kms.wrap(to.key_arn, dek, ctx);
        const { error } = await db.from(table).update({ wrapped_dek: wrapped, key_id: toKeyId }).eq("id", inv.id);
        if (error) throw error;
      } finally {
        wipe(dek);
      }
      await admin.from("sealed_inventory").update({ key_id: toKeyId }).eq("id", inv.id);
      rewrapped++;
    } catch {
      failed++;
    }
  }
  const { count } = await admin.from("sealed_inventory").select("id", { count: "exact", head: true })
    .eq("user_id", ownerId).eq("key_id", fromKeyId).is("purge_requested_at", null);
  return { rewrapped, remaining: count ?? 0, failed };
}

/**
 * Moves sealed items to `target` (a region change approved by staff, or a shared -> dedicated
 * upgrade). Ciphertext and wrapped keys are copied as-is — no decryption, no KMS call.
 */
export async function migrateBatch(admin: SupabaseClient, ownerId: string, target: Target, limit = 25): Promise<{ moved: number; remaining: number; failed: number }> {
  const { db: dst, plane: dstPlane } = await openPlane(admin, ownerId, target);
  const { data } = await admin.from("sealed_inventory").select("*").eq("user_id", ownerId).is("purge_requested_at", null)
    .or(`region.neq.${target.region},isolation.neq.${target.isolation}`).limit(limit);
  let moved = 0;
  let failed = 0;
  for (const inv of (data ?? []) as InventoryRow[]) {
    try {
      const { db: src } = await openPlane(admin, ownerId, { region: inv.region, isolation: inv.isolation });
      if (inv.kind === "field") {
        const { data: row } = await src.from("sealed_values").select("*").eq("id", inv.id).maybeSingle();
        if (!row) throw new VaultError("NOT_FOUND", "missing");
        const { error } = await dst.from("sealed_values").upsert(row, { onConflict: "id" });
        if (error) throw error;
      } else {
        const { data: row } = await src.from("sealed_objects").select("*").eq("id", inv.id).maybeSingle();
        if (!row) throw new VaultError("NOT_FOUND", "missing");
        const dl = await src.storage.from(row.bucket).download(row.object_path);
        if (dl.error || !dl.data) throw new VaultError("NOT_FOUND", "file missing");
        const newBucket = bucketFor("recordings", dstPlane.region);
        const up = await dst.storage.from(newBucket).upload(row.object_path, dl.data, { contentType: "application/octet-stream", upsert: true });
        if (up.error) throw up.error;
        const { error } = await dst.from("sealed_objects").upsert({ ...row, bucket: newBucket }, { onConflict: "id" });
        if (error) throw error;
      }
      await admin.from("sealed_inventory").update({ region: target.region, isolation: target.isolation }).eq("id", inv.id);
      await deleteFromPlane(admin, inv).catch(() => undefined); // old copy; a failure leaves a purge-able orphan only in src plane
      moved++;
    } catch {
      failed++;
    }
  }
  const { count } = await admin.from("sealed_inventory").select("id", { count: "exact", head: true })
    .eq("user_id", ownerId).is("purge_requested_at", null)
    .or(`region.neq.${target.region},isolation.neq.${target.isolation}`);
  return { moved, remaining: count ?? 0, failed };
}

// ---------------------------------------------------------------------------
// Full-account erasure
// ---------------------------------------------------------------------------

/** Trust Pack tables keyed by user_id (no `id` column on some, so they are NOT in OWNED_TABLES). */
export const TRUST_TENANT_TABLES = [
  "subprocessor_objections", "residency_change_requests", "sla_credits", "sla_policies",
  "tenant_encryption_policy", "tenant_encryption_keys", "dedicated_tenants", "tenant_residency",
  "sealed_inventory", "sealed_values", "sealed_objects",
] as const;

/**
 * Erases everything the Trust Pack holds for an account: ciphertext + regional objects first
 * (they live in other projects), then the control-plane rows that index them.
 * Call from delete-account and from data-retention-sweep's full_account path, AFTER their
 * legal-hold checks and BEFORE the OWNED_TABLES loop.
 */
export async function eraseTrustPackData(admin: SupabaseClient, ownerId: string): Promise<{ ok: boolean; error?: string }> {
  const purge = await purgeTenant(admin, ownerId);
  if (purge.failed > 0) return { ok: false, error: `${purge.failed} encrypted item(s) could not be removed yet` };
  for (const table of TRUST_TENANT_TABLES) {
    const { error } = await admin.from(table).delete().eq("user_id", ownerId);
    if (error) return { ok: false, error: `${table}: ${error.message}` };
  }
  return { ok: true };
}
