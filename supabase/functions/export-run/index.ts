// supabase/functions/export-run/index.ts
//
// Async data exports (CSV / XLSX / PDF) for /dashboard/exports.
//
// Actions (POST JSON):
//   { action: "create",   dataset, format, filters }  -> 202 { job_id }
//   { action: "download", job_id }                    -> 200 { url, file_name, expires_in }
//   { action: "delete",   job_id }                    -> 200 { ok: true }
//
// SECURITY MODEL
// - The caller is authenticated from their own JWT. Account scope is resolved
//   server-side with get_account_owner_id(); the client never sends a user_id.
// - Permission gate: can_export_data() (owner always; team members by flag).
//   Re-checked here, not just in the UI.
// - DATA IS READ WITH THE CALLER'S JWT (RLS applies) AND is additionally
//   filtered by user_id = accountOwnerId. The service-role client is used only
//   to write export_jobs rows and to read/write the private storage bucket.
// - Only datasets registered in _shared/exports/engine.ts are exportable;
//   table / column names never come from the client.
// - Files live in a private bucket. They are only ever exposed through
//   short-lived signed URLs minted here, and expire after FILE_RETENTION_DAYS.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  EXPORT_DATASETS,
  EXPORT_PAGE_SIZE,
  FORMAT_MIME,
  FORMAT_ROW_CAP,
  SIGNED_URL_TTL_SECONDS,
  STALE_PROCESSING_MINUTES,
  applyExportFilters,
  buildExportFile,
  exportFileName,
  exportStoragePath,
  isExportExpired,
  validateExportRequest,
  type ExportRequest,
  type FilterableQuery,
} from "../_shared/exports/engine.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BUCKET = "data-exports";
const MAX_ACTIVE_JOBS = 3;
const MAX_JOBS_PER_HOUR = 30;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface JobRow {
  id: string;
  user_id: string;
  dataset: string;
  format: "csv" | "xlsx" | "pdf";
  filters: Record<string, string>;
  status: string;
  file_path: string | null;
  expires_at: string;
  created_at: string;
  download_count: number;
}

// deno-lint-ignore no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

async function audit(caller: AnyClient, ownerId: string, action: string, jobId: string) {
  try {
    await caller.rpc("log_audit_event", {
      p_user_id: ownerId,
      p_action: action,
      p_target_table: "export_jobs",
      p_target_id: jobId,
    });
  } catch {
    // Audit is best-effort: never block the user's export on it.
  }
}

