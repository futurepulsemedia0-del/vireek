import { describe, expect, it } from "vitest";
import { checkSharedSecret, constantTimeEqual, corsHeadersFor, HttpError, redact, readJsonBody, validate } from "./core.ts";
import { hmacSha256, verifyWebhook, type ReplayStore } from "./webhook.ts";
import { assertPublicEndpointSafe, jwtAuth, publicAuth, secure, sharedSecretAuth, webhookAuth } from "./secure.ts";
import type { RateLimiter } from "./rateLimit.ts";

const req = (init: RequestInit & { url?: string } = {}) => new Request(init.url ?? "https://fn.test/x", { method: "POST", ...init });
const lines: string[] = [];
const base = { log: (l: string) => lines.push(l) };
const okHandler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("core", () => {
  it("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("checkSharedSecret fails CLOSED when the secret is unset or empty", () => {
    expect(checkSharedSecret(undefined, "x")).toBe(false);
    expect(checkSharedSecret("", "")).toBe(false);
    expect(checkSharedSecret("s", null)).toBe(false);
    expect(checkSharedSecret("s", "s")).toBe(true);
  });
  it("CORS: allowlisted origin echoed, others get no ACAO, never *", () => {
    const o = { allowedOrigins: ["https://app.vireek.com"] };
    expect(corsHeadersFor(req({ headers: { origin: "https://app.vireek.com" } }), o)["Access-Control-Allow-Origin"]).toBe("https://app.vireek.com");
    expect(corsHeadersFor(req({ headers: { origin: "https://evil.test" } }), o)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeadersFor(req(), o)["Access-Control-Allow-Origin"]).toBeUndefined();
  });
  it("redact removes PII keys and scrubs emails/phones in free text", () => {
    const r = redact({ email: "a@b.com", note: "call +1 415 555 0100 or mail jo@x.io", nested: { token: "t" }, ok: 1 }) as Record<string, unknown>;
    expect(r.email).toBe("[redacted]");
    expect(r.note).toBe("call [number] or mail [email]");
    expect((r.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(r.ok).toBe(1);
  });
  it("readJsonBody enforces the size limit and JSON validity", async () => {
    await expect(readJsonBody(req({ body: "x".repeat(50) }), 10)).rejects.toThrow("Payload too large");
    await expect(readJsonBody(req({ body: "{bad" }), 100)).rejects.toThrow("valid JSON");
  });
  it("validate maps parser failures to a 422 HttpError", () => {
    const parser = { safeParse: (i: unknown) => (typeof i === "string" ? { success: true as const, data: i } : { success: false as const, error: { issues: [{ path: ["a"], message: "bad" }] } }) };
    expect(validate(parser, "x")).toBe("x");
    expect(() => validate(parser, 1)).toThrow("validation failed");
  });
});

describe("verifyWebhook (signature + timestamp tolerance + replay)", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';
  const NOW = 1_800_000_000_000;
  const seen = new Set<string>();
  const replay: ReplayStore = { async claim(p, id) { const k = `${p}:${id}`; if (seen.has(k)) return false; seen.add(k); return true; } };
  const mk = async (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}, ts = NOW / 1000) => ({
    provider: "acme", secrets: [secret], timestamp: ts, signature: await hmacSha256(secret, `${ts}.${body}`), signedPayload: (t: number) => `${t}.${body}`,
    now: () => NOW, eventId: "evt_1", replay, ...over,
  });
  it("accepts a valid, fresh, first-time event", async () => { seen.clear(); await verifyWebhook(await mk()); });
  it("rejects a replay of the same event id", async () => { seen.clear(); await verifyWebhook(await mk()); await expect(verifyWebhook(await mk())).rejects.toThrow("Duplicate"); });
  it("rejects a stale timestamp even with a valid signature", async () => { seen.clear(); await expect(verifyWebhook(await mk({}, NOW / 1000 - 301))).rejects.toThrow("tolerance"); });
  it("rejects a tampered body and a wrong secret", async () => {
    seen.clear();
    await expect(verifyWebhook(await mk({ signedPayload: (t) => `${t}.{"id":"evt_2"}` }))).rejects.toThrow("bad signature");
    await expect(verifyWebhook(await mk({ secrets: ["other"] }))).rejects.toThrow("bad signature");
  });
  it("fails closed with no configured secret / missing signature / missing timestamp", async () => {
    await expect(verifyWebhook(await mk({ secrets: [undefined, ""] }))).rejects.toThrow("no secret");
    await expect(verifyWebhook(await mk({ signature: null }))).rejects.toThrow("missing signature");
    await expect(verifyWebhook(await mk({ timestamp: null }))).rejects.toThrow("missing timestamp");
  });
  it("supports secret rotation (any configured secret may match)", async () => { seen.clear(); await verifyWebhook(await mk({ secrets: ["new", secret] })); });
  it("rejects an eventId with no replay store instead of silently skipping protection", async () => {
    seen.clear();
    await expect(verifyWebhook(await mk({ replay: undefined }))).rejects.toThrow("Replay store");
  });
});

