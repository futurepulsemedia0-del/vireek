// supabase/functions/dr-restore-drill/index.ts
//
// Scheduled job (suggested: weekly). Proves the latest backup from
// dr-backup-run is actually restorable — a backup nobody has ever tried
// to restore is not a backup, it's a hope.
//
// Two levels of verification, run in this order:
//
//   1. INTEGRITY (always runs, no extra setup): download the latest
//      completed backup, verify its SHA-256 checksum, decompress it, and
//      confirm every table's row count in the file matches what was
//      recorded at backup time.
//
//   2. LIVE RESTORE (only runs if the SUPABASE_DB_URL secret is set): open
//      a direct Postgres connection, create a throwaway schema
//      (dr_verify_<run-id>), CREATE TABLE ... AS from a jsonb_to_recordset
//      of the snapshot for a sample of tables, count rows back out, then
//      DROP the schema. This is what actually exercises "can we get rows
//      back into a real table," which a REST-only (supabase-js) check
//      cannot do — supabase-js has no DDL access, only direct Postgres
//      does. Point SUPABASE_DB_URL at a role with CREATE privileges on a
//      dedicated schema; never grant it broader access than that.
//
// If SUPABASE_DB_URL isn't set, the drill still runs and still logs a
// pass/fail — just scoped to integrity only, noted in `notes`.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
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

  const started = Date.now();
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const { data: latestBackup, error: backupError } = await admin
    .from("platform_backup_runs")
    .select("*")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (backupError || !latestBackup) {
    return json({ error: backupError?.message ?? "No completed backup to verify." }, 400);
  }

  const { data: drillRow, error: drillError } = await admin
    .from("platform_restore_drills")
    .insert({ backup_run_id: latestBackup.id, status: "running" })
    .select()
    .single();
  if (drillError) return json({ error: drillError.message }, 500);

  const mismatches: Record<string, unknown> = {};
  const notes: string[] = [];

  try {
    const { data: fileBlob, error: downloadError } = await admin.storage
      .from("dr-backups")
      .download(latestBackup.storage_path);
    if (downloadError || !fileBlob) throw new Error(`download: ${downloadError?.message ?? "empty file"}`);

    const compressed = new Uint8Array(await fileBlob.arrayBuffer());
    const actualChecksum = await sha256Hex(compressed);
    if (actualChecksum !== latestBackup.checksum_sha256) {
      mismatches["checksum"] = { expected: latestBackup.checksum_sha256, actual: actualChecksum };
    }

    const raw = await gunzip(compressed);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { tables: Record<string, unknown[]> };

    const expectedCounts = (latestBackup.table_row_counts ?? {}) as Record<string, number>;
    for (const [table, expected] of Object.entries(expectedCounts)) {
      const actual = parsed.tables[table]?.length ?? -1;
      if (actual !== expected) mismatches[table] = { expected, actual };
    }

    // ---------- Optional live restore-to-scratch-schema ----------
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (dbUrl) {
      const postgres = (await import("npm:postgres@3.4.4")).default;
      const sql = postgres(dbUrl, { max: 1 });
      const schema = `dr_verify_${drillRow.id.replace(/-/g, "_")}`;
      try {
        await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        // Sample a small, representative subset rather than the whole
        // snapshot — the goal is proving the restore PATH works, not
        // re-running a full production-sized load on every drill.
        const sampleTables = Object.keys(parsed.tables).slice(0, 3);
        for (const table of sampleTables) {
          const rows = parsed.tables[table];
          if (!rows.length) continue;
          const columns = Object.keys(rows[0] as Record<string, unknown>);
          await sql.unsafe(
            `CREATE TABLE ${schema}.${table} (${columns.map((c) => `"${c}" jsonb`).join(", ")})`
          );
          for (const row of rows.slice(0, 500)) {
            const values = columns.map((c) => JSON.stringify((row as Record<string, unknown>)[c]));
            await sql.unsafe(
              `INSERT INTO ${schema}.${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
                .map((_c, i) => `$${i + 1}`)
                .join(", ")})`,
              values
            );
          }
          const [{ count }] = await sql.unsafe(`SELECT count(*)::int AS count FROM ${schema}.${table}`);
          const expectedSample = Math.min(rows.length, 500);
          if (count !== expectedSample) mismatches[`live_restore_${table}`] = { expected: expectedSample, actual: count };
        }
        notes.push(`Live restore verified against schema ${schema} (sampled up to 500 rows/table, 3 tables).`);
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await sql.end({ timeout: 5 });
      }
    } else {
      notes.push("SUPABASE_DB_URL not set — integrity-only drill. Set it to enable live restore-to-scratch-schema verification.");
    }

    const status = Object.keys(mismatches).length ? "failed" : "passed";
    const rtoSeconds = (Date.now() - started) / 1000;

    await admin
      .from("platform_restore_drills")
      .update({
        status,
        completed_at: new Date().toISOString(),
        rto_seconds: rtoSeconds,
        row_count_mismatches: mismatches,
        notes: notes.join(" "),
      })
      .eq("id", drillRow.id);

    return json({ id: drillRow.id, status, rtoSeconds, mismatches, notes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("platform_restore_drills")
      .update({ status: "failed", completed_at: new Date().toISOString(), notes: message })
      .eq("id", drillRow.id);
    return json({ error: message }, 500);
  }
});
