// Public share-link resolver (verify_jwt = false). POST { token, password?, download? }
// Returns a 2-minute signed URL for the ONE pinned document version, or a generic failure reason.
// Every outcome is written to document_access_log. Secrets never leave the database.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { TOKEN_RE, clientIp, hmacHex, pbkdf2Hex, sha256Hex, timingSafeEqualHex } from "../_shared/doc-share/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const SIGNED_URL_SECONDS = 120;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === "string" ? body.token : "";
    if (!TOKEN_RE.test(token)) return json({ error: "unavailable" }, 404);

    // deno-lint-ignore no-explicit-any
    const admin: any = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: link } = await admin.from("document_share_links")
      .select("id, user_id, document_id, version_id, password_hash, password_salt, expires_at, max_views, view_count, locked_until, revoked_at")
      .eq("token_hash", await sha256Hex(token)).maybeSingle();
    if (!link) return json({ error: "unavailable" }, 404);

    const salt = Deno.env.get("DOC_SHARE_LOG_SALT");
    const ip = clientIp(req.headers);
    const ipHash = salt && ip ? (await hmacHex(salt, ip)).slice(0, 32) : null;
    const ua = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
    const log = (action: "share_view" | "share_denied", outcome: "ok" | "denied") =>
      admin.from("document_access_log").insert({
        user_id: link.user_id, document_id: link.document_id, version_id: link.version_id, share_link_id: link.id,
        actor_kind: "share_link", action, outcome, ip_hash: ipHash, user_agent: ua,
      });
    const deny = async (reason: string, status: number) => { await log("share_denied", "denied"); return json({ error: reason }, status); };

    const now = Date.now();
    if (link.revoked_at) return await deny("revoked", 410);
    if (new Date(link.expires_at).getTime() <= now) return await deny("expired", 410);
    if (link.max_views !== null && link.view_count >= link.max_views) return await deny("limit_reached", 410);
    if (link.locked_until && new Date(link.locked_until).getTime() > now) return await deny("locked", 429);

    if (link.password_hash) {
      const password = typeof body.password === "string" ? body.password : "";
      if (password === "") return json({ error: "password_required" }, 401);
      if (password.length > 128) return await deny("wrong_password", 401);
      const attempt = await pbkdf2Hex(password, link.password_salt);
      if (!timingSafeEqualHex(attempt, link.password_hash)) {
        await admin.rpc("doc_share_fail", { p_link_id: link.id });
        return await deny("wrong_password", 401);
      }
    }

    const { data: consumed } = await admin.rpc("doc_share_consume", { p_link_id: link.id });
    if (consumed !== true) return await deny("unavailable", 410);

    const { data: ver } = await admin.from("document_versions")
      .select("storage_path, file_name, mime_type, size_bytes").eq("id", link.version_id).eq("document_id", link.document_id).maybeSingle();
    if (!ver) return json({ error: "unavailable" }, 404);
    const { data: signed, error } = await admin.storage.from("documents").createSignedUrl(
      ver.storage_path, SIGNED_URL_SECONDS, body.download === true ? { download: ver.file_name } : undefined,
    );
    if (error || !signed?.signedUrl) return json({ error: "unavailable" }, 404);

    await log("share_view", "ok");
    return json({ url: signed.signedUrl, file_name: ver.file_name, mime_type: ver.mime_type, size_bytes: ver.size_bytes, expires_at: link.expires_at });
  } catch (e) {
    console.error("doc-share error", e instanceof Error ? e.message : "unknown");
    return json({ error: "unavailable" }, 500);
  }
});
