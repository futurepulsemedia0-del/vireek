import { beforeEach, describe, expect, it } from "vitest";
import { corsFor, isAllowedOrigin, patternToRegExp, preflight, rejectPreflight, withCors } from "./cors.ts";

// vitest runs on Node: provide a minimal Deno.env when the real one is absent.
const store = new Map<string, string>();
(globalThis as any).Deno ??= {
  env: { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) },
};

const req = (method: string, origin?: string) =>
  new Request("https://fn.test/", { method, headers: origin ? { origin } : {} });

describe("cors helper", () => {
  beforeEach(() => {
    for (const k of ["SITE_URL", "CORS_ALLOWED_ORIGINS", "CORS_PREVIEW_ORIGIN_PATTERNS", "CORS_ALLOW_LOCALHOST"]) Deno.env.delete(k);
    Deno.env.set("SITE_URL", "https://vireek.com/");
    Deno.env.set("CORS_ALLOWED_ORIGINS", "https://app.vireek.com, *, https://*.evil.com");
    Deno.env.set("CORS_PREVIEW_ORIGIN_PATTERNS", "https://vireek-*.vercel.app");
  });

  it("allows SITE_URL and listed origins, echoing the origin (never *)", () => {
    for (const o of ["https://vireek.com", "https://app.vireek.com"]) {
      const h = corsFor(req("POST", o));
      expect(h["Access-Control-Allow-Origin"]).toBe(o);
      expect(h.Vary).toBe("Origin");
    }
  });
  it("denies unknown, null, malformed and look-alike origins", () => {
    for (const o of ["https://evil.com", "null", "https://vireek.com.evil.com", "https://app.vireek.com/x", "http://vireek.com", "https://evilvireek.com"]) {
      expect(corsFor(req("POST", o))["Access-Control-Allow-Origin"]).toBeUndefined();
    }
  });
  it("ignores wildcard entries in CORS_ALLOWED_ORIGINS", () => {
    expect(isAllowedOrigin("https://anything.evil.com")).toBe(false);
  });
  it("preview pattern matches exactly one label, https only", () => {
    expect(isAllowedOrigin("https://vireek-pr-42.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://vireek-.vercel.app")).toBe(false);
    expect(isAllowedOrigin("https://vireek-a.b.vercel.app")).toBe(false);
    expect(isAllowedOrigin("http://vireek-pr-42.vercel.app")).toBe(false);
    expect(patternToRegExp("https://*.*.app")).toBeNull();
    expect(patternToRegExp("http://x-*.app")).toBeNull();
  });
  it("localhost only when explicitly enabled", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(false);
    Deno.env.set("CORS_ALLOW_LOCALHOST", "true");
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://localhost.evil.com")).toBe(false);
  });
  it("fails closed when nothing is configured", () => {
    for (const k of ["SITE_URL", "CORS_ALLOWED_ORIGINS", "CORS_PREVIEW_ORIGIN_PATTERNS"]) Deno.env.delete(k);
    expect(isAllowedOrigin("https://vireek.com")).toBe(false);
  });
  it("preflight: 204 allowed, 403 denied, null for non-OPTIONS", () => {
    expect(preflight(req("OPTIONS", "https://vireek.com"))?.status).toBe(204);
    expect(preflight(req("OPTIONS", "https://evil.com"))?.status).toBe(403);
    expect(preflight(req("OPTIONS"))?.status).toBe(403);
    expect(preflight(req("POST", "https://vireek.com"))).toBeNull();
  });
  it("server-to-server: no CORS headers, preflight is 405", () => {
    const r = rejectPreflight(req("OPTIONS", "https://vireek.com"))!;
    expect(r.status).toBe(405);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(rejectPreflight(req("POST"))).toBeNull();
  });
  it("withCors: adds headers to every response for allowed origins, none for denied, answers preflight", async () => {
    const h = withCors(() => new Response("{}", { status: 401 }));
    const ok = await h(req("POST", "https://vireek.com"));
    expect(ok.status).toBe(401);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://vireek.com");
    const bad = await h(req("POST", "https://evil.com"));
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    expect(bad.headers.get("vary")).toBe("Origin");
    expect((await h(req("OPTIONS", "https://vireek.com"))).status).toBe(204);
    expect((await h(req("OPTIONS", "https://evil.com"))).status).toBe(403);
  });
});
