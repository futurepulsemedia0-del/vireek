// supabase/functions/_shared/photo-provenance/handler.ts
//
// Server countersignature for job photos. The browser/app hashes the bytes it captured and uploads them to the
// private `job-evidence-chain` bucket; THIS function downloads the stored object, re-computes the SHA-256 and
// only then calls the service-role-only SQL functions that write the capture record and seal it into the
// per-job hash chain. A client can therefore not register a hash for bytes the server never saw.
//
// Actions (POST JSON, caller's JWT):
//   record_capture      original + optional derivatives -> evp_record_capture()
//   register_derivative later derived copy (e.g. redacted) -> evp_register_derivative()
//   erase               delete on request: purge location, delete stored files, mark erased
//   maintenance         retention sweep; header x-cron-secret = PHOTO_PROVENANCE_CRON_SECRET (no JWT)
//
// I/O is injected so the handler is unit-tested without Deno or a network (see handler.test.ts).

import {
  BUCKET, HttpError, MAX_BYTES, MAX_CAPTURES_PER_HOUR, UUID_RE,
  parseCaptureRequest, parseDerivative, sha256Hex, timingSafeEqual,
  type StoredFile,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

// deno-lint-ignore no-explicit-any
type Db = any;

export interface HandlerDeps {
  // deno-lint-ignore no-explicit-any
  createClient: (url: string, key: string, options?: any) => any;
  env: (name: string) => string | undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Downloads the stored object and proves it matches the claimed fingerprint and size. */
async function verifyStored(admin: Db, file: StoredFile): Promise<void> {
  const { data, error } = await admin.storage.from(BUCKET).download(file.path);
  if (error || !data) throw new HttpError(422, "The uploaded file could not be found on the server.");
  const buf = await data.arrayBuffer();
  if (buf.byteLength > MAX_BYTES || buf.byteLength !== file.bytes) throw new HttpError(422, "The uploaded file size does not match.");
  if ((await sha256Hex(buf)) !== file.sha256) throw new HttpError(422, "The uploaded file does not match its fingerprint.");
}

async function eraseFiles(admin: Db, captureId: string): Promise<void> {
  const { data: paths, error } = await admin.rpc("evp_capture_file_paths", { p_capture: captureId });
  if (error) throw new HttpError(500, "Could not list the files to erase.");
  const list = (paths ?? []) as string[];
  if (list.length) {
    const { error: rmError } = await admin.storage.from(BUCKET).remove(list);
    if (rmError) throw new HttpError(502, "The stored files could not be deleted. Try again.");
  }
  const { error: markError } = await admin.rpc("evp_mark_files_erased", { p_capture_id: captureId });
  if (markError) throw new HttpError(500, "Could not record the erasure.");
}

function sqlError(error: { message?: string; code?: string }): HttpError {
  const m = error.message ?? "";
  if (m.includes("PHOTO_PROVENANCE_FORBIDDEN") || error.code === "42501") return new HttpError(403, "You do not have access to this job.");
  if (m.includes("PHOTO_PROVENANCE_INVALID")) return new HttpError(400, m.replace(/^.*PHOTO_PROVENANCE_INVALID:\s*/, ""));
  console.error("[photo-provenance] sql error", m.slice(0, 300));
  return new HttpError(500, "Could not record the photo.");
}

export async function handlePhotoProvenance(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = deps.env("SUPABASE_URL") ?? "";
    const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = deps.env("SUPABASE_ANON_KEY") ?? "";
    const admin = deps.createClient(url, serviceKey, { auth: { persistSession: false } });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Invalid JSON.");
    }
    const action = String(body?.action ?? "");

    // ---- Scheduled retention sweep (no user session) -------------------------------------------------------
    if (action === "maintenance") {
      const secret = deps.env("PHOTO_PROVENANCE_CRON_SECRET") ?? "";
      const given = req.headers.get("x-cron-secret") ?? "";
      if (!secret || secret.length < 16 || !timingSafeEqual(secret, given)) throw new HttpError(401, "Unauthorized.");
      const { data, error } = await admin.rpc("evp_retention_sweep", { p_limit: 200 });
      if (error) throw new HttpError(500, "Retention sweep failed.");
      const ids = ((data as { erase_capture_ids?: string[] })?.erase_capture_ids ?? []).filter((i) => UUID_RE.test(i));
      let erased = 0;
      const failed: string[] = [];
      for (const id of ids) {
        try {
          await eraseFiles(admin, id);
          erased++;
        } catch {
          failed.push(id);
        }
      }
      return json({ locations_purged: (data as { locations_purged?: number })?.locations_purged ?? 0, files_erased: erased, failed });
    }

    // ---- Signed-in actions ---------------------------------------------------------------------------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError(401, "Missing Authorization header.");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) throw new HttpError(401, "Invalid or expired session.");
    const actorId = userData.user.id as string;

    const userClient = deps.createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: ownerId, error: ownerError } = await userClient.rpc("get_account_owner_id");
    if (ownerError || typeof ownerId !== "string" || !UUID_RE.test(ownerId)) throw new HttpError(403, "No account found for this user.");

    if (action === "record_capture") {
      const reqData = parseCaptureRequest(body, ownerId);
      const { data: recent } = await admin.rpc("evp_recent_capture_count", { p_actor: actorId });
      if (typeof recent === "number" && recent >= MAX_CAPTURES_PER_HOUR) throw new HttpError(429, "Too many photos in the last hour.");

      await verifyStored(admin, reqData.original);
      for (const d of reqData.derivatives) await verifyStored(admin, d);

      const { data, error } = await admin.rpc("evp_record_capture", {
        p_owner: ownerId,
        p_actor: actorId,
        p_job: reqData.jobId,
        p_client_capture_id: reqData.clientCaptureId,
        p_sha256: reqData.original.sha256,
        p_path: reqData.original.path,
        p_bytes: reqData.original.bytes,
        p_mime: reqData.original.mime,
        p_source: reqData.source,
        p_device_at: reqData.deviceCapturedAt,
        p_offline: reqData.offline,
        p_queued_at: reqData.queuedAt,
        p_location: reqData.location,
        p_derivatives: reqData.derivatives.map((d) => ({
          sha256: d.sha256, path: d.path, bytes: d.bytes, mime: d.mime, kind: d.kind,
          width: d.width, height: d.height, transform: d.transform,
        })),
      });
      if (error) throw sqlError(error);
      return json({ ok: true, ...(data as object) });
    }

    if (action === "register_derivative") {
      const captureId = String(body.capture_id ?? "");
      const parent = String(body.parent_sha256 ?? "").toLowerCase();
      if (!UUID_RE.test(captureId)) throw new HttpError(400, "Invalid capture id.");
      const { data: cap } = await admin.from("evidence_photo_captures").select("job_id,user_id").eq("id", captureId).maybeSingle();
      if (!cap || cap.user_id !== ownerId) throw new HttpError(403, "You do not have access to this photo.");
      const d = parseDerivative(body.derivative, ownerId, cap.job_id as string);
      await verifyStored(admin, d);
      const { data, error } = await admin.rpc("evp_register_derivative", {
        p_owner: ownerId, p_actor: actorId, p_capture: captureId, p_sha256: d.sha256, p_path: d.path,
        p_bytes: d.bytes, p_mime: d.mime, p_kind: d.kind, p_width: d.width, p_height: d.height,
        p_transform: d.transform, p_parent: parent,
      });
      if (error) throw sqlError(error);
      return json({ ok: true, ...(data as object) });
    }

    if (action === "erase") {
      const captureId = String(body.capture_id ?? "");
      if (!UUID_RE.test(captureId)) throw new HttpError(400, "Invalid capture id.");
      // Authorization (manager or the technician who took it) is enforced inside the SQL function under the caller's JWT.
      const { data: allowed, error } = await userClient.rpc("request_evidence_photo_erasure", { p_capture_id: captureId });
      if (error) throw sqlError(error);
      if (allowed !== true) throw new HttpError(403, "You cannot erase this photo.");
      await eraseFiles(admin, captureId);
      return json({ ok: true });
    }

    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("[photo-provenance] unexpected", e instanceof Error ? e.message : String(e));
    return json({ error: "Unexpected error." }, 500);
  }
}
