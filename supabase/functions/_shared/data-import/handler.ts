// supabase/functions/_shared/data-import/handler.ts
//
// Import wizard API (v2) — validate / run / rollback. Delegated to from
// data-import-run/index.ts. Uses the CALLER's JWT client end to end, so every
// read and write goes through RLS and is scoped to the caller's account
// (user_id = get_account_owner_id()); the owner id is resolved server-side and
// never taken from the request.
//
// Permission: the account owner, or a member whose effective
// can_edit_business_profile is true (public.can_run_data_imports(), also
// enforced by a trigger on data_import_jobs).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { parseCsv } from "./csv.ts";
import { cleanText, isValidTimeZone, parseDateTime } from "./normalize.ts";
import { planCustomers, planJobs, requiredCustomerFieldsMapped, requiredJobFieldsMapped, summarize } from "./plan.ts";
import type {
  DedupeStrategy, ExistingCustomer, ExistingJob, FieldMap, ImportRequestV2, ImportSourceV2, ImportTypeV2,
  PlannedRow, RollbackResultV2, RunResultV2, ValidateResultV2, ValidateRowResult,
} from "./v2types.ts";

type Respond = (data: unknown, status?: number) => Response;
type Row = Record<string, string>;

const MAX_ROWS = 5000; // keeps one invocation inside the edge-function time limit
const MAX_CSV_CHARS = 12_000_000;
const CHUNK = 200;
const STALE_RUN_MINUTES = 15;
const SOURCES = new Set<string>(["csv", "service_titan", "jobber", "housecall_pro"]);
const STRATEGIES = new Set<string>(["skip", "fill_blanks", "overwrite"]);

const CUSTOMER_FIELDS = new Set(["name", "first_name", "last_name", "company", "phone", "email", "address", "city", "state", "zip", "customer_type", "notes", "external_id"]);
const JOB_FIELDS = new Set(["customer_name", "customer_first_name", "customer_last_name", "customer_phone", "customer_external_id", "service_type", "address", "city", "state", "zip", "scheduled_datetime", "job_status", "invoice_amount", "invoice_status", "external_id"]);

const CUSTOMER_COLUMNS = "id,name,phone,email,address,notes,customer_type,external_source,external_id,updated_at";
const JOB_COLUMNS = "id,customer_id,customer_name,customer_phone,service_type,address,scheduled_datetime,job_status,invoice_amount,invoice_status,external_source,external_id";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ helpers

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; from < 200_000; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return out;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function friendlyDbError(message: string | undefined): string {
  const text = message ?? "Unknown error";
  if (/duplicate key|unique constraint/i.test(text)) return "Conflicts with an existing record (same phone, email or ID).";
  if (/violates check constraint/i.test(text)) return "A value isn't allowed for this field.";
  if (/foreign key/i.test(text)) return "Still referenced by other records.";
  return text;
}

// ------------------------------------------------------------- input checks

interface Prepared {
  source: ImportSourceV2;
  importType: ImportTypeV2;
  strategy: DedupeStrategy;
  timezone: string;
  fileName: string | null;
  fileType: "csv" | "xlsx" | null;
  headers: string[];
  rows: Row[];
  map: FieldMap;
}

