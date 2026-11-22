import { describe, expect, it, vi } from "vitest";
import { z, strictObject, emptyObject } from "./zod.ts";
import { formatIssues, parseBody, parseOrThrow, parseQuery, tryGuard, withErrorHandling, MAX_ISSUES } from "./zodRequest.ts";
import { HttpError } from "./core.ts";
import { enforceRateLimit, clientIp } from "./publicGuard.ts";
import { assertCronAuth } from "./cronGuard.ts";
import type { RpcClient } from "./rateLimit.ts";

const schema = strictObject({ token: z.string().min(8).max(64), n: z.number().int().max(100).optional() });
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://fn.test/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
const fail = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { return e as HttpError; }
  throw new Error("expected rejection");
};

describe("parseBody", () => {
  it("accepts a valid payload", async () => {
    await expect(parseBody(post(JSON.stringify({ token: "abcdefgh" })), schema)).resolves.toEqual({ token: "abcdefgh" });
  });
  it("malformed JSON -> 400 bad_request", async () => {
    const e = await fail(parseBody(post("{not json"), schema));
    expect(e).toBeInstanceOf(HttpError);
    expect(e.code).toBe("bad_request");
  });
  it("empty body -> 400 unless allowEmpty", async () => {
    expect((await fail(parseBody(post(""), schema))).code).toBe("bad_request");
    await expect(parseBody(post(""), emptyObject, { allowEmpty: true })).resolves.toEqual({});
  });
  it("extra field -> 400 naming the field, input values not echoed", async () => {
    const e = await fail(parseBody(post(JSON.stringify({ token: "abcdefgh", role: "admin" })), schema));
    expect(e.code).toBe("bad_request");
    expect(JSON.stringify(e.details)).toContain("role");
    expect(JSON.stringify(e.details)).not.toContain("admin");
  });
  it("wrong type / out-of-range -> 400 with path", async () => {
    const e = await fail(parseBody(post(JSON.stringify({ token: 5, n: 1000 })), schema));
    const paths = (e.details as { path: string }[]).map((d) => d.path).sort();
    expect(paths).toEqual(["n", "token"]);
  });
  it("oversized by content-length -> 413 before reading", async () => {
    const e = await fail(parseBody(post("{}", { "content-length": "999999" }), schema, { maxBytes: 1000 }));
    expect(e.code).toBe("payload_too_large");
  });
  it("oversized chunked body without content-length -> 413 (stream capped)", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 50; i++) c.enqueue(new TextEncoder().encode("x".repeat(100))); c.close(); },
    });
    const req = new Request("https://fn.test/x", { method: "POST", body: big, duplex: "half" } as RequestInit);
    expect((await fail(parseBody(req, schema, { maxBytes: 1000 }))).code).toBe("payload_too_large");
  });
  it("oversized string field -> 400", async () => {
    expect((await fail(parseBody(post(JSON.stringify({ token: "x".repeat(65) })), schema))).code).toBe("bad_request");
  });
  it("__proto__ key is rejected as unknown, not merged", async () => {
    const e = await fail(parseBody(post('{"token":"abcdefgh","__proto__":{"admin":true}}'), schema));
    expect(e.code).toBe("bad_request");
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe("parseQuery", () => {
  const q = strictObject({ slug: z.string().min(3), format: z.enum(["a", "b"]).optional() });
  it("parses valid and rejects extras", () => {
    expect(parseQuery(new URL("https://x.test/?slug=abc&format=a"), q)).toEqual({ slug: "abc", format: "a" });
    expect((() => { try { parseQuery(new URL("https://x.test/?slug=abc&evil=1"), q); } catch (e) { return e as HttpError; } })()?.code).toBe("bad_request");
  });
  it("repeated parameter -> 400 (pollution)", () => {
    expect(() => parseQuery(new URL("https://x.test/?slug=abc&slug=def"), q)).toThrow(/Repeated/);
  });
  it("too many / too long params -> 400", () => {
    const many = "?" + Array.from({ length: 21 }, (_, i) => `p${i}=1`).join("&");
    expect(() => parseQuery(new URL("https://x.test/" + many), z.object({}).passthrough())).toThrow(/Too many/);
    expect(() => parseQuery(new URL("https://x.test/?slug=" + "a".repeat(2001)), q)).toThrow(/too long/);
  });
  it("enum mismatch does not echo the received value", () => {
    try { parseQuery(new URL("https://x.test/?slug=abc&format=SECRETVALUE"), q); } catch (e) { expect(JSON.stringify((e as HttpError).details)).not.toContain("SECRETVALUE"); }
  });
});

describe("formatIssues / withErrorHandling", () => {
  it("caps the number of issues", () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({ path: [i], message: "bad" }));
    expect((formatIssues(issues) as unknown[]).length).toBe(MAX_ISSUES);
  });
  it("parseOrThrow returns parsed data", () => { expect(parseOrThrow(z.string(), "ok")).toBe("ok"); });
  it("HttpError -> standard envelope; unknown error -> opaque 500 that never leaks the message", async () => {
    const sink = vi.fn();
    const r1 = await withErrorHandling(post("{}"), async () => { throw new HttpError("bad_request", "nope"); }, { "X-T": "1" }, sink);
    expect(r1.status).toBe(400);
    expect(r1.headers.get("X-T")).toBe("1");
    expect((await r1.json()).error.code).toBe("bad_request");
    const r2 = await withErrorHandling(post("{}"), async () => { throw new Error("db password=hunter2"); }, {}, sink);
    expect(r2.status).toBe(500);
    expect(await r2.text()).not.toContain("hunter2");
  });
});

