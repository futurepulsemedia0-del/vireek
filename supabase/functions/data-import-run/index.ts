// supabase/functions/data-import-run/index.ts
//
// Runs a CSV-based competitor data import (customers or job history).
// Uses the CALLER's own JWT — same security model as ai-assistant-query
// — so every read/write goes through RLS and scopes to the caller's
// account automatically. No service-role client, no client-supplied
// user_id.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { parseCsv } from "../_shared/data-import/csv.ts";
import { upsertCustomerRow, upsertJobRow } from "../_shared/data-import/upsert.ts";
import type { RunImportRequest, RunImportResult, RowErrorSummary } from "../_shared/data-import/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_ROWS_PER_RUN = 5000; // keep a single edge-function invocation inside its time limit

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );

  let body: RunImportRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (body.source !== "csv") {
    return jsonResponse({ error: `Unsupported source "${body.source}". Only "csv" is available today.` }, 400);
  }
  if (body.import_type !== "customers" && body.import_type !== "jobs") {
    return jsonResponse({ error: 'import_type must be "customers" or "jobs"' }, 400);
  }
  if (!body.csv_text || typeof body.csv_text !== "string") {
    return jsonResponse({ error: "csv_text is required" }, 400);
  }

  const { data: ownerIdData, error: ownerErr } = await client.rpc("get_account_owner_id");
  if (ownerErr || !ownerIdData) {
    return jsonResponse({ error: "Could not resolve account for the current user." }, 401);
  }
  const ownerId = ownerIdData as string;

  const { headers, rows } = parseCsv(body.csv_text);
  if (rows.length === 0) {
    return jsonResponse({ error: "No data rows found in the uploaded CSV." }, 400);
  }
  if (rows.length > MAX_ROWS_PER_RUN) {
    return jsonResponse({ error: `This file has ${rows.length} rows — split it into batches of ${MAX_ROWS_PER_RUN} or fewer.` }, 400);
  }

  const { data: jobRow, error: jobInsertErr } = await client
    .from("data_import_jobs")
    .insert({
      user_id: ownerId,
      source: "csv",
      import_type: body.import_type,
      status: "running",
      file_name: body.file_name ?? null,
      column_mapping: body.column_mapping,
      total_rows: rows.length,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobInsertErr || !jobRow) {
    return jsonResponse({ error: `Could not start import run: ${jobInsertErr?.message}` }, 500);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const rowErrors: { row_number: number; raw_row: Record<string, string>; error_message: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const outcome =
      body.import_type === "customers"
        ? await upsertCustomerRow(client, ownerId, row, body.column_mapping as import("../_shared/data-import/types.ts").CustomerColumnMapping)
        : await upsertJobRow(client, ownerId, row, body.column_mapping as import("../_shared/data-import/types.ts").JobColumnMapping);

    if (outcome.action === "created") created++;
    else if (outcome.action === "updated") updated++;
    else if (outcome.action === "skipped") skipped++;
    else {
      rowErrors.push({ row_number: i + 2, raw_row: row, error_message: outcome.message ?? "Unknown error" }); // +2: header row + 1-indexing
    }
  }

  const status = rowErrors.length === 0 ? "completed" : rowErrors.length === rows.length ? "failed" : "completed_with_errors";

  await client
    .from("data_import_jobs")
    .update({
      status,
      processed_rows: rows.length,
      created_count: created,
      updated_count: updated,
      skipped_count: skipped,
      error_count: rowErrors.length,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobRow.id);

  if (rowErrors.length > 0) {
    await client.from("data_import_row_errors").insert(
      rowErrors.map((e) => ({
        import_job_id: jobRow.id,
        user_id: ownerId,
        row_number: e.row_number,
        raw_row: e.raw_row,
        error_message: e.error_message,
      })),
    );
  }

  const result: RunImportResult = {
    import_job_id: jobRow.id,
    status,
    total_rows: rows.length,
    created_count: created,
    updated_count: updated,
    skipped_count: skipped,
    error_count: rowErrors.length,
    errors: rowErrors.slice(0, 50).map((e): RowErrorSummary => ({ row_number: e.row_number, error_message: e.error_message })),
  };

  return jsonResponse(result);
});