function prepare(body: ImportRequestV2): Prepared {
  if (!body.source || !SOURCES.has(body.source)) throw new HttpError(400, "Unsupported import source.");
  if (body.import_type !== "customers" && body.import_type !== "jobs") throw new HttpError(400, 'import_type must be "customers" or "jobs".');
  const strategy = (body.dedupe_strategy ?? "fill_blanks") as DedupeStrategy;
  if (!STRATEGIES.has(strategy)) throw new HttpError(400, "Unknown duplicate-handling option.");
  const timezone = body.timezone ?? "UTC";
  if (!isValidTimeZone(timezone)) throw new HttpError(400, "Unknown timezone.");
  if (!body.csv_text || typeof body.csv_text !== "string") throw new HttpError(400, "csv_text is required.");
  if (body.csv_text.length > MAX_CSV_CHARS) throw new HttpError(413, "This file is too large. Split it into smaller files.");

  const { headers, rows } = parseCsv(body.csv_text);
  if (rows.length === 0) throw new HttpError(400, "No data rows found in the uploaded file.");
  if (rows.length > MAX_ROWS) throw new HttpError(400, `This file has ${rows.length} rows — split it into files of ${MAX_ROWS} rows or fewer.`);

  const map: FieldMap = {};
  const allowed = body.import_type === "customers" ? CUSTOMER_FIELDS : JOB_FIELDS;
  for (const [field, header] of Object.entries(body.column_mapping ?? {})) {
    if (!header) continue;
    if (!allowed.has(field)) throw new HttpError(400, `Unknown field "${field}" in the column mapping.`);
    if (!headers.includes(header)) throw new HttpError(400, `Column "${header}" (mapped to ${field}) isn't in the file.`);
    map[field] = header;
  }
  const mapped = body.import_type === "customers" ? requiredCustomerFieldsMapped(map) : requiredJobFieldsMapped(map);
  if (!mapped) throw new HttpError(400, body.import_type === "customers" ? "Map a name column (or first/last name, or company)." : "Map a customer name column.");

  return {
    source: body.source, importType: body.import_type, strategy, timezone,
    fileName: body.file_name ? String(body.file_name).slice(0, 255) : null,
    fileType: body.file_type === "xlsx" ? "xlsx" : body.file_type === "csv" ? "csv" : null,
    headers, rows, map,
  };
}

// ------------------------------------------------------------------ planning

async function loadCustomers(client: SupabaseClient, ownerId: string): Promise<ExistingCustomer[]> {
  return fetchAll<ExistingCustomer>((from, to) =>
    client.from("customers").select(CUSTOMER_COLUMNS).eq("user_id", ownerId).order("id").range(from, to) as unknown as PromiseLike<{ data: ExistingCustomer[] | null; error: { message: string } | null }>);
}

async function loadJobsForPlan(client: SupabaseClient, ownerId: string, p: Prepared): Promise<ExistingJob[]> {
  const found = new Map<string, ExistingJob>();

  // 1) exact external-id hits
  const extIds = [...new Set(p.rows.map((r) => cleanText(r[p.map.external_id ?? ""])).filter(Boolean))];
  for (let i = 0; i < extIds.length; i += CHUNK) {
    const { data, error } = await client.from("jobs").select(JOB_COLUMNS).eq("user_id", ownerId).eq("external_source", p.source).in("external_id", extIds.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const j of (data ?? []) as ExistingJob[]) found.set(j.id, j);
  }

  // 2) the file's date window, for fingerprint dedupe of jobs without ids
  const times = p.rows
    .map((r) => parseDateTime(r[p.map.scheduled_datetime ?? ""], p.timezone))
    .filter((v): v is string => typeof v === "string")
    .map((v) => Date.parse(v));
  if (times.length > 0) {
    const min = new Date(Math.min(...times) - 86_400_000).toISOString();
    const max = new Date(Math.max(...times) + 86_400_000).toISOString();
    const windowed = await fetchAll<ExistingJob>((from, to) =>
      client.from("jobs").select(JOB_COLUMNS).eq("user_id", ownerId).gte("scheduled_datetime", min).lte("scheduled_datetime", max).order("id").range(from, to) as unknown as PromiseLike<{ data: ExistingJob[] | null; error: { message: string } | null }>);
    for (const j of windowed) found.set(j.id, j);
  }
  return [...found.values()];
}

async function buildPlan(client: SupabaseClient, ownerId: string, p: Prepared): Promise<PlannedRow[]> {
  const customers = await loadCustomers(client, ownerId);
  if (p.importType === "customers") return planCustomers(p.rows, p.map, p.source, p.strategy, customers);
  const existingJobs = await loadJobsForPlan(client, ownerId, p);
  return planJobs(p.rows, p.map, p.source, p.strategy, { customers, existingJobs, timezone: p.timezone });
}

function toValidateRow(row: PlannedRow): ValidateRowResult {
  return {
    row_number: row.rowNumber, action: row.action, label: row.label, matched_by: row.matchedBy,
    duplicate_of_row: row.duplicateOfRow, issues: row.issues, display: row.display,
  };
}

