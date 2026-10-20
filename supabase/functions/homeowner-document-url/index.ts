// supabase/functions/homeowner-document-url/index.ts
// Returns a short-lived signed URL for a document a business shared with the
// caller. Access is decided by homeowner_get_document_path (link + scope +
// document ownership), evaluated with the CALLER's JWT.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_SECONDS = 120;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return reply(401, { error: "Missing Authorization header." });

  let body: { link_id?: unknown; document_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Invalid request body." });
  }
  const linkId = typeof body.link_id === "string" ? body.link_id : "";
  const documentId = typeof body.document_id === "string" ? body.document_id : "";
  if (!UUID_RX.test(linkId) || !UUID_RX.test(documentId)) return reply(400, { error: "Invalid request." });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return reply(401, { error: "Not authenticated." });

  const { data, error } = await db.rpc("homeowner_get_document_path", {
    p_link_id: linkId,
    p_document_id: documentId,
  });
  if (error || !data?.storage_path) return reply(403, { error: "This document isn't available to you." });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const signed = await admin.storage
    .from("documents")
    .createSignedUrl(data.storage_path, TTL_SECONDS, { download: data.file_name ?? true });
  if (signed.error || !signed.data?.signedUrl) return reply(502, { error: "Couldn't open the document." });

  return reply(200, { url: signed.data.signedUrl, file_name: data.file_name, expires_in: TTL_SECONDS });
});
