// supabase/functions/fm-ingest-pdf/index.ts
//
// POST application/pdf (raw body) from the signed-in manager of a Work-Order Guard account.
// Validates -> stores the ORIGINAL in the private bucket -> extracts text -> sanitizes -> records an intake item.
// It never writes work orders: the app parses the sanitized text and the manager confirms the import.
//
// Auth   : caller's JWT (anon-key client). Owner + manager check = RPC wog_require_manager().
//          Service role is used only for storage upload and the service-only wog_ingest_store RPC.
// Headers: X-File-Name (optional, sanitized).
// Extraction uses npm:unpdf (pdf.js build for serverless runtimes). [VERIFY] package name/version and that it
// loads in your Supabase Edge runtime before relying on it; if it does not load, items are stored as
// "needs_ocr" with the original kept, and nothing else breaks.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { inspectPdf, joinPdfTextItems, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MIN_TEXT_CHARS } from "../_shared/fm-ingest/pdf.ts";
import { sanitizeFileName, sanitizeInboundText, sha256Hex } from "../_shared/fm-ingest/sanitize.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-File-Name",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
const BUCKET = "fm-ingest-originals";
const EXTRACT_TIMEOUT_MS = 15_000;

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function extractText(bytes: Uint8Array): Promise<{ text: string; pages: number } | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const mod: any = await import("npm:unpdf");
    const run = async () => {
      const pdf = await mod.getDocumentProxy(new Uint8Array(bytes));
      const pages = Math.min(pdf.numPages as number, PDF_MAX_PAGES);
      const parts: string[] = [];
      for (let p = 1; p <= pages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        parts.push(joinPdfTextItems(content.items));
      }
      return { text: parts.join("\n\n"), pages: pdf.numPages as number };
    };
    return await Promise.race([run(), new Promise<null>((r) => setTimeout(() => r(null), EXTRACT_TIMEOUT_MS))]);
  } catch (e) {
    console.error(JSON.stringify({ event: "fm_pdf_extract_failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization") ?? "";
  if (!url || !anon || !service) return json({ error: "server_not_configured" }, 500);
  if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: ownerId, error: authErr } = await userClient.rpc("wog_require_manager");
  if (authErr || !ownerId) return json({ error: "forbidden" }, authErr?.code === "42501" ? 403 : 401);
  const { data: u } = await userClient.auth.getUser();
  const actor = u?.user?.id ?? null;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > PDF_MAX_BYTES) return json({ error: "too_large" }, 413);
  const bytes = await readCapped(req, PDF_MAX_BYTES);
  if (bytes === null) return json({ error: "too_large" }, 413);

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const sha = await sha256Hex(bytes);
  const name = sanitizeFileName(req.headers.get("x-file-name"), "work-order.pdf");
  const store = async (p: Record<string, unknown>) => {
    const { data, error } = await admin.rpc("wog_ingest_store", { p_owner: ownerId, p_actor: actor, p: { channel: "pdf", content_sha256: sha, original_name: name, original_bytes: bytes.length, ...p } });
    return { data: data as { ok: boolean; id?: string; duplicate?: boolean; status?: string; reason?: string } | null, error };
  };
  const failStore = (reason?: string) => reason === "rate_limited" ? json({ error: "rate_limited" }, 429) : reason === "quota" ? json({ error: "quota" }, 409) : json({ error: "store_failed" }, 500);

  const verdict = inspectPdf(bytes);
  if (!verdict.ok) {
    if (verdict.code !== "empty") await store({ status: "rejected", reject_code: verdict.code }); // evidence of the attempt; original NOT kept
    return json({ error: verdict.code, message: verdict.message }, 422);
  }

  const extracted = await extractText(bytes);
  const cleaned = extracted ? sanitizeInboundText(extracted.text, { html: false }) : null;
  const usable = !!cleaned && cleaned.text.replace(/\s/g, "").length >= PDF_MIN_TEXT_CHARS;
  const id = crypto.randomUUID();
  const path = `${ownerId}/${id}.pdf`;

  const { data: stored, error } = await store({
    id, status: usable ? "ready" : "needs_ocr", original_path: path, text_content: usable ? cleaned!.text : null,
    text_truncated: cleaned?.truncated ?? false, page_count: extracted?.pages ?? null, sanitize_stats: cleaned?.stats ?? {},
  });
  if (error || !stored?.ok) return failStore(stored?.reason);
  if (stored.duplicate) return json({ id: stored.id, status: stored.status, duplicate: true });

  const up = await admin.storage.from(BUCKET).upload(path, new Blob([bytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
  if (up.error) {
    await admin.rpc("wog_ingest_discard", { p_owner: ownerId, p_id: id });
    return json({ error: "storage_failed" }, 502);
  }
  return json({ id, status: usable ? "ready" : "needs_ocr", duplicate: false });
});