/** A bounded, most-important-first sample so the response stays small on 5,000-row files. */
function sampleForPreview(plan: PlannedRow[]): { rows: ValidateRowResult[]; truncated: boolean } {
  const taken = new Set<number>();
  const out: PlannedRow[] = [];
  const take = (predicate: (r: PlannedRow) => boolean, limit: number) => {
    let n = 0;
    for (const r of plan) {
      if (n >= limit) break;
      if (taken.has(r.rowNumber) || !predicate(r)) continue;
      taken.add(r.rowNumber);
      out.push(r);
      n++;
    }
  };
  take((r) => r.action === "error", 120);
  take((r) => r.issues.some((i) => i.severity === "warning"), 60);
  take((r) => r.action === "skip", 60);
  take((r) => r.action === "update", 30);
  take((r) => r.action === "create", 30);
  out.sort((a, b) => a.rowNumber - b.rowNumber);
  return { rows: out.map(toValidateRow), truncated: out.length < plan.length };
}

// ------------------------------------------------------------------ validate

function validate(plan: PlannedRow[]): ValidateResultV2 {
  const summary = summarize(plan);
  const { rows, truncated } = sampleForPreview(plan);
  const writable = summary.create + summary.update;
  return {
    summary, rows, rows_truncated: truncated, can_import: writable > 0,
    blocking_reason: writable > 0 ? undefined
      : summary.error === summary.total ? "Every row has an error — check the column mapping or the file."
      : "Nothing to import — every row is a duplicate or already up to date.",
  };
}

// ----------------------------------------------------------------------- run

interface RowErr { row_number: number; raw_row: Row; error_message: string }
interface Effect { entity_id: string; action: "created" | "updated"; before_values: Record<string, unknown> | null }

async function applyPlan(client: SupabaseClient, ownerId: string, table: "customers" | "jobs", plan: PlannedRow[], rows: Row[]) {
  const errors: RowErr[] = [];
  const effects: Effect[] = [];
  let created = 0;
  let updated = 0;
  const rawOf = (n: number) => rows[n - 2] ?? {};

  for (const p of plan) {
    if (p.action === "error") {
      errors.push({ row_number: p.rowNumber, raw_row: rawOf(p.rowNumber), error_message: p.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" ") || "Invalid row." });
    }
  }

  const creates = plan.filter((p) => p.action === "create");
  for (let i = 0; i < creates.length; i += CHUNK) {
    const chunk = creates.slice(i, i + CHUNK);
    const { data, error } = await client.from(table).insert(chunk.map((p) => ({ ...p.values, user_id: ownerId }))).select("id");
    if (!error && data) {
      created += data.length;
      for (const r of data as { id: string }[]) effects.push({ entity_id: r.id, action: "created", before_values: null });
      continue;
    }
    // One bad row (e.g. a unique-index race) must not sink the other 199: retry individually.
    for (const p of chunk) {
      const one = await client.from(table).insert({ ...p.values, user_id: ownerId }).select("id").single();
      if (one.error || !one.data) errors.push({ row_number: p.rowNumber, raw_row: rawOf(p.rowNumber), error_message: friendlyDbError(one.error?.message) });
      else {
        created++;
        effects.push({ entity_id: (one.data as { id: string }).id, action: "created", before_values: null });
      }
    }
  }

  await mapLimit(plan.filter((p) => p.action === "update"), 8, async (p) => {
    const { error } = await client.from(table).update(p.values).eq("id", p.targetId!).eq("user_id", ownerId);
    if (error) errors.push({ row_number: p.rowNumber, raw_row: rawOf(p.rowNumber), error_message: friendlyDbError(error.message) });
    else {
      updated++;
      effects.push({ entity_id: p.targetId!, action: "updated", before_values: p.before ?? null });
    }
  });

  errors.sort((a, b) => a.row_number - b.row_number);
  return { errors, effects, created, updated };
}

