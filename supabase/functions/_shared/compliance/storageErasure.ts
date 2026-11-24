// supabase/functions/_shared/compliance/storageErasure.ts
//
// Removes every Supabase Storage object that belongs to an account (first path segment = account owner id, the layout
// used by every private bucket in this schema). Closes the "storage files are not removed" gap in delete-account.
//
// Objects are listed with the service-role RPC public.storage_objects_for_account() and removed through the Storage
// API (deleting storage.objects rows in SQL would leave the blobs behind). The loop re-lists after each pass, so it is
// idempotent and resumable; it stops when nothing is left, when a pass makes no progress, or at the pass cap.
//
// Requires migration 20290312000000_provider_erasure_queue.sql.

// deno-lint-ignore no-explicit-any
type StorageAdmin = {
  rpc: (n: string, a?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
  storage: { from: (bucket: string) => { remove: (paths: string[]) => PromiseLike<{ data: unknown; error: { message?: string } | null }> } };
};

export interface StorageErasureResult {
  ok: boolean;
  removed: number;
  buckets: string[];
  /** Short reasons only (no object names): object names can contain personal data. */
  errors: string[];
}

const LIST_LIMIT = 500;
const REMOVE_BATCH = 100;
const MAX_PASSES = 200;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function eraseAccountStorage(admin: StorageAdmin, accountId: string): Promise<StorageErasureResult> {
  const out: StorageErasureResult = { ok: true, removed: 0, buckets: [], errors: [] };
  // Never run the catalog query with anything that is not a plain uuid.
  if (!UUID.test(accountId)) return { ...out, ok: false, errors: ["invalid_account_id"] };
  const touched = new Set<string>();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { data, error } = await admin.rpc("storage_objects_for_account", { p_account: accountId, p_limit: LIST_LIMIT });
    if (error) {
      out.ok = false;
      out.errors.push(`list_failed:${String(error.code ?? "error").slice(0, 40)}`);
      break;
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ bucket_id?: string; name?: string }>;
    if (rows.length === 0) break;

    const byBucket = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.bucket_id || !r.name) continue;
      const list = byBucket.get(r.bucket_id) ?? [];
      list.push(r.name);
      byBucket.set(r.bucket_id, list);
    }

    let removedThisPass = 0;
    for (const [bucket, names] of byBucket) {
      for (let i = 0; i < names.length; i += REMOVE_BATCH) {
        const batch = names.slice(i, i + REMOVE_BATCH);
        const { error: rmErr } = await admin.storage.from(bucket).remove(batch);
        if (rmErr) {
          out.ok = false;
          out.errors.push(`remove_failed:${bucket}`);
        } else {
          removedThisPass += batch.length;
          touched.add(bucket);
        }
      }
    }
    out.removed += removedThisPass;
    if (removedThisPass === 0) break; // listed objects that cannot be removed: do not spin
  }

  // Verify: anything still listed means the erasure is incomplete, whatever the remove calls reported.
  if (out.ok) {
    const { data, error } = await admin.rpc("storage_objects_for_account", { p_account: accountId, p_limit: 1 });
    if (error) { out.ok = false; out.errors.push("verify_failed"); }
    else if (Array.isArray(data) && data.length > 0) { out.ok = false; out.errors.push("objects_remaining"); }
  }
  out.buckets = [...touched].sort();
  out.errors = [...new Set(out.errors)];
  return out;
}