/** Marks stuck jobs failed and expires/deletes aged files for this account. */
async function sweep(service: AnyClient, ownerId: string) {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60_000).toISOString();
  await service
    .from("export_jobs")
    .update({
      status: "failed",
      error_message: "The export took too long and was stopped. Please try again with fewer rows.",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", ownerId)
    .in("status", ["queued", "processing"])
    .lt("created_at", staleBefore);

  const { data: aged } = await service
    .from("export_jobs")
    .select("id, file_path")
    .eq("user_id", ownerId)
    .eq("status", "completed")
    .lte("expires_at", new Date().toISOString())
    .limit(50);

  const rows = (aged ?? []) as { id: string; file_path: string | null }[];
  if (rows.length) {
    const paths = rows.map((r) => r.file_path).filter((p): p is string => !!p);
    if (paths.length) await service.storage.from(BUCKET).remove(paths);
    await service
      .from("export_jobs")
      .update({ status: "expired", file_path: null, updated_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));
  }
}

async function runJob(
  caller: AnyClient,
  service: AnyClient,
  jobId: string,
  ownerId: string,
  req: ExportRequest,
) {
  const def = EXPORT_DATASETS[req.dataset];
  const cap = FORMAT_ROW_CAP[req.format];
  try {
    await service
      .from("export_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", jobId);

    // Read cap+1 rows so truncation is detected exactly, never guessed.
    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    while (rows.length < cap + 1) {
      const size = Math.min(EXPORT_PAGE_SIZE, cap + 1 - rows.length);
      const base = caller.from(def.table).select(def.select);
      const filtered = applyExportFilters(base as unknown as FilterableQuery, def, req.filters, ownerId);
      const { data, error } = await (filtered as unknown as {
        order(c: string, o: { ascending: boolean }): {
          order(c: string, o: { ascending: boolean }): {
            range(a: number, b: number): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
          };
        };
      })
        .order(def.dateColumn, { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + size - 1);
      if (error) throw error;
      const page = data ?? [];
      rows.push(...page);
      if (page.length < size) break;
      offset += size;
    }

    const truncated = rows.length > cap;
    const finalRows = truncated ? rows.slice(0, cap) : rows;

    const generatedAt = new Date();
    const bytes = buildExportFile(req, finalRows, { generatedAt, truncated });
    const path = exportStoragePath(ownerId, jobId, req.format);

    const { error: upErr } = await service.storage.from(BUCKET).upload(path, bytes, {
      contentType: FORMAT_MIME[req.format],
      upsert: true,
    });
    if (upErr) throw upErr;

    await service
      .from("export_jobs")
      .update({
        status: "completed",
        row_count: finalRows.length,
        truncated,
        file_path: path,
        file_size_bytes: bytes.length,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", jobId);
  } catch (err) {
    console.error("export-run job failed", jobId, err);
    await service
      .from("export_jobs")
      .update({
        status: "failed",
        error_message: "We couldn't generate this export. Please try again, or narrow the filters.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);

  const { data: ownerData, error: ownerErr } = await caller.rpc("get_account_owner_id");
  if (ownerErr || !ownerData) return json({ error: "Could not resolve your account." }, 401);
  const ownerId = ownerData as string;

  const { data: allowed, error: permErr } = await caller.rpc("can_export_data");
  if (permErr) return json({ error: "Could not verify your permissions." }, 500);
  if (allowed !== true) {
    return json({ error: "You don't have permission to export data. Ask the account owner to enable it for you." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // ------------------------------------------------------------------
  // create
  // ------------------------------------------------------------------
  if (body.action === "create") {
    const parsed = validateExportRequest(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const request = parsed.value;

    await sweep(service, ownerId);

    const [{ count: active }, { count: lastHour }] = await Promise.all([
      service
        .from("export_jobs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ownerId)
        .in("status", ["queued", "processing"]),
      service
        .from("export_jobs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ownerId)
        .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()),
    ]);
    if ((active ?? 0) >= MAX_ACTIVE_JOBS) {
      return json({ error: "You already have exports running. Wait for one to finish, then try again." }, 429);
    }
    if ((lastHour ?? 0) >= MAX_JOBS_PER_HOUR) {
      return json({ error: "Export limit reached for this hour. Please try again later." }, 429);
    }

    const { data: job, error: insErr } = await service
      .from("export_jobs")
      .insert({
        user_id: ownerId,
        requested_by: user.id,
        requested_by_email: user.email ?? null,
        dataset: request.dataset,
        format: request.format,
        filters: request.filters,
        status: "queued",
      })
      .select("id")
      .single();
    if (insErr || !job) {
      console.error("export-run insert failed", insErr);
      return json({ error: "Could not start the export." }, 500);
    }

    await audit(caller, ownerId, `export_requested:${request.dataset}:${request.format}`, job.id as string);

    const work = runJob(caller, service, job.id as string, ownerId, request);
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(work);
    else void work;

    return json({ job_id: job.id }, 202);
  }

  // ------------------------------------------------------------------
  // download / delete  (both need an existing job in THIS account)
  // ------------------------------------------------------------------
  if (body.action === "download" || body.action === "delete") {
    const jobId = typeof body.job_id === "string" ? body.job_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: "Invalid job id." }, 400);

    const { data: found } = await service
      .from("export_jobs")
      .select("id, user_id, dataset, format, filters, status, file_path, expires_at, created_at, download_count")
      .eq("id", jobId)
      .eq("user_id", ownerId)
      .maybeSingle();
    const job = found as JobRow | null;
    if (!job) return json({ error: "Export not found." }, 404);

    if (body.action === "delete") {
      if (job.file_path) await service.storage.from(BUCKET).remove([job.file_path]);
      await service
        .from("export_jobs")
        .update({ status: "expired", file_path: null, expires_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", job.id);
      await audit(caller, ownerId, "export_deleted", job.id);
      return json({ ok: true });
    }

    if (job.status !== "completed" || !job.file_path) {
      return json({ error: job.status === "expired" ? "This export has expired." : "This export isn't ready yet." }, job.status === "expired" ? 410 : 409);
    }
    if (isExportExpired(job.expires_at)) {
      await service.storage.from(BUCKET).remove([job.file_path]);
      await service
        .from("export_jobs")
        .update({ status: "expired", file_path: null, updated_at: new Date().toISOString() })
        .eq("id", job.id);
      return json({ error: "This export has expired. Please create a new one." }, 410);
    }

    const fileName = exportFileName(
      job.dataset as ExportRequest["dataset"],
      job.format,
      new Date(job.created_at),
    );
    const { data: signed, error: signErr } = await service.storage
      .from(BUCKET)
      .createSignedUrl(job.file_path, SIGNED_URL_TTL_SECONDS, { download: fileName });
    if (signErr || !signed?.signedUrl) {
      console.error("export-run sign failed", signErr);
      return json({ error: "Could not create a download link." }, 500);
    }

    await service
      .from("export_jobs")
      .update({
        download_count: (job.download_count ?? 0) + 1,
        last_downloaded_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    await audit(caller, ownerId, "export_downloaded", job.id);

    return json({ url: signed.signedUrl, file_name: fileName, expires_in: SIGNED_URL_TTL_SECONDS });
  }

  return json({ error: 'Unknown action. Use "create", "download" or "delete".' }, 400);
});