async function run(client: SupabaseClient, ownerId: string, userId: string, body: ImportRequestV2, respond: Respond): Promise<Response> {
  const p = prepare(body);

  // One import at a time per account — overlapping runs would corrupt each other's dedupe.
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  await client.from("data_import_jobs").update({ status: "failed", failure_reason: "Interrupted before finishing.", completed_at: new Date().toISOString() })
    .eq("user_id", ownerId).eq("status", "running").lt("created_at", cutoff);
  await client.from("data_import_jobs").update({ status: "completed_with_errors" })
    .eq("user_id", ownerId).eq("status", "rolling_back").lt("rollback_started_at", cutoff);
  const { data: active } = await client.from("data_import_jobs").select("id").eq("user_id", ownerId).in("status", ["running", "rolling_back"]).limit(1);
  if (active && active.length > 0) throw new HttpError(409, "Another import is still running for this account. Wait for it to finish, then try again.");

  const { data: job, error: jobErr } = await client.from("data_import_jobs").insert({
    user_id: ownerId, source: p.source, import_type: p.importType, status: "running", file_name: p.fileName, file_type: p.fileType,
    column_mapping: p.map, dedupe_strategy: p.strategy, timezone: p.timezone, total_rows: p.rows.length,
    started_by_user: userId, started_at: new Date().toISOString(),
  }).select("id").single();
  if (jobErr || !job) {
    if (jobErr?.code === "42501") throw new HttpError(403, "You don't have permission to import data.");
    throw new Error(`Could not start import run: ${jobErr?.message}`);
  }
  const jobId = (job as { id: string }).id;

  try {
    const plan = await buildPlan(client, ownerId, p);
    const summary = summarize(plan);
    const table = p.importType === "customers" ? "customers" : "jobs";
    const { errors, effects, created, updated } = await applyPlan(client, ownerId, table, plan, p.rows);

    for (let i = 0; i < errors.length; i += 500) {
      await client.from("data_import_row_errors").insert(errors.slice(i, i + 500).map((e) => ({ import_job_id: jobId, user_id: ownerId, ...e })));
    }
    const entityType = p.importType === "customers" ? "customer" : "job";
    for (let i = 0; i < effects.length; i += 500) {
      const { error } = await client.from("data_import_row_effects").insert(effects.slice(i, i + 500).map((e) => ({ import_job_id: jobId, user_id: ownerId, entity_type: entityType, ...e })));
      if (error) console.error("data-import: could not record rollback data", error.message); // import itself already succeeded
    }

    const status: RunResultV2["status"] = errors.length === 0 ? "completed" : errors.length === p.rows.length ? "failed" : "completed_with_errors";
    await client.from("data_import_jobs").update({
      status, processed_rows: p.rows.length, created_count: created, updated_count: updated, skipped_count: summary.skip,
      error_count: errors.length, warning_count: summary.warnings, completed_at: new Date().toISOString(),
    }).eq("id", jobId);

    const result: RunResultV2 = {
      import_job_id: jobId, status, total_rows: p.rows.length, created_count: created, updated_count: updated, skipped_count: summary.skip,
      error_count: errors.length, warning_count: summary.warnings,
      errors: errors.slice(0, 50).map((e) => ({ row_number: e.row_number, error_message: e.error_message })),
    };
    return respond(result);
  } catch (e) {
    await client.from("data_import_jobs").update({ status: "failed", failure_reason: (e as Error).message.slice(0, 500), completed_at: new Date().toISOString() }).eq("id", jobId);
    throw e;
  }
}

// ------------------------------------------------------------------ rollback

