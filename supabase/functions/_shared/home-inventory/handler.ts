// supabase/functions/_shared/home-inventory/handler.ts
//
// Request handler for the `portal-home-inventory` edge function. All I/O is injected (supabase client, env, fetch)
// so it is unit-tested without Deno, a network or a database; index.ts is the thin Deno entry point.
//
// Auth model: the CUSTOMER PORTAL TOKEN (same credential as /portal/:token). The function is deployed with
// --no-verify-jwt (supabase/config.toml) and validates the token itself through hi_resolve_customer(), which
// answers identically for "bad token" and "portal disabled". Everything below runs with the service role, so
// EVERY id it touches (path, file, item) is re-checked against the resolved customer.
//
// Actions (POST JSON, `token` always required):
//   sign_upload   validate kind/type/size -> short-lived signed upload URL into the customer's private folder
//   register      after the browser uploaded: verify real type/size from the bytes, de-duplicate by SHA-256
//                 (a repeated photo costs 0 AI tokens), OCR it, store the file row, return a form prefill
//   file_url      120-second signed URL to view one of the customer's own files
//   delete_file   remove the object from storage, then the row
//   delete_item   remove every object of the item, then the item (reminders cascade)

import { extractJson } from "../property-vision/normalize.ts";
import {
  NAMEPLATE_PROMPT_VERSION, NAMEPLATE_RESPONSE_SCHEMA, NAMEPLATE_SYSTEM_PROMPT,
} from "../property-vision/nameplate.ts";
import {
  EXT_FOR_MIME, HOME_DOC_PROMPT_VERSION, HOME_DOC_RESPONSE_SCHEMA, HOME_DOC_SYSTEM_PROMPT,
  HOME_INVENTORY_BUCKET, MAX_FILE_BYTES, isAllowedMime, isFileKind, isOwnStoragePath, normalizeHomeDocument,
  normalizeNameplate, readFromDocument, readFromLabel, readerFor, sanitizeFileName, sha256Hex, sniffMime,
  type AllowedMime, type FileKind, type StoredRead,
} from "./ocr.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3600;
const DAY = 86400;
const UPLOADS_PER_HOUR = 60;
const OCR_PER_HOUR = 25;
const OCR_PER_DAY = 80;
const MAX_FILES_PER_CUSTOMER = 400;
const SIGNED_VIEW_SECONDS = 120;
const GEMINI_TIMEOUT_MS = 40_000;

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export interface HandlerDeps {
  // deno-lint-ignore no-explicit-any
  createClient: (url: string, key: string, options?: any) => any;
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  /** Overridable for tests. */
  uuid?: () => string;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
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

interface Ctx { admin: Db; ownerId: string; customerId: string; env: HandlerDeps["env"]; fetch: typeof fetch; uuid: () => string }

/** What the browser may know about a file. Never the storage path. */
function fileView(f: Row) {
  return {
    id: f.id as string,
    item_id: (f.item_id ?? null) as string | null,
    kind: f.kind as FileKind,
    mime_type: f.mime_type as string,
    byte_size: f.byte_size as number,
    original_name: (f.original_name ?? null) as string | null,
    ocr_status: f.ocr_status as string,
    created_at: f.created_at as string,
  };
}

function readView(f: Row): StoredRead | null {
  const o = f.ocr as Row | null;
  return o && typeof o === "object" && o.suggestion ? (o as StoredRead) : null;
}

async function limit(ctx: Ctx, bucket: string, max: number, windowSeconds: number, message: string) {
  const { data, error } = await ctx.admin.rpc("hi_rate_limit_hit", {
    p_customer: ctx.customerId, p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds,
  });
  if (error) {
    // Fail closed: this guards paid AI calls and storage.
    console.error("[home-inventory] rate limiter failed", error.message);
    throw new HttpError(503, "The service is busy. Please try again in a moment.");
  }
  if (data !== true) throw new HttpError(429, message, "rate_limited");
}

async function callGemini(ctx: Ctx, model: string, system: string, schema: unknown, parts: unknown[]) {
  const apiKey = ctx.env("GEMINI_API_KEY");
  if (!apiKey) throw new HttpError(503, "Document reading is not configured yet.", "ocr_unavailable");
  const base = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }] };
  const attempts = [
    { generationConfig: { temperature: 0, maxOutputTokens: 1400, responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingBudget: 0 } } },
    // Some models reject schema/thinking options: retry once with a plain JSON-mode config.
    { generationConfig: { temperature: 0, maxOutputTokens: 1400, responseMimeType: "application/json" } },
  ];
  let lastStatus = 0;
  for (const a of attempts) {
    const res = await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ ...base, ...a }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (res.status === 400) {
      lastStatus = 400;
      console.error("[home-inventory] Gemini 400", (await res.text().catch(() => "")).slice(0, 300));
      continue;
    }
    if (!res.ok) {
      console.error("[home-inventory] Gemini error", res.status, (await res.text().catch(() => "")).slice(0, 300));
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

interface OcrOutcome {
  status: "done" | "failed" | "skipped";
  read: StoredRead | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  warning: string | null;
}

const NO_OCR: OcrOutcome = { status: "skipped", read: null, model: null, promptVersion: null, inputTokens: null, outputTokens: null, warning: null };

async function runOcr(ctx: Ctx, kind: FileKind, mime: AllowedMime, bytes: Uint8Array): Promise<OcrOutcome> {
  await limit(ctx, "ocr_hour", OCR_PER_HOUR, HOUR, "You've read a lot of documents in a short time. Try again in a little while, or add the details by hand.");
  await limit(ctx, "ocr_day", OCR_PER_DAY, DAY, "You've reached today's limit for reading documents. You can still add the details by hand.");

  const model = ctx.env("HOME_INVENTORY_MODEL") || ctx.env("NAMEPLATE_MODEL") || ctx.env("PROPERTY_VISION_MODEL") || ctx.env("GEMINI_MODEL") || "gemini-2.5-flash";
  const label = readerFor(kind) === "label";
  const parts = [
    { text: label ? "Appliance label photo:" : "Home document:" },
    { inline_data: { mime_type: mime, data: toBase64(bytes) } },
  ];
  try {
    const ai = await callGemini(
      ctx, model,
      label ? NAMEPLATE_SYSTEM_PROMPT : HOME_DOC_SYSTEM_PROMPT,
      label ? NAMEPLATE_RESPONSE_SCHEMA : HOME_DOC_RESPONSE_SCHEMA,
      parts,
    );
    if (ai.finishReason === "MAX_TOKENS") throw new Error("truncated");
    const parsed = extractJson(ai.text);
    const read = label ? readFromLabel(normalizeNameplate(parsed)) : readFromDocument(normalizeHomeDocument(parsed));
    return {
      status: "done", read, model, promptVersion: label ? NAMEPLATE_PROMPT_VERSION : HOME_DOC_PROMPT_VERSION,
      inputTokens: ai.inputTokens, outputTokens: ai.outputTokens, warning: null,
    };
  } catch (e) {
    if (e instanceof HttpError) {
      // "not configured" must not lose the upload: keep the file, tell the customer to type the details.
      if (e.code === "ocr_unavailable") return { ...NO_OCR, warning: "ocr_unavailable" };
      throw e;
    }
    console.error("[home-inventory] OCR failed", e instanceof Error ? e.message : e);
    return { ...NO_OCR, status: "failed", model, warning: "ocr_failed" };
  }
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

async function signUpload(ctx: Ctx, body: Row) {
  if (!isFileKind(body.kind)) throw new HttpError(400, "Choose what you are uploading.");
  if (!isAllowedMime(body.mime)) throw new HttpError(400, "Unsupported file type. Use a JPEG, PNG, WebP or HEIC photo, or a PDF.");
  const bytes = Number(body.bytes);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES) throw new HttpError(400, "Each file must be under 10 MB.");

  await limit(ctx, "upload_hour", UPLOADS_PER_HOUR, HOUR, "Too many uploads in a short time. Please try again in a little while.");

  const { count } = await ctx.admin.from("home_inventory_files").select("id", { count: "exact", head: true }).eq("customer_id", ctx.customerId);
  if ((count ?? 0) >= MAX_FILES_PER_CUSTOMER) throw new HttpError(409, "You've reached the file limit. Delete some files you no longer need.", "limit");

  const path = `${ctx.ownerId}/${ctx.customerId}/${ctx.uuid()}.${EXT_FOR_MIME[body.mime]}`;
  const { data, error } = await ctx.admin.storage.from(HOME_INVENTORY_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.token) {
    console.error("[home-inventory] signed upload failed", error?.message);
    throw new HttpError(502, "Could not start the upload. Please try again.");
  }
  return json({ path, upload_token: data.token });
}

async function register(ctx: Ctx, body: Row) {
  if (!isFileKind(body.kind)) throw new HttpError(400, "Choose what you are uploading.");
  const kind = body.kind;
  if (!isOwnStoragePath(body.path, ctx.ownerId, ctx.customerId)) throw new HttpError(400, "Invalid upload.");
  const path = body.path;
  const itemId = typeof body.itemId === "string" && UUID_RE.test(body.itemId) ? body.itemId : null;
  if (body.itemId && !itemId) throw new HttpError(400, "Invalid item.");

  // Idempotent: the browser may retry a register call.
  const { data: samePath } = await ctx.admin.from("home_inventory_files").select("*").eq("customer_id", ctx.customerId).eq("storage_path", path).maybeSingle();
  if (samePath) return json({ file: fileView(samePath), duplicate: false, read: readView(samePath), warning: null });

  if (itemId) {
    const { data: item } = await ctx.admin.from("home_inventory_items").select("id").eq("id", itemId).eq("customer_id", ctx.customerId).maybeSingle();
    if (!item) throw new HttpError(404, "That item no longer exists.");
  }

  const discard = async () => { await ctx.admin.storage.from(HOME_INVENTORY_BUCKET).remove([path]).catch(() => undefined); };

  const { data: blob, error: dlErr } = await ctx.admin.storage.from(HOME_INVENTORY_BUCKET).download(path);
  if (dlErr || !blob) throw new HttpError(404, "We couldn't find that upload. Please try again.");
  if (blob.size > MAX_FILE_BYTES) { await discard(); throw new HttpError(400, "Each file must be under 10 MB."); }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = sniffMime(bytes);
  // The path extension was chosen from the claimed type at sign time: the REAL type must agree with it.
  if (!mime || !path.endsWith(`.${EXT_FOR_MIME[mime]}`)) {
    await discard();
    throw new HttpError(415, "That file isn't a supported photo or PDF.");
  }
  const sha256 = await sha256Hex(bytes);

  // Same bytes already stored for this customer: reuse it (and its stored read) — zero tokens, no duplicate file.
  const { data: dup } = await ctx.admin.from("home_inventory_files").select("*").eq("customer_id", ctx.customerId).eq("sha256", sha256).maybeSingle();
  if (dup) {
    await discard();
    return json({ file: fileView(dup), duplicate: true, read: readView(dup), warning: null });
  }

  const wantOcr = body.ocr === undefined ? kind !== "appliance_photo" : body.ocr === true;
  let outcome = NO_OCR;
  if (wantOcr) {
    try {
      outcome = await runOcr(ctx, kind, mime, bytes);
    } catch (e) {
      // Rate-limited: the file is still worth keeping, only the reading is refused.
      if (e instanceof HttpError && e.code === "rate_limited") outcome = { ...NO_OCR, warning: "ocr_rate_limited" };
      else { await discard(); throw e; }
    }
  }

  const row = {
    user_id: ctx.ownerId, customer_id: ctx.customerId, item_id: itemId, kind, storage_path: path, sha256,
    mime_type: mime, byte_size: bytes.length, original_name: sanitizeFileName(body.name),
    ocr_status: outcome.status, ocr: outcome.read ?? {}, model_name: outcome.model, prompt_version: outcome.promptVersion,
    input_tokens: outcome.inputTokens, output_tokens: outcome.outputTokens,
  };
  const { data: saved, error: saveErr } = await ctx.admin.from("home_inventory_files").insert(row).select("*").single();
  if (saveErr || !saved) {
    // Lost a race with an identical upload: return the winner instead of failing.
    if (saveErr?.code === "23505") {
      const { data: winner } = await ctx.admin.from("home_inventory_files").select("*").eq("customer_id", ctx.customerId).eq("sha256", sha256).maybeSingle();
      if (winner) { await discard(); return json({ file: fileView(winner), duplicate: true, read: readView(winner), warning: null }); }
    }
    console.error("[home-inventory] save failed", saveErr?.message);
    await discard();
    throw new HttpError(500, "Could not save the file. Please try again.");
  }
  return json({ file: fileView(saved), duplicate: false, read: outcome.read, warning: outcome.warning });
}

async function ownFile(ctx: Ctx, body: Row): Promise<Row> {
  const fileId = typeof body.fileId === "string" && UUID_RE.test(body.fileId) ? body.fileId : null;
  if (!fileId) throw new HttpError(400, "Missing file.");
  const { data: f } = await ctx.admin.from("home_inventory_files").select("*").eq("id", fileId).eq("customer_id", ctx.customerId).maybeSingle();
  if (!f) throw new HttpError(404, "That file no longer exists.");
  return f;
}

async function fileUrl(ctx: Ctx, body: Row) {
  const f = await ownFile(ctx, body);
  const { data, error } = await ctx.admin.storage.from(HOME_INVENTORY_BUCKET).createSignedUrl(f.storage_path, SIGNED_VIEW_SECONDS);
  if (error || !data?.signedUrl) throw new HttpError(502, "Could not open the file. Please try again.");
  return json({ url: data.signedUrl, mime_type: f.mime_type, name: f.original_name ?? null, expires_in: SIGNED_VIEW_SECONDS });
}

async function deleteFile(ctx: Ctx, body: Row) {
  const f = await ownFile(ctx, body);
  const { error } = await ctx.admin.storage.from(HOME_INVENTORY_BUCKET).remove([f.storage_path]);
  if (error) throw new HttpError(502, "Could not delete the file. Please try again.");
  await ctx.admin.from("home_inventory_files").delete().eq("id", f.id).eq("customer_id", ctx.customerId);
  return json({ ok: true });
}

async function deleteItem(ctx: Ctx, body: Row) {
  const itemId = typeof body.itemId === "string" && UUID_RE.test(body.itemId) ? body.itemId : null;
  if (!itemId) throw new HttpError(400, "Missing item.");
  const { data: item } = await ctx.admin.from("home_inventory_items").select("id").eq("id", itemId).eq("customer_id", ctx.customerId).maybeSingle();
  if (!item) throw new HttpError(404, "That item no longer exists.");

  const { data: files } = await ctx.admin.from("home_inventory_files").select("storage_path").eq("item_id", itemId).eq("customer_id", ctx.customerId);
  const paths = ((files ?? []) as Row[]).map((f) => f.storage_path as string);
  if (paths.length > 0) {
    // Privacy: the objects must really be gone before the item is. On failure nothing is deleted, so it can be retried.
    const { error } = await ctx.admin.storage.from(HOME_INVENTORY_BUCKET).remove(paths);
    if (error) throw new HttpError(502, "Could not delete the item's files. Please try again.");
  }
  await ctx.admin.from("home_inventory_items").delete().eq("id", itemId).eq("customer_id", ctx.customerId);
  return json({ ok: true, deleted_files: paths.length });
}

// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function handleHomeInventoryRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    let body: Row;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "Invalid request." }, 400);

    const token = typeof body.token === "string" && UUID_RE.test(body.token) ? body.token : null;
    if (!token) return json({ error: "This link isn't valid.", code: "unavailable" }, 404);

    const admin: Db = deps.createClient(deps.env("SUPABASE_URL") ?? "", deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: rows, error: ctxErr } = await admin.rpc("hi_resolve_customer", { p_token: token });
    if (ctxErr) {
      console.error("[home-inventory] resolve failed", ctxErr.message);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
    const found = (Array.isArray(rows) ? rows[0] : rows) as Row | undefined;
    if (!found?.customer_id || !found?.owner_id) return json({ error: "This link isn't valid, or the portal is turned off.", code: "unavailable" }, 404);

    const ctx: Ctx = {
      admin, ownerId: found.owner_id as string, customerId: found.customer_id as string,
      env: deps.env, fetch: deps.fetch, uuid: deps.uuid ?? (() => crypto.randomUUID()),
    };

    switch (body.action) {
      case "sign_upload": return await signUpload(ctx, body);
      case "register": return await register(ctx, body);
      case "file_url": return await fileUrl(ctx, body);
      case "delete_file": return await deleteFile(ctx, body);
      case "delete_item": return await deleteItem(ctx, body);
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
    console.error("[home-inventory] unexpected", e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
