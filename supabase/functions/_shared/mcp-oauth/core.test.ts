import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata, canonicalResource, DEFAULT_SCOPES, isCodeChallenge, newOpaqueToken, parseScopeParam, protectedResourceMetadata,
  redirectWithParams, resourceMatches, validateRedirectUri, validateRegistration, verifyPkceS256, wwwAuthenticate, OAUTH_SCOPES, HIGH_RISK_SCOPES, sha256Hex,
} from "./core.ts";

describe("scopes", () => {
  it("parses known scopes in canonical order, drops duplicates, reports unknown (offline_access is ignored)", () => {
    expect(parseScopeParam("jobs:read customers:read jobs:read admin:all offline_access")).toEqual({ scopes: ["customers:read", "jobs:read"], unknown: ["admin:all"] });
    expect(parseScopeParam(undefined)).toEqual({ scopes: [], unknown: [] });
  });
  it("default scopes are read-only and a subset of all scopes", () => {
    for (const s of DEFAULT_SCOPES) { expect(s.endsWith(":read")).toBe(true); expect((OAUTH_SCOPES as readonly string[]).includes(s)).toBe(true); }
    for (const s of HIGH_RISK_SCOPES) expect(DEFAULT_SCOPES.includes(s)).toBe(false);
  });
});

describe("validateRedirectUri", () => {
  it.each([
    ["https://app.example.com/cb"], ["http://127.0.0.1:8123/cb"], ["http://localhost/cb"], ["http://[::1]:9/cb"], ["cursor://anysphere.cursor-mcp/oauth/callback"], ["com.example.app:/cb"],
  ])("accepts %s", (u) => { expect(validateRedirectUri(u).ok).toBe(true); });
  it.each([
    ["http://evil.example.com/cb"], ["javascript:alert(1)"], ["data:text/html,x"], ["file:///etc/passwd"], ["https://a.com/cb#frag"], ["https://user:pw@a.com/cb"],
    ["https://a.com/*"], ["https://a.com/ cb"], [""], ["not a url"], ["https://a.com/" + "x".repeat(600)], ["ftp://a.com/cb"],
  ])("rejects %s", (u) => { expect(validateRedirectUri(u).ok).toBe(false); });
  it("rejects non-strings", () => { expect(validateRedirectUri(5).ok).toBe(false); });
});

describe("canonicalResource / resourceMatches", () => {
  it("normalises case and trailing slash, rejects fragment, query and non-https", () => {
    expect(canonicalResource("HTTPS://P.supabase.co/functions/v1/mcp-server/")).toBe("https://p.supabase.co/functions/v1/mcp-server");
    for (const bad of ["https://a.com/x#f", "https://a.com/x?y=1", "http://a.com/x", "a.com/x", 5]) expect(canonicalResource(bad as unknown)).toBeNull();
    expect(canonicalResource("http://localhost:54321/functions/v1/mcp-server")).toBe("http://localhost:54321/functions/v1/mcp-server");
  });
  const root = "https://p.supabase.co/functions/v1/mcp-server";
  it("matches the root and /mcp, nothing else (audience binding)", () => {
    expect(resourceMatches(root, root)).toBe(true);
    expect(resourceMatches(`${root}/mcp`, root)).toBe(true);
    expect(resourceMatches(`${root}/a2a`, root)).toBe(false);
    expect(resourceMatches("https://evil.example.com/functions/v1/mcp-server", root)).toBe(false);
    expect(resourceMatches(null, root)).toBe(false);
  });
});

describe("PKCE S256", () => {
  // RFC 7636 appendix B test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  it("verifies the RFC 7636 vector and rejects tampering", async () => {
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256(verifier + "x", challenge)).toBe(false);
    expect(await verifyPkceS256("short", challenge)).toBe(false);
    expect(await verifyPkceS256(verifier, "bad")).toBe(false);
    expect(await verifyPkceS256(undefined, undefined)).toBe(false);
  });
  it("challenge format check", () => { expect(isCodeChallenge(challenge)).toBe(true); expect(isCodeChallenge(challenge + "=")).toBe(false); });
});

describe("tokens", () => {
  it("are prefixed, unique and long", async () => {
    const a = newOpaqueToken("vrk_oat_"), b = newOpaqueToken("vrk_oat_");
    expect(a.startsWith("vrk_oat_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(48);
    expect((await sha256Hex(a))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("validateRegistration", () => {
  const ok = { client_name: "  My\u202E Agent ", redirect_uris: ["https://a.com/cb", "https://a.com/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] };
  it("normalises name and de-duplicates redirect URIs", () => {
    const r = validateRegistration(ok);
    expect(r).toEqual({ ok: true, clientName: "My Agent", redirectUris: ["https://a.com/cb"] });
  });
  it("rejects confidential clients, bad grants, bad URIs, too many URIs and non-objects", () => {
    for (const body of [
      { ...ok, token_endpoint_auth_method: "client_secret_basic" }, { ...ok, grant_types: ["password"] }, { ...ok, response_types: ["token"] },
      { ...ok, redirect_uris: ["http://evil.com/cb"] }, { ...ok, redirect_uris: [] }, { ...ok, redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.com/${i}`) },
      { redirect_uris: ["https://a.com/cb"] }, [], null, "x",
    ]) expect(validateRegistration(body).ok).toBe(false);
  });
  it("uses the RFC 7591 error codes", () => {
    const r = validateRegistration({ ...ok, redirect_uris: ["javascript:x"] });
    expect(r.ok === false && r.error).toBe("invalid_redirect_uri");
  });
});

describe("metadata and challenges", () => {
  it("protected resource metadata names the authorization server and header-only bearer", () => {
    const m = protectedResourceMetadata("https://p/mcp-server", "https://p/mcp-oauth");
    expect(m.authorization_servers).toEqual(["https://p/mcp-oauth"]);
    expect(m.bearer_methods_supported).toEqual(["header"]);
    expect(m.scopes_supported).toHaveLength(9);
  });
  it("authorization server metadata advertises S256 only, public clients and iss", () => {
    const m = authorizationServerMetadata({ issuer: "https://p/mcp-oauth", authorizationEndpoint: "https://app/oauth/authorize", tokenEndpoint: "https://p/mcp-oauth/token", registrationEndpoint: "https://p/mcp-oauth/register", revocationEndpoint: "https://p/mcp-oauth/revoke" });
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });
  it("builds RFC 6750 challenges and strips quote/CRLF injection", () => {
    expect(wwwAuthenticate({ resourceMetadataUrl: "https://p/.well-known/oauth-protected-resource" })).toBe('Bearer realm="vireek-agent-network", resource_metadata="https://p/.well-known/oauth-protected-resource"');
    const h = wwwAuthenticate({ resourceMetadataUrl: "https://p/m", error: "insufficient_scope", scope: ["jobs:read", 'x"\r\ny'], description: 'a"b\r\nc' });
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="jobs:read x y"');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain('error_description="ab c"');
  });
  it("redirectWithParams encodes values and keeps existing query", () => {
    expect(redirectWithParams("https://a.com/cb?x=1", { code: "c", state: "a b&c", iss: "https://i", skip: undefined })).toBe("https://a.com/cb?x=1&code=c&state=a+b%26c&iss=https%3A%2F%2Fi");
  });
});
