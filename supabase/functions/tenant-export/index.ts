// supabase/functions/tenant-export/index.ts
// GET -> application/x-tar "vireek-export/1" bundle (NDJSON + manifest) of the caller's whole account:
// customers, jobs, invoices, price book, call transcripts, audit log. Owner/admin only; rows are
// always filtered by the server-resolved account owner, never by anything the client sends.
// Deploy: supabase functions deploy tenant-export   (JWT verification stays ON)
import { buildBundle, tarPack, TABLES, MAX_ROWS_PER_TABLE, type Row, type TableName } from "../_shared/tenant-export/bundle.ts";
import { CORS, authorizeOwner, jsonRes } from "../_shared/tenant-export/auth.ts";

const PAGE = 1000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonRes({ error: "method_not_allowed" }, 405);
  const a = await authorizeOwner(req);
  if (!a.ok) return a.res;

  const rows: Partial<Record<TableName, Row[]>> = {};
  for (const t of TABLES) {
    const acc: Row[] = [];
    for (let from = 0; acc.length <= MAX_ROWS_PER_TABLE; from += PAGE) {
      const { data, error } = await a.admin.from(t).select("*").eq("user_id", a.ownerId).order("id").range(from, from + PAGE - 1);
      if (error) {
        console.error(JSON.stringify({ event: "tenant_export_failed", table: t, error: error.message }));
        return jsonRes({ error: "export_failed", table: t }, 500);
      }
      acc.push(...((data ?? []) as Row[]));
      if (!data || data.length < PAGE) break;
    }
    rows[t] = acc;
  }
  const exportedAt = new Date().toISOString();
  const tar = tarPack(await buildBundle(rows, exportedAt), Math.floor(Date.now() / 1000));
  console.log(JSON.stringify({ event: "tenant_export", owner: a.ownerId, actor: a.actorId, bytes: tar.length }));
  return new Response(tar, {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/x-tar", "Content-Disposition": `attachment; filename="vireek-export-${exportedAt.slice(0, 10)}.tar"`, "Cache-Control": "no-store" },
  });
});
