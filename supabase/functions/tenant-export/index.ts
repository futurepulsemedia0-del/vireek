// supabase/functions/tenant-export/index.ts
// Whole-account export for the caller's account. Owner/admin only; every query is filtered by the
// server-resolved account owner, never by anything the client sends.
//
//   GET                       "vireek-export/1" tar for small accounts. If any table has more than 100 000 rows
//                             (or the bundle would be too big for one request) it answers 413 export_too_large —
//                             it never returns a silently truncated archive.
//   GET  ?mode=plan           "vireek-export/2": exact row counts at a snapshot instant
//   GET  ?mode=chunk&table=&snapshot=&after=&limit=   one resumable NDJSON chunk + sha256 headers
//   POST {mode:"finalize"}    completeness gate: 200 + manifest only if every row is accounted for, else 409
//
// Protocol, limits and failure modes: docs/INTEROP.md ("Large-account export"). Logic lives in
// _shared/tenant-export/handler.ts (unit-tested); this file only connects the database.
// Deploy: supabase functions deploy tenant-export   (JWT verification stays ON)
import type { Row, TableName } from "../_shared/tenant-export/bundle.ts";
import { authorizeOwner } from "../_shared/tenant-export/auth.ts";
import { handleExport, type Authorized, type ExportDb } from "../_shared/tenant-export/handler.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

function dbFor(admin: SupabaseClient): ExportDb {
  return {
    async count(table: TableName, ownerId: string, snapshotAt: string | null): Promise<number> {
      let q = admin.from(table).select("id", { count: "exact", head: true }).eq("user_id", ownerId);
      if (snapshotAt) q = q.lte("created_at", snapshotAt);
      const { count, error } = await q;
      if (error || count === null) throw new Error(`count_failed:${table}`);
      return count;
    },
    async page(table: TableName, ownerId: string, snapshotAt: string | null, after: string | null, limit: number): Promise<Row[]> {
      let q = admin.from(table).select("*").eq("user_id", ownerId);
      if (snapshotAt) q = q.lte("created_at", snapshotAt);
      if (after) q = q.gt("id", after);
      const { data, error } = await q.order("id", { ascending: true }).limit(limit);
      if (error) throw new Error(`page_failed:${table}`);
      return (data ?? []) as Row[];
    },
  };
}

async function authorize(req: Request): Promise<Authorized> {
  const a = await authorizeOwner(req);
  return a.ok ? { ok: true, ownerId: a.ownerId, actorId: a.actorId, db: dbFor(a.admin) } : a;
}

Deno.serve((req: Request) => handleExport(req, { authorize }));
