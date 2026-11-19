// supabase/functions/mcp-oauth/index.ts
//
// OAuth 2.1 authorization server endpoints for the Vireek MCP server (public clients, PKCE S256 only).
// Deploy with --no-verify-jwt (clients are not Supabase users). Public URLs are mapped by vercel.json:
//   /.well-known/oauth-authorization-server -> /metadata      (issuer = SITE_URL, so RFC 8414 discovery works at the root)
//   /oauth/register -> /register   /oauth/token -> /token   /oauth/revoke -> /revoke
// The authorization endpoint is the SPA consent page /oauth/authorize (it runs under the owner's Supabase session and
// calls mcp_oauth_authorize_preview / mcp_oauth_authorize_decide).
//
// Hardening: 8 KB body cap; no cookies / ambient credentials (so CORS "*" is safe); errors never echo input; tokens and
// codes exist in plaintext only in transit (SHA-256 at rest); no secrets in logs.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleOAuthRequest } from "../_shared/mcp-oauth/handler.ts";

Deno.serve((req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  return handleOAuthRequest(req, { admin, siteUrl });
});
