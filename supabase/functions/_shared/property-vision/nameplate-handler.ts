// supabase/functions/_shared/property-vision/nameplate-handler.ts
//
// Request handler for the equipment-nameplate-scan edge function. Kept in _shared with its I/O injected
// (supabase client, env, fetch) so it can be unit-tested without Deno or a network; index.ts is the thin
// Deno entry point.
//
// Technician data-plate scan: Photo -> OCR (vision) -> brand / model / serial / manufacture date
// -> equipment record -> equipment passport (+ warranty status).
//
// It reuses the Property Vision stack rather than forking it: the same private `property-vision`
// bucket and tenancy rule, the same Gemini key/model env, the same sanitisers (normalize.ts), the same
// hourly rate-limit table, and — for the passport — the existing AFTER INSERT trigger on `equipment`.
//
// Two actions on one endpoint:
//   extract (default)  validate + de-duplicate by SHA-256 (a repeated photo costs 0 tokens) -> vision
//                      call -> deterministic normalisation -> store the scan. When `autoCreate` is set
//                      AND the read passes the confidence gate, it also creates the equipment/passport.
//   create             the technician reviewed/corrected the read -> create the equipment/passport.
//
// The model only transcribes. Every decision (dates, serial validity, warranty, auto-create gate) is
// made in _shared/property-vision/nameplate.ts. All writes go through the service-role-only RPC
// nameplate_create_equipment(), which is one idempotent transaction.
//
// Auth: caller's own JWT (needed to read the private photo under storage RLS).

import { extractJson } from "./normalize.ts";
import {
  NAMEPLATE_PROMPT_VERSION, NAMEPLATE_RESPONSE_SCHEMA, NAMEPLATE_SYSTEM_PROMPT,
  canAutoCreate, estimateWarranty, normalizeNameplate, resolveCreateFields, reviewReasons, warrantyStateFor,
  type CreateOverrides, type NormNameplate,
} from "./nameplate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BUCKET = "property-vision";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const RATE_LIMIT_MAX_PER_HOUR = 30; // shared with property-vision-analyze (same table)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const GEMINI_TIMEOUT_MS = 40_000;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export interface HandlerDeps {
  // deno-lint-ignore no-explicit-any
  createClient: (url: string, key: string, options?: any) => any;
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function toBase64(buf: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}

interface Capture { path: string; sha256: string; mime: string; bytes: number }

function parseCapture(raw: unknown, ownerId: string): Capture {
  if (typeof raw !== "object" || raw === null) throw new HttpError(400, "Provide a photo of the data plate.");
  const r = raw as Row;
  const path = typeof r.path === "string" ? r.path : "";
  if (!path.startsWith(`${ownerId}/`) || path.length > 300 || path.includes("..")) throw new HttpError(400, "Invalid photo path.");
  const sha256 = typeof r.sha256 === "string" ? r.sha256.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, "Invalid photo fingerprint.");
  const mime = typeof r.mime === "string" ? r.mime.toLowerCase() : "";
  if (!ALLOWED_MIME.includes(mime)) throw new HttpError(400, "Unsupported image type (use JPEG, PNG, WebP or HEIC).");
  const bytes = Number(r.bytes);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_PHOTO_BYTES) throw new HttpError(400, "The photo must be under 6MB.");
  return { path, sha256, mime, bytes };
}

