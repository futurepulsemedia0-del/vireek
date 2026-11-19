// supabase/functions/_shared/mcp-oauth/handler.ts
//
// Request handling for the mcp-oauth edge function, kept free of Deno globals so it can be unit-tested.
// See supabase/functions/mcp-oauth/index.ts for deployment notes and the endpoint map.

import {
  ACCESS_PREFIX, authorizationServerMetadata, canonicalResource, newOpaqueToken, REFRESH_PREFIX, sha256Hex, validateRegistration, verifyPkceS256,
} from "./core.ts";

const MAX_BODY = 8 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status, NO_STORE);

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}
const hex16 = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");

export interface RpcClient { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { code?: string; message?: string } | null }> }

export async function handleOAuthRequest(req: Request, deps: { admin: RpcClient; siteUrl: string }): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const { admin, siteUrl } = deps;
  const path = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?mcp-oauth/, "").replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/metadata") {
    return json(authorizationServerMetadata({
      issuer: siteUrl, authorizationEndpoint: `${siteUrl}/oauth/authorize`, tokenEndpoint: `${siteUrl}/oauth/token`,
      registrationEndpoint: `${siteUrl}/oauth/register`, revocationEndpoint: `${siteUrl}/oauth/revoke`,
    }), 200, { "Cache-Control": "public, max-age=300" });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST, OPTIONS" });

  const raw = await readBody(req);
  if (raw === null) return oauthError("invalid_request", "Request too large.", 413);

  // ------------------------------------------------------------ RFC 7591 dynamic client registration (public clients)
  if (path === "/register") {
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return oauthError("invalid_client_metadata", "Body must be JSON."); }
    const v = validateRegistration(body);
    if (!v.ok) return oauthError(v.error, v.description);
    const clientId = `vrk_oc_${hex16()}`;
    const { error } = await admin.rpc("mcp_oauth_register_client", { p_client_id: clientId, p_name: v.clientName, p_redirect_uris: v.redirectUris });
    if (error) return error.code === "54000" ? oauthError("temporarily_unavailable", "Registration is rate limited.", 429) : json({ error: "server_error" }, 500);
    return json({
      client_id: clientId, client_name: v.clientName, redirect_uris: v.redirectUris, token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_id_issued_at: Math.floor(Date.now() / 1000),
    }, 201, NO_STORE);
  }

  const form = new URLSearchParams(raw);
  const clientId = form.get("client_id") ?? "";
  if (!/^vrk_oc_[0-9a-f]{32}$/.test(clientId)) return oauthError("invalid_client", "Unknown client.", 401);

  // ------------------------------------------------------------ RFC 7009 revocation (always 200)
  if (path === "/revoke") {
    const token = form.get("token") ?? "";
    if (token.length > 0 && token.length <= 200) await admin.rpc("mcp_oauth_revoke", { p_client_id: clientId, p_token_hash: await sha256Hex(token) });
    return new Response(null, { status: 200, headers: { ...CORS, ...NO_STORE } });
  }

  if (path !== "/token") return json({ error: "not_found" }, 404);

  const grantType = form.get("grant_type");
  const accessToken = newOpaqueToken(ACCESS_PREFIX);
  const refreshToken = newOpaqueToken(REFRESH_PREFIX);
  const [accessHash, refreshHash] = [await sha256Hex(accessToken), await sha256Hex(refreshToken)];
  const respond = (r: { scopes: string[]; expires_in: number }) =>
    json({ access_token: accessToken, token_type: "Bearer", expires_in: r.expires_in, refresh_token: refreshToken, scope: r.scopes.join(" ") }, 200, NO_STORE);

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "", redirectUri = form.get("redirect_uri") ?? "", verifier = form.get("code_verifier") ?? "";
    if (!code || code.length > 200 || !redirectUri || !verifier) return oauthError("invalid_request", "code, redirect_uri and code_verifier are required.");
    const { data: c, error } = await admin.rpc("mcp_oauth_code_consume", { p_code_hash: await sha256Hex(code), p_client_id: clientId, p_redirect_uri: redirectUri });
    if (error) return json({ error: "server_error" }, 500);
    if (!c?.ok) return oauthError("invalid_grant", "The authorization code is invalid, expired or already used.");
    if (!(await verifyPkceS256(verifier, c.challenge))) return oauthError("invalid_grant", "PKCE verification failed.");
    const requested = form.get("resource");
    if (requested !== null && canonicalResource(requested) !== canonicalResource(c.resource)) return oauthError("invalid_target", "resource does not match the authorization request.");
    const { data: g, error: gErr } = await admin.rpc("mcp_oauth_issue_grant", { p_code_hash: await sha256Hex(code), p_access_hash: accessHash, p_refresh_hash: refreshHash });
    if (gErr) return json({ error: "server_error" }, 500);
    if (!g?.ok) return oauthError("invalid_grant", "The authorization code is invalid, expired or already used.");
    return respond(g);
  }

  if (grantType === "refresh_token") {
    const presented = form.get("refresh_token") ?? "";
    if (!presented || presented.length > 200) return oauthError("invalid_request", "refresh_token is required.");
    const { data: r, error } = await admin.rpc("mcp_oauth_refresh", {
      p_client_id: clientId, p_refresh_hash: await sha256Hex(presented), p_new_refresh_hash: refreshHash, p_new_access_hash: accessHash,
    });
    if (error) return json({ error: "server_error" }, 500);
    if (!r?.ok) return oauthError("invalid_grant", "The refresh token is invalid, expired or revoked.");
    const requested = form.get("resource");
    if (requested !== null && canonicalResource(requested) !== canonicalResource(r.resource)) {
      await admin.rpc("mcp_oauth_revoke", { p_client_id: clientId, p_token_hash: accessHash });   // do not leave a token the caller cannot use
      return oauthError("invalid_target", "resource does not match the grant.");
    }
    return respond(r);
  }

  return oauthError("unsupported_grant_type", "Supported grant types: authorization_code, refresh_token.");
}