async function rollback(client: SupabaseClient, ownerId: string, userId: string, body: ImportRequestV2, respond: Respond): Promise<Response> {
  if (!body.import_job_id) throw new HttpError(400, "import_job_id is required.");
  const { data: job } = await client.from("data_import_jobs").select("id,status,import_type,file_name,created_at,completed_at")
    .eq("id", body.import_job_id).eq("user_id", ownerId).maybeSingle();
  if (!job) throw new HttpError(404, "Import not found.");
  const j = job as { id: string; status: string; import_type: ImportTypeV2; created_at: string; completed_at: string | null };
  if (j.status === "rolled_back") throw new HttpError(409, "This import was already rolled back.");
  if (j.status !== "completed" && j.status !== "completed_with_errors") throw new HttpError(409, "Only finished imports can be rolled back.");

  // Newer imports may have updated the same records — undo in reverse order.
  const { data: newer } = await client.from("data_import_jobs").select("id,file_name")
    .eq("user_id", ownerId).eq("import_type", j.import_type).in("status", ["completed", "completed_with_errors", "running", "rolling_back"])
    .gt("created_at", j.created_at).order("created_at").limit(1);
  if (newer && newer.length > 0) {
    const name = (newer[0] as { file_name: string | null }).file_name;
    throw new HttpError(409, `Roll back the newer import${name ? ` (${name})` : ""} first — imports must be undone newest to oldest.`);
  }

  const { data: locked } = await client.from("data_import_jobs").update({ status: "rolling_back", rollback_started_at: new Date().toISOString() }).eq("id", j.id).eq("user_id", ownerId).eq("status", j.status).select("id");
  if (!locked || locked.length === 0) throw new HttpError(409, "This import is already being changed. Refresh and try again.");

  const table = j.import_type === "customers" ? "customers" : "jobs";
  const result: RollbackResultV2 = { import_job_id: j.id, deleted: 0, restored: 0, kept_modified: 0, blocked: 0, failures: [] };

  try {
    const effects = await fetchAll<{ entity_id: string; action: string; before_values: Record<string, unknown> | null }>((from, to) =>
      client.from("data_import_row_effects").select("entity_id,action,before_values").eq("import_job_id", j.id).eq("user_id", ownerId).order("id").range(from, to) as unknown as PromiseLike<{ data: { entity_id: string; action: string; before_values: Record<string, unknown> | null }[] | null; error: { message: string } | null }>);

    // ---- created records → delete (but never destroy something edited since)
    let createdIds = effects.filter((e) => e.action === "created").map((e) => e.entity_id);
    if (table === "customers" && createdIds.length > 0) {
      const finished = Date.parse(j.completed_at ?? j.created_at) + 5000;
      const edited = new Set<string>();
      for (let i = 0; i < createdIds.length; i += CHUNK) {
        const { data } = await client.from("customers").select("id,updated_at").eq("user_id", ownerId).in("id", createdIds.slice(i, i + CHUNK));
        for (const r of (data ?? []) as { id: string; updated_at: string }[]) if (Date.parse(r.updated_at) > finished) edited.add(r.id);
      }
      result.kept_modified = edited.size;
      createdIds = createdIds.filter((id) => !edited.has(id));
    }
    for (let i = 0; i < createdIds.length; i += 100) {
      const ids = createdIds.slice(i, i + 100);
      const { data, error } = await client.from(table).delete().in("id", ids).eq("user_id", ownerId).select("id");
      if (!error) { result.deleted += (data ?? []).length; continue; }
      for (const id of ids) {
        const one = await client.from(table).delete().eq("id", id).eq("user_id", ownerId).select("id");
        if (one.error) {
          result.blocked++;
          if (result.failures.length < 20) result.failures.push(friendlyDbError(one.error.message));
        } else result.deleted += (one.data ?? []).length;
      }
    }

    // ---- updated records → restore previous values
    await mapLimit(effects.filter((e) => e.action === "updated" && e.before_values), 8, async (e) => {
      const { data, error } = await client.from(table).update(e.before_values!).eq("id", e.entity_id).eq("user_id", ownerId).select("id");
      if (error) {
        result.blocked++;
        if (result.failures.length < 20) result.failures.push(friendlyDbError(error.message));
      } else result.restored += (data ?? []).length;
    });

    await client.from("data_import_jobs").update({
      status: "rolled_back", rolled_back_at: new Date().toISOString(), rolled_back_by_user: userId,
      rollback_summary: { deleted: result.deleted, restored: result.restored, kept_modified: result.kept_modified, blocked: result.blocked, failures: result.failures },
    }).eq("id", j.id);
    return respond(result);
  } catch (e) {
    await client.from("data_import_jobs").update({ status: j.status }).eq("id", j.id); // let the user retry
    throw e;
  }
}

// -------------------------------------------------------------------- entry

export async function handleImportV2(client: SupabaseClient, body: ImportRequestV2, respond: Respond): Promise<Response> {
  try {
    const { data: userData } = await client.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return respond({ error: "Not signed in." }, 401);

    const { data: ownerData, error: ownerErr } = await client.rpc("get_account_owner_id");
    if (ownerErr || !ownerData) return respond({ error: "Could not resolve account for the current user." }, 401);
    const ownerId = ownerData as string;

    const { data: allowed } = await client.rpc("can_run_data_imports");
    if (allowed !== true) {
      return respond({ error: "You don't have permission to import data. Ask the account owner for the “Edit Business Profile” permission." }, 403);
    }

    if (body.action === "validate") return respond(validate(await buildPlan(client, ownerId, prepare(body))));
    if (body.action === "run") return await run(client, ownerId, userId, body, respond);
    if (body.action === "rollback") return await rollback(client, ownerId, userId, body, respond);
    return respond({ error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof HttpError) return respond({ error: e.message }, e.status);
    console.error("data-import v2 failed:", (e as Error).message);
    return respond({ error: "The import hit an unexpected problem. Nothing was lost — please try again." }, 500);
  }
}
