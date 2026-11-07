// supabase/functions/tenant-import/index.ts
// POST application/x-tar (a vireek-export/1 bundle). Default is a DRY RUN; add ?commit=1 to write.
//  * bundle is fully validated (checksums, counts, ids, no user_id) before anything is written
//  * every row is written with user_id = the server-resolved account owner
//  * if ANY id already belongs to another account the whole import is refused (no cross-tenant overwrite)
//  * upsert by id => re-running the same bundle is idempotent
// Writes are batched per table in dependency order and are NOT one transaction: on a mid-way failure the
// response says which table stopped, and re-running the same bundle completes it.
import { MAX_IMPORT_BYTES, TABLES, parseBundle, tarUnpack, type Row } from "../_shared/tenant-export/bundle.ts";
import { CORS, authorizeOwner, jsonRes } from "../_shared/tenant-export/auth.ts";

const BATCH = 500;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);
  const a = await authorizeOwner(req);
  if (!a.ok) return a.res;

  if (Number(req.headers.get("content-length") ?? "0") > MAX_IMPORT_BYTES) return jsonRes({ error: "payload_too_large" }, 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  const files = tarUnpack(buf);
  if (!files) return jsonRes({ error: "invalid_archive" }, 400);
  const parsed = await parseBundle(files);
  if (!parsed.ok) return jsonRes({ error: "invalid_bundle", detail: parsed.error }, 422);

  // Preflight: refuse if any id is owned by someone else.
  for (const t of TABLES) {
    const ids = parsed.rows[t].map((r) => r.id as string);
    for (let i = 0; i < ids.length; i += BATCH) {
      const { data, error } = await a.admin.from(t).select("id").in("id", ids.slice(i, i + BATCH)).neq("user_id", a.ownerId);
      if (error) return jsonRes({ error: "preflight_failed", table: t }, 500);
      if ((data ?? []).length > 0) return jsonRes({ error: "id_conflict", table: t, detail: "Some ids already belong to another account; nothing was imported." }, 409);
    }
  }

  const summary = Object.fromEntries(TABLES.map((t) => [t, parsed.rows[t].length]));
  if (new URL(req.url).searchParams.get("commit") !== "1") return jsonRes({ dry_run: true, would_import: summary });

  const done: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = parsed.rows[t];
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r: Row) => ({ ...r, user_id: a.ownerId }));
      const { error } = await a.admin.from(t).upsert(batch, { onConflict: "id" });
      if (error) {
        console.error(JSON.stringify({ event: "tenant_import_failed", table: t, error: error.message }));
        return jsonRes({ error: "import_failed", table: t, imported_so_far: done, hint: "Re-run the same bundle; the import is idempotent." }, 500);
      }
      done[t] = (done[t] ?? 0) + batch.length;
    }
  }
  console.log(JSON.stringify({ event: "tenant_import", owner: a.ownerId, actor: a.actorId, imported: done }));
  return jsonRes({ dry_run: false, imported: done });
});