async function callGemini(fetchFn: typeof fetch, apiKey: string, model: string, parts: unknown[]) {
  const base = { systemInstruction: { parts: [{ text: NAMEPLATE_SYSTEM_PROMPT }] }, contents: [{ role: "user", parts }] };
  const attempts = [
    { generationConfig: { temperature: 0, maxOutputTokens: 1200, responseMimeType: "application/json", responseSchema: NAMEPLATE_RESPONSE_SCHEMA, thinkingConfig: { thinkingBudget: 0 } } },
    // Some models reject schema/thinking options: retry once with a plain JSON-mode config.
    { generationConfig: { temperature: 0, maxOutputTokens: 1200, responseMimeType: "application/json" } },
  ];
  let lastStatus = 0;
  for (const a of attempts) {
    const res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ ...base, ...a }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (res.status === 400) {
      lastStatus = 400;
      console.error("[nameplate-scan] Gemini 400", (await res.text().catch(() => "")).slice(0, 300));
      continue;
    }
    if (!res.ok) {
      console.error("[nameplate-scan] Gemini error", res.status, (await res.text().catch(() => "")).slice(0, 300));
      throw new Error(`gemini_${res.status}`);
    }
    const data = await res.json();
    const cand = data?.candidates?.[0];
    return {
      text: (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("") as string,
      inputTokens: (data?.usageMetadata?.promptTokenCount ?? null) as number | null,
      outputTokens: (data?.usageMetadata?.candidatesTokenCount ?? null) as number | null,
      finishReason: (cand?.finishReason ?? null) as string | null,
    };
  }
  throw new Error(`gemini_${lastStatus || 500}`);
}

// ------------------------------------------------------------------
// Response shaping
// ------------------------------------------------------------------

function scanView(row: Row, cached: boolean) {
  const fields = row.extracted as NormNameplate;
  return {
    id: row.id as string,
    status: row.status as string,
    fields,
    review_reasons: (row.review_reasons ?? []) as string[],
    auto_create_ready: !!row.auto_create_ready,
    // What the warranty would be if created as read (the create step recomputes it from the final fields).
    warranty: estimateWarranty({ kind: fields.kind, manufactureDate: fields.manufacture?.date ?? null }),
    equipment_id: (row.equipment_id ?? null) as string | null,
    cached,
  };
}

/** Outcome for a scan that already created its equipment (replays, double taps, repeated photos). */
async function loadCreated(adminDb: Db, scan: Row) {
  const { data: eq } = await adminDb.from("equipment")
    .select("warranty_expires_at, warranty_notes").eq("id", scan.equipment_id).maybeSingle();
  const { data: link } = await adminDb.from("equipment_passport_links")
    .select("verified, verified_via, passport:passport_id (public_code)")
    .eq("equipment_id", scan.equipment_id).eq("status", "active").maybeSingle();
  const p = Array.isArray(link?.passport) ? link.passport[0] : link?.passport;
  const expires = (eq?.warranty_expires_at ?? null) as string | null;
  return {
    equipment_id: scan.equipment_id as string,
    reused: true,
    passport: link ? { code: link.verified ? (p?.public_code ?? null) : null, verified: !!link.verified, joined_existing: link.verified_via !== "issuer" } : null,
    warranty: { ...warrantyStateFor(expires), expires_at: expires, basis: expires ? "estimated" : "none", note: (eq?.warranty_notes ?? "") as string },
  };
}

interface Ctx { adminDb: Db; callerClient: Db; ownerId: string; userId: string }

async function createFromScan(ctx: Ctx, scan: Row, overrides: CreateOverrides) {
  const resolved = resolveCreateFields(scan.extracted as NormNameplate, overrides);
  if (!resolved.ok) throw new HttpError(400, resolved.error);
  const f = resolved.fields;
  const { data, error } = await ctx.adminDb.rpc("nameplate_create_equipment", {
    p_scan: scan.id,
    p_user: ctx.ownerId,
    p_fields: {
      equipment_type: f.equipment_type, make: f.make, model: f.model, serial_number: f.serial_number,
      install_date: f.install_date, warranty_expires_at: f.warranty_expires_at, warranty_notes: f.warranty_notes, notes: f.notes,
      manufacture_date: f.manufacture_date, manufacture_precision: f.manufacture_precision,
    },
  });
  if (error) {
    const msg = String(error.message ?? "");
    console.error("[nameplate-scan] create failed", msg);
    if (msg.includes("NAMEPLATE_SCAN_NOT_FOUND")) throw new HttpError(404, "That scan no longer exists.");
    if (msg.includes("NAMEPLATE_NO_CUSTOMER")) throw new HttpError(400, "This job has no customer yet — add one so the equipment has an owner.");
    if (msg.includes("NAMEPLATE_INVALID")) throw new HttpError(400, "Brand and equipment type are required.");
    throw new HttpError(500, "Could not create the equipment record. Please try again.");
  }
  return { ...(data as Row), warranty: f.warranty };
}

