import { describe, expect, it } from "vitest";
import { handleOAuthRequest } from "./handler.ts";
import { base64url, sha256Hex } from "./core.ts";

// In-memory stand-in for the mcp_oauth_* RPC contracts (NOT the SQL: it checks the HTTP layer and the protocol flow).
function fakeDb() {
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; scopes: string[]; resource: string; used: boolean; expired?: boolean; grant?: string }>();
  const grants = new Map<string, { client_id: string; refresh: string; prev: string | null; scopes: string[]; resource: string; revoked: boolean }>();
  const tokens = new Map<string, string>();
  const calls: string[] = [];
  const revoke = (id: string) => { const g = grants.get(id); if (g) { g.revoked = true; for (const [h, gid] of tokens) if (gid === id) tokens.delete(h); } };
  const db = {
    clients, codes, grants, tokens, calls,
    async rpc(fn: string, a: any) {
      calls.push(fn);
      if (fn === "mcp_oauth_register_client") { clients.set(a.p_client_id, { redirect_uris: a.p_redirect_uris }); return { data: a.p_client_id, error: null }; }
      if (fn === "mcp_oauth_code_consume") {
        const k = codes.get(a.p_code_hash);
        if (!k) return { data: { ok: false }, error: null };
        if (k.used) { if (k.grant) revoke(k.grant); return { data: { ok: false }, error: null }; }
        k.used = true;
        if (k.expired || k.client_id !== a.p_client_id || k.redirect_uri !== a.p_redirect_uri) return { data: { ok: false }, error: null };
        return { data: { ok: true, challenge: k.challenge, scopes: k.scopes, resource: k.resource }, error: null };
      }
      if (fn === "mcp_oauth_issue_grant") {
        const k = codes.get(a.p_code_hash)!; const id = crypto.randomUUID();
        grants.set(id, { client_id: k.client_id, refresh: a.p_refresh_hash, prev: null, scopes: k.scopes, resource: k.resource, revoked: false });
        tokens.set(a.p_access_hash, id); k.grant = id;
        return { data: { ok: true, scopes: k.scopes, resource: k.resource, expires_in: 3600 }, error: null };
      }
      if (fn === "mcp_oauth_refresh") {
        const hit = [...grants.entries()].find(([, g]) => g.refresh === a.p_refresh_hash || g.prev === a.p_refresh_hash);
        if (!hit || hit[1].client_id !== a.p_client_id) return { data: { ok: false }, error: null };
        const [id, g] = hit;
        if (g.refresh !== a.p_refresh_hash) { revoke(id); return { data: { ok: false, reuse: true }, error: null }; }
        if (g.revoked) return { data: { ok: false }, error: null };
        g.prev = g.refresh; g.refresh = a.p_new_refresh_hash;
        for (const [h, gid] of tokens) if (gid === id) tokens.delete(h);
        tokens.set(a.p_new_access_hash, id);
        return { data: { ok: true, scopes: g.scopes, resource: g.resource, expires_in: 3600 }, error: null };
      }
      if (fn === "mcp_oauth_revoke") {
        const hit = [...grants.entries()].find(([, g]) => g.client_id === a.p_client_id && (g.refresh === a.p_token_hash || g.prev === a.p_token_hash)) ?? (tokens.has(a.p_token_hash) ? [tokens.get(a.p_token_hash)!] : undefined);
        if (hit) revoke(hit[0] as string);
        return { data: null, error: null };
      }
      return { data: null, error: { message: "unknown rpc" } };
    },
  };
  return db;
}

const SITE = "https://vireek.com";
const RES = "https://p.supabase.co/functions/v1/mcp-server/mcp";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const req = (path: string, init: RequestInit & { form?: Record<string, string> } = {}) => {
  const { form, ...rest } = init;
  return new Request(`https://x.supabase.co/functions/v1/mcp-oauth${path}`, form
    ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), ...rest }
    : rest);
};

async function setup() {
  const db = fakeDb();
  const call = (r: Request) => handleOAuthRequest(r, { admin: db, siteUrl: SITE });
  const reg = await call(req("/register", { method: "POST", body: JSON.stringify({ client_name: "Test Agent", redirect_uris: ["http://127.0.0.1:7777/cb"], token_endpoint_auth_method: "none" }) }));
  const { client_id } = await reg.json();
  // what the consent RPC does on approval:
  const issueCode = async (over: Record<string, unknown> = {}) => {
    const code = "code-" + crypto.randomUUID();
    db.codes.set(await sha256Hex(code), { client_id, redirect_uri: "http://127.0.0.1:7777/cb", challenge: CHALLENGE, scopes: ["jobs:read"], resource: RES, used: false, ...over } as any);
    return code;
  };
  const exchange = async (code: string, extra: Record<string, string> = {}) =>
    call(req("/token", { form: { grant_type: "authorization_code", client_id, code, redirect_uri: "http://127.0.0.1:7777/cb", code_verifier: VERIFIER, resource: RES, ...extra } }));
  return { db, call, client_id, issueCode, exchange };
}