describe("enforceRateLimit", () => {
  const db = (allowed: boolean, retry = 30): RpcClient => ({ rpc: async () => ({ data: { allowed, remaining: 0, retry_after: retry }, error: null }) });
  const req = new Request("https://x.test/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  it("allowed -> resolves; exceeded -> 429 with Retry-After", async () => {
    await expect(enforceRateLimit(db(true), req, { name: "t", limit: 1, windowSeconds: 60 })).resolves.toBeUndefined();
    const e = await fail(enforceRateLimit(db(false, 42), req, { name: "t", limit: 1, windowSeconds: 60 }));
    expect(e.code).toBe("rate_limited");
    expect(e.headers?.["Retry-After"]).toBe("42");
  });
  it("limiter down: closed -> 500, open -> passes", async () => {
    const broken: RpcClient = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
    const quiet = () => {};
    expect((await fail(enforceRateLimit(broken, req, { name: "t", limit: 1, windowSeconds: 60 }, quiet))).code).toBe("internal");
    await expect(enforceRateLimit(broken, req, { name: "t", limit: 1, windowSeconds: 60, onError: "open" }, quiet)).resolves.toBeUndefined();
  });
  it("bucket is IP-keyed and capped at 200 chars", async () => {
    const seen: string[] = [];
    const spy: RpcClient = { rpc: async (_f, a) => { seen.push(String(a.p_bucket)); return { data: { allowed: true, remaining: 1, retry_after: 1 }, error: null }; } };
    await enforceRateLimit(spy, req, { name: "t", limit: 1, windowSeconds: 60 });
    await enforceRateLimit(spy, req, { name: "t", limit: 1, windowSeconds: 60, key: "k".repeat(500) });
    expect(seen[0]).toBe("t:203.0.113.9");
    expect(seen[1].length).toBe(200);
    expect(clientIp(new Request("https://x.test/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe("1.2.3.4");
  });
});

describe("tryGuard / assertCronAuth", () => {
  it("ok passes value; failures render standard or legacy bodies with extra headers", async () => {
    const ok = await tryGuard(post("{}"), {}, async () => 7);
    expect(ok).toEqual({ ok: true, value: 7 });
    const std = await tryGuard(post("{}"), { "Access-Control-Allow-Origin": "*" }, () => parseBody(post("{bad"), schema));
    if (std.ok) throw new Error("expected failure");
    expect(std.response.status).toBe(400);
    expect(std.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await std.response.json()).error.code).toBe("bad_request");
    const legacy = await tryGuard(post("{}"), {}, () => parseBody(post("{bad"), schema), { legacy: true });
    if (legacy.ok) throw new Error("expected failure");
    const body = await legacy.response.json();
    expect(typeof body.error).toBe("string");
    expect(body.code).toBe("bad_request");
  });
  it("unexpected errors become an opaque 500", async () => {
    const r = await tryGuard(post("{}"), {}, async () => { throw new Error("secret=abc"); }, { logSink: () => {} });
    if (r.ok) throw new Error("expected failure");
    expect(r.response.status).toBe(500);
    expect(await r.response.text()).not.toContain("secret=abc");
  });
  it("assertCronAuth is fail-closed", () => {
    const g = globalThis as unknown as { Deno?: unknown };
    const env: Record<string, string | undefined> = {};
    g.Deno = { env: { get: (k: string) => env[k] } };
    const withHdr = (h: Record<string, string>) => new Request("https://x.test/", { method: "POST", headers: h });
    expect(() => assertCronAuth(withHdr({ "x-cron-secret": "s" }), { allowBearer: true })).toThrow(/Internal/); // unset -> never allow
    env.CRON_SECRET = "s3cret-value";
    env.SUPABASE_SERVICE_ROLE_KEY = "srk-value";
    const opts = { allowBearer: true, extraEnvNames: ["SUPABASE_SERVICE_ROLE_KEY"] };
    expect(() => assertCronAuth(withHdr({}), opts)).toThrow(/Unauthorized/);
    expect(() => assertCronAuth(withHdr({ "x-cron-secret": "wrong" }), opts)).toThrow(/Unauthorized/);
    expect(() => assertCronAuth(withHdr({ "x-cron-secret": "s3cret-value" }), opts)).not.toThrow();
    expect(() => assertCronAuth(withHdr({ authorization: "Bearer srk-value" }), opts)).not.toThrow();
  });
});
