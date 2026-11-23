// supabase/functions/winback-unsubscribe/index.ts
//
// Public unsubscribe endpoint for the win-back sequence (no JWT; the unguessable per-case token is the credential).
//   POST ?t=<token>                  RFC 8058 one-click body "List-Unsubscribe=One-Click"  -> unsubscribes
//   POST {token, action:"lookup"}      -> {company, already} for the confirm page (never an email address)
//   POST {token, action:"unsubscribe"} -> unsubscribes (called by /winback/unsubscribe/:token)
//   GET  ?t=<token>                    -> 302 to the confirm page (link scanners that GET can't unsubscribe anyone)
//
// Unsubscribing is idempotent and cancels every unsent message of the case in the same transaction.
// Deploy: supabase functions deploy winback-unsubscribe --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const url = new URL(req.url);
  const site = (Deno.env.get("SITE_URL") ?? "https://vireek.com").replace(/\/$/, "");

  if (req.method === "GET") {
    const t = url.searchParams.get("t") ?? "";
    return new Response(null, { status: 302, headers: { Location: UUID_RE.test(t) ? `${site}/winback/unsubscribe/${t}` : site } });
  }
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  let token = url.searchParams.get("t") ?? "";
  let action = "unsubscribe"; // the one-click POST carries the token in the query string
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    token = String(body?.token ?? token);
    action = String(body?.action ?? "unsubscribe");
  }
  if (!UUID_RE.test(token)) return json({ success: false, error: "invalid_link" }, 400);
  if (action !== "lookup" && action !== "unsubscribe") return json({ success: false, error: "invalid_request" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    if (action === "lookup") {
      const { data, error } = await admin.rpc("winback_unsubscribe_lookup", { p_token: token });
      if (error) throw error;
      if (!data) return json({ success: false, error: "invalid_link" }, 404);
      return json({ success: true, ...(data as Record<string, unknown>) });
    }
    const { data, error } = await admin.rpc("winback_unsubscribe", { p_token: token });
    if (error) throw error;
    if (data !== true) return json({ success: false, error: "invalid_link" }, 404);
    return json({ success: true });
  } catch (err) {
    console.error(JSON.stringify({ event: "winback_unsubscribe_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ success: false, error: "server_error" }, 500);
  }
});