/** Auto-create must never turn a good read into an error: on failure the technician falls back to review. */
async function autoCreateSafe(ctx: Ctx, scan: Row) {
  try {
    return await createFromScan(ctx, scan, {});
  } catch (e) {
    console.error("[nameplate-scan] auto-create fell back to review", e instanceof Error ? e.message : e);
    return null;
  }
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export async function handleNameplateRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    let body: Row;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

    const supabaseUrl = deps.env("SUPABASE_URL") ?? "";
    const callerClient: Db = deps.createClient(supabaseUrl, deps.env("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: ownerId } = await callerClient.rpc("get_account_owner_id");
    if (!ownerId || typeof ownerId !== "string") return json({ error: "Account not found." }, 403);

    const adminDb: Db = deps.createClient(supabaseUrl, deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const ctx: Ctx = { adminDb, callerClient, ownerId, userId: user.id };

    // ---- create: the technician confirmed / corrected a previous read ------------------------------
    if (body.action === "create") {
      const scanId = typeof body.scanId === "string" && UUID_RE.test(body.scanId) ? body.scanId : null;
      if (!scanId) return json({ error: "Missing scan." }, 400);
      const { data: scan } = await adminDb.from("equipment_nameplate_scans").select("*").eq("id", scanId).eq("user_id", ownerId).maybeSingle();
      if (!scan) return json({ error: "That scan no longer exists." }, 404);
      const created = scan.status === "created" && scan.equipment_id ? await loadCreated(adminDb, scan) : await createFromScan(ctx, scan, (body.fields ?? {}) as CreateOverrides);
      return json({ scan: scanView({ ...scan, status: "created" }, false), created });
    }

    // ---- extract -----------------------------------------------------------------------------------
    const jobId = typeof body.jobId === "string" && UUID_RE.test(body.jobId) ? body.jobId : null;
    let customerId = typeof body.customerId === "string" && UUID_RE.test(body.customerId) ? body.customerId : null;
    if (!jobId && !customerId) return json({ error: "Choose a customer or a job for this equipment." }, 400);
    const capture = parseCapture(body.capture, ownerId);
    const autoCreate = body.autoCreate === true;

    if (jobId) {
      const { data: job } = await adminDb.from("jobs").select("id, customer_id").eq("id", jobId).eq("user_id", ownerId).maybeSingle();
      if (!job) return json({ error: "Job not found." }, 404);
      if (customerId && job.customer_id && job.customer_id !== customerId) return json({ error: "That job belongs to a different customer." }, 400);
      customerId = customerId ?? job.customer_id ?? null;
    }
    if (!customerId) return json({ error: "This job has no customer yet — add one so the equipment has an owner." }, 400);
    const { data: cu } = await adminDb.from("customers").select("id").eq("id", customerId).eq("user_id", ownerId).maybeSingle();
    if (!cu) return json({ error: "Customer not found." }, 404);

    // ---- De-duplicate by fingerprint: an already-read plate costs nothing --------------------------
    const { data: prior } = await adminDb.from("equipment_nameplate_scans").select("*").eq("user_id", ownerId).eq("sha256", capture.sha256).maybeSingle();
    if (prior?.status === "created" && prior.equipment_id) {
      return json({ scan: scanView(prior, true), created: await loadCreated(adminDb, prior) });
    }
    if (prior?.status === "extracted") {
      // Same photo, possibly for another job/customer: nothing has been created yet, so just re-scope it.
      const { data: rescoped } = await adminDb.from("equipment_nameplate_scans")
        .update({ job_id: jobId, customer_id: customerId, updated_at: new Date().toISOString() }).eq("id", prior.id).select("*").single();
      const row = rescoped ?? prior;
      const created = autoCreate && row.auto_create_ready ? await autoCreateSafe(ctx, row) : null;
      return json({ scan: scanView(created ? { ...row, status: "created" } : row, true), created });
    }

    // ---- Rate limit (only when we are about to spend tokens) ---------------------------------------
    const nowMs = Date.now();
    const { data: lim } = await adminDb.from("property_vision_rate_limit").select("window_start, request_count").eq("user_id", user.id).maybeSingle();
    if (lim && nowMs - new Date(lim.window_start).getTime() < RATE_LIMIT_WINDOW_MS) {
      if (lim.request_count >= RATE_LIMIT_MAX_PER_HOUR) return json({ error: "You've hit the hourly limit for photo analysis. Try again in a bit." }, 429);
      await adminDb.from("property_vision_rate_limit").update({ request_count: lim.request_count + 1 }).eq("user_id", user.id);
    } else {
      await adminDb.from("property_vision_rate_limit").upsert({ user_id: user.id, window_start: new Date(nowMs).toISOString(), request_count: 1 });
    }

    const apiKey = deps.env("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "Data-plate scanning is not configured yet (missing GEMINI_API_KEY)." }, 500);
    const model = deps.env("NAMEPLATE_MODEL") || deps.env("PROPERTY_VISION_MODEL") || deps.env("GEMINI_MODEL") || "gemini-2.5-flash";

    // Downloaded with the CALLER's client so storage RLS enforces that the photo is theirs.
    const { data: blob, error: dlErr } = await callerClient.storage.from(BUCKET).download(capture.path);
    if (dlErr || !blob) return json({ error: "Could not read the uploaded photo." }, 404);
    if (blob.size > MAX_PHOTO_BYTES) return json({ error: "The photo must be under 6MB." }, 400);

    const base = {
      user_id: ownerId, job_id: jobId, customer_id: customerId, storage_path: capture.path, sha256: capture.sha256,
      mime_type: capture.mime, byte_size: capture.bytes, created_by: user.id, model_name: model,
      prompt_version: NAMEPLATE_PROMPT_VERSION, updated_at: new Date().toISOString(),
    };
    const fail = async (message: string, status: number) => {
      await adminDb.from("equipment_nameplate_scans")
        .upsert({ ...base, status: "failed", error: message.slice(0, 300) }, { onConflict: "user_id,sha256" });
      return json({ error: message }, status);
    };

    let ai: Awaited<ReturnType<typeof callGemini>>;
    try {
      ai = await callGemini(deps.fetch, apiKey, model, [
        { text: "Data plate photo:" },
        { inline_data: { mime_type: blob.type || capture.mime, data: toBase64(new Uint8Array(await blob.arrayBuffer())) } },
      ]);
    } catch (e) {
      console.error("[nameplate-scan] vision call failed", e);
      return await fail("The AI vision service is temporarily unavailable. Your photo is saved — try again in a minute.", 502);
    }
    if (ai.finishReason === "MAX_TOKENS") return await fail("The AI response was cut off. Retake the photo closer to the plate.", 502);

    let norm: NormNameplate;
    try { norm = normalizeNameplate(extractJson(ai.text)); } catch { return await fail("The AI response could not be read. Try again.", 502); }

    const reasons = reviewReasons(norm);
    const ready = canAutoCreate(reasons);

    const { data: saved, error: saveErr } = await adminDb.from("equipment_nameplate_scans").upsert({
      ...base, status: "extracted", error: null, extracted: norm, review_reasons: reasons, auto_create_ready: ready,
      equipment_id: null, passport_id: null, input_tokens: ai.inputTokens, output_tokens: ai.outputTokens,
    }, { onConflict: "user_id,sha256" }).select("*").single();
    if (saveErr || !saved) {
      console.error("[nameplate-scan] save failed", saveErr?.message);
      return json({ error: "Could not save the scan. Please try again." }, 500);
    }

    const created = autoCreate && ready ? await autoCreateSafe(ctx, saved) : null;
    return json({ scan: scanView(created ? { ...saved, status: "created" } : saved, false), created });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("[nameplate-scan] unexpected", e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