describe("secure() wrapper", () => {
  const allow: RateLimiter = { async hit() { return { allowed: true, remaining: 1, retryAfter: 1 }; } };
  const deny: RateLimiter = { async hit() { return { allowed: false, remaining: 0, retryAfter: 7 }; } };
  const deps = {
    getUser: async (jwt: string) => (jwt === "good" ? { id: "u1" } : null),
    resolveTenant: async (id: string) => (id === "u1" ? { tenantId: "tA", roles: ["technician"] } : null),
  };

  it("standard error envelope + request id; internal errors never leak details", async () => {
    const h = secure({ name: "t", auth: jwtAuth(deps), ...base }, async () => { throw new Error("db password=hunter2"); });
    const res = await h(req({ headers: { authorization: "Bearer good" } }));
    const j = await res.json();
    expect(res.status).toBe(500);
    expect(j.error.code).toBe("internal");
    expect(JSON.stringify(j)).not.toContain("hunter2");
    expect(res.headers.get("x-request-id")).toBe(j.error.request_id);
  });
  it("401 without token, 401 bad token, 403 without membership, 403 wrong role", async () => {
    const h = secure({ name: "t", auth: jwtAuth(deps, { anyOfRoles: ["owner"] }), ...base }, okHandler);
    expect((await h(req())).status).toBe(401);
    expect((await h(req({ headers: { authorization: "Bearer bad" } }))).status).toBe(401);
    expect((await h(req({ headers: { authorization: "Bearer good" } }))).status).toBe(403);
    const noMember = secure({ name: "t", auth: jwtAuth({ ...deps, resolveTenant: async () => null }), ...base }, okHandler);
    expect((await noMember(req({ headers: { authorization: "Bearer good" } }))).status).toBe(403);
  });
  it("tenant comes from the server-side membership, never from the request body", async () => {
    let seen = "";
    const h = secure({ name: "t", auth: jwtAuth(deps), ...base }, async (c) => { seen = c.principal.tenantId ?? ""; return new Response("ok"); });
    await h(req({ headers: { authorization: "Bearer good" }, body: JSON.stringify({ tenantId: "tB" }) }));
    expect(seen).toBe("tA");
  });
  it("rate limit returns 429 with Retry-After and happens before auth", async () => {
    let authCalled = false;
    const h = secure({ name: "t", auth: async () => { authCalled = true; return { kind: "service" }; }, rateLimit: { limiter: deny, limit: 1, windowSeconds: 60 }, ...base }, okHandler);
    const res = await h(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(authCalled).toBe(false);
  });
  it("shared-secret auth is fail-closed when the env secret is missing", async () => {
    const closed = secure({ name: "t", auth: sharedSecretAuth("x-cron-secret", () => undefined), ...base }, okHandler);
    expect((await closed(req({ headers: { "x-cron-secret": "" } }))).status).toBe(401);
    const open = secure({ name: "t", auth: sharedSecretAuth("x-cron-secret", () => "s3"), ...base }, okHandler);
    expect((await open(req({ headers: { "x-cron-secret": "s3" } }))).status).toBe(200);
    expect((await open(req({ headers: { "x-cron-secret": "nope" } }))).status).toBe(401);
  });
  it("405 for disallowed methods; CORS only for allowlisted origins; no CORS config => no CORS headers", async () => {
    const h = secure({ name: "t", auth: sharedSecretAuth("x", () => "s"), cors: { allowedOrigins: ["https://app.vireek.com"] }, ...base }, okHandler);
    expect((await h(req({ method: "GET" }))).status).toBe(405);
    const pre = await h(req({ method: "OPTIONS", headers: { origin: "https://app.vireek.com" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.vireek.com");
    const evil = await h(req({ method: "OPTIONS", headers: { origin: "https://evil.test" } }));
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const s2s = secure({ name: "t", auth: sharedSecretAuth("x", () => "s"), ...base }, okHandler);
    expect((await s2s(req({ headers: { x: "s" } }))).headers.get("access-control-allow-origin")).toBeNull();
  });
  it("validation failure => 422 and handler is not called; oversize => 413", async () => {
    let called = false;
    const parser = { safeParse: (i: unknown) => ((i as { n?: number })?.n === 1 ? { success: true as const, data: i } : { success: false as const, error: { issues: [{ path: ["n"], message: "must be 1" }] } }) };
    const h = secure({ name: "t", auth: publicAuth, parser, rateLimit: { limiter: allow, limit: 5, windowSeconds: 60 }, maxBodyBytes: 20, ...base }, async () => { called = true; return new Response("ok"); });
    expect((await h(req({ body: '{"n":2}' }))).status).toBe(422);
    expect(called).toBe(false);
    expect((await h(req({ body: '{"n":1,"pad":"' + "x".repeat(50) + '"}' }))).status).toBe(413);
    expect((await h(req({ body: '{"n":1}' }))).status).toBe(200);
  });
  it("public endpoints without rate limit + parser cannot even be constructed", () => {
    expect(() => secure({ name: "t", auth: publicAuth, ...base }, okHandler)).toThrow("public endpoints require");
    expect(() => assertPublicEndpointSafe({ auth: publicAuth })).toThrow();
  });
  it("webhookAuth receives the raw body and a bad signature yields 401", async () => {
    const h = secure({ name: "t", auth: webhookAuth(async ({ rawBody }) => { if (rawBody !== '{"a":1}') throw new HttpError("unauthorized", "bad"); }), ...base }, okHandler);
    expect((await h(req({ body: '{"a":1}' }))).status).toBe(200);
    expect((await h(req({ body: '{"a":2}' }))).status).toBe(401);
  });
  it("logs are structured and never contain secrets or emails", async () => {
    lines.length = 0;
    const h = secure({ name: "t", auth: jwtAuth(deps), ...base }, async (c) => { c.log("custom", { email: "x@y.com", note: "ping a@b.com" }); return new Response("ok"); });
    await h(req({ headers: { authorization: "Bearer good" } }));
    const all = lines.join("\n");
    expect(all).not.toContain("x@y.com");
    expect(all).not.toContain("a@b.com");
    expect(all).not.toContain("Bearer");
    expect(JSON.parse(lines[0]).request_id).toBeTruthy();
  });
});