describe("metadata", () => {
  it("serves RFC 8414 metadata with the SITE_URL issuer, S256 only and public cache headers", async () => {
    const { call } = await setup();
    const res = await call(req("/metadata"));
    const m = await res.json();
    expect(res.status).toBe(200);
    expect(m.issuer).toBe(SITE);
    expect(m.token_endpoint).toBe(`${SITE}/oauth/token`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
  it("answers CORS preflight", async () => {
    const { call } = await setup();
    expect((await call(req("/token", { method: "OPTIONS" }))).status).toBe(204);
  });
});

describe("registration", () => {
  it("rejects unsafe redirect URIs and confidential clients with RFC 7591 errors", async () => {
    const { call } = await setup();
    const bad = await call(req("/register", { method: "POST", body: JSON.stringify({ client_name: "x", redirect_uris: ["http://evil.com/cb"] }) }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
    const conf = await call(req("/register", { method: "POST", body: JSON.stringify({ client_name: "x", redirect_uris: ["https://a.com/cb"], token_endpoint_auth_method: "client_secret_post" }) }));
    expect((await conf.json()).error).toBe("invalid_client_metadata");
    expect((await call(req("/register", { method: "POST", body: "not json" }))).status).toBe(400);
  });
  it("rejects oversized bodies", async () => {
    const { call } = await setup();
    const res = await call(req("/register", { method: "POST", body: "x".repeat(9000) }));
    expect(res.status).toBe(413);
  });
});

describe("authorization_code grant", () => {
  it("issues access + refresh tokens for a valid code and PKCE verifier, with no-store", async () => {
    const { issueCode, exchange, db } = await setup();
    const res = await exchange(await issueCode());
    const t = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(t.token_type).toBe("Bearer");
    expect(t.access_token.startsWith("vrk_oat_")).toBe(true);
    expect(t.refresh_token.startsWith("vrk_ort_")).toBe(true);
    expect(t.scope).toBe("jobs:read");
    expect(t.expires_in).toBe(3600);
    expect(db.tokens.has(await sha256Hex(t.access_token))).toBe(true);          // only hashes are stored
    expect([...db.tokens.keys()].every((k) => !k.startsWith("vrk_"))).toBe(true);
  });
  it("rejects a wrong PKCE verifier and burns the code", async () => {
    const { issueCode, exchange } = await setup();
    const code = await issueCode();
    const bad = await exchange(code, { code_verifier: base64url(new Uint8Array(32).fill(7)) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");
    expect((await exchange(code)).status).toBe(400);                              // even the right verifier now fails
  });
  it("rejects a replayed code and revokes the grant it produced", async () => {
    const { issueCode, exchange, db } = await setup();
    const code = await issueCode();
    const first = await (await exchange(code)).json();
    const replay = await exchange(code);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect(db.tokens.has(await sha256Hex(first.access_token))).toBe(false);
    expect([...db.grants.values()][0].revoked).toBe(true);
  });
  it("rejects redirect_uri mismatch, expired codes, another client's code, and a different resource", async () => {
    const { issueCode, exchange, client_id } = await setup();
    expect((await (await exchange(await issueCode(), { redirect_uri: "http://127.0.0.1:7777/other" })).json()).error).toBe("invalid_grant");
    expect((await (await exchange(await issueCode({ expired: true }))).json()).error).toBe("invalid_grant");
    expect((await (await exchange(await issueCode({ client_id: "vrk_oc_" + "0".repeat(32) }))).json()).error).toBe("invalid_grant");
    const r = await exchange(await issueCode(), { resource: "https://evil.example.com/mcp" });
    expect((await r.json()).error).toBe("invalid_target");
    expect(client_id.startsWith("vrk_oc_")).toBe(true);
  });
  it("requires code, redirect_uri and code_verifier; rejects unknown clients and grant types", async () => {
    const { call, client_id } = await setup();
    expect((await (await call(req("/token", { form: { grant_type: "authorization_code", client_id } }))).json()).error).toBe("invalid_request");
    const unknown = await call(req("/token", { form: { grant_type: "authorization_code", client_id: "nope" } }));
    expect(unknown.status).toBe(401);
    expect((await (await call(req("/token", { form: { grant_type: "password", client_id } }))).json()).error).toBe("unsupported_grant_type");
  });
});

describe("refresh_token grant", () => {
  it("rotates the refresh token, replaces the access token, and detects reuse of the old one", async () => {
    const { issueCode, exchange, call, client_id, db } = await setup();
    const t1 = await (await exchange(await issueCode())).json();
    const r = await call(req("/token", { form: { grant_type: "refresh_token", client_id, refresh_token: t1.refresh_token } }));
    const t2 = await r.json();
    expect(r.status).toBe(200);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(db.tokens.has(await sha256Hex(t1.access_token))).toBe(false);
    expect(db.tokens.has(await sha256Hex(t2.access_token))).toBe(true);
    // attacker replays the rotated-away token: family is revoked, including the legitimate new token
    const replay = await call(req("/token", { form: { grant_type: "refresh_token", client_id, refresh_token: t1.refresh_token } }));
    expect(replay.status).toBe(400);
    expect(db.tokens.has(await sha256Hex(t2.access_token))).toBe(false);
    const after = await call(req("/token", { form: { grant_type: "refresh_token", client_id, refresh_token: t2.refresh_token } }));
    expect((await after.json()).error).toBe("invalid_grant");
  });
  it("refuses a refresh token presented by a different client", async () => {
    const { issueCode, exchange, call } = await setup();
    const t = await (await exchange(await issueCode())).json();
    const other = await call(req("/token", { form: { grant_type: "refresh_token", client_id: "vrk_oc_" + "a".repeat(32), refresh_token: t.refresh_token } }));
    expect((await other.json()).error).toBe("invalid_grant");
  });
});

describe("revocation", () => {
  it("revokes by refresh or access token, always answers 200", async () => {
    const { issueCode, exchange, call, client_id, db } = await setup();
    const t = await (await exchange(await issueCode())).json();
    expect((await call(req("/revoke", { form: { client_id, token: "garbage" } }))).status).toBe(200);
    expect([...db.grants.values()][0].revoked).toBe(false);
    expect((await call(req("/revoke", { form: { client_id, token: t.refresh_token } }))).status).toBe(200);
    expect([...db.grants.values()][0].revoked).toBe(true);
    expect(db.tokens.size).toBe(0);
  });
});
