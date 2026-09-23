// supabase/functions/dr-backup-run/index.ts
//
// Scheduled job (suggested: daily, off-peak). Takes an application-level
// LOGICAL backup of the tables that matter most for business continuity
// and uploads it, gzip-compressed, to a private Storage bucket.
//
// This is a SAFETY-NET layer, not a replacement for Supabase's own
// infrastructure backups (PITR / nightly physical backups on Pro+ plans).
// It exists so this app can prove — and let customers see, via
// platform_backup_runs — that a restorable snapshot exists independent
// of Supabase infra, and so dr-restore-drill has something concrete to
// verify against.
//
// Required setup (one-time, do this in the Supabase dashboard):
//   1. Create a PRIVATE storage bucket named "dr-backups".
//   2. No public bucket policy — this function uses the service role key,
//      which bypasses Storage RLS entirely; nothing else needs access.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { OWNED_TABLE_NAMES } from "../_shared/compliance/ownedTables.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Platform-wide tables (not per-account) worth including alongside the
// per-account OWNED_TABLES list, since a full DR restore needs identity
// and team structure too.
const PLATFORM_TABLES = ["profiles", "team_members", "customers"];
const PAGE_SIZE = 1000;

async function dumpTable(admin: ReturnType<typeof createClient>, table: string) {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from(table).select("*").range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`dump "${table}": ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const { data: runRow, error: runError } = await admin
    .from("platform_backup_runs")
    .insert({ status: "running", backup_type: "logical_snapshot" })
    .select()
    .single();
  if (runError) return json({ error: runError.message }, 500);

  const tables = [...new Set([...PLATFORM_TABLES, ...OWNED_TABLE_NAMES])];
  const snapshot: Record<string, unknown[]> = {};
  const rowCounts: Record<string, number> = {};

  try {
    for (const table of tables) {
      const rows = await dumpTable(admin, table);
      snapshot[table] = rows;
      rowCounts[table] = rows.length;
    }

    const payload = new TextEncoder().encode(JSON.stringify({ takenAt: new Date().toISOString(), tables: snapshot }));
    const compressed = await gzip(payload);
    const checksum = await sha256Hex(compressed);

    const day = new Date().toISOString().slice(0, 10);
    const path = `${day}/${runRow.id}.json.gz`;

    const { error: uploadError } = await admin.storage
      .from("dr-backups")
      .upload(path, compressed, { contentType: "application/gzip", upsert: false });
    if (uploadError) throw new Error(`storage upload: ${uploadError.message}`);

    await admin
      .from("platform_backup_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        storage_path: path,
        size_bytes: compressed.byteLength,
        checksum_sha256: checksum,
        table_row_counts: rowCounts,
      })
      .eq("id", runRow.id);

    return json({ id: runRow.id, path, sizeBytes: compressed.byteLength, tableRowCounts: rowCounts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("platform_backup_runs")
      .update({ status: "failed", completed_at: new Date().toISOString(), error_message: message })
      .eq("id", runRow.id);
    return json({ error: message }, 500);
  }
});
