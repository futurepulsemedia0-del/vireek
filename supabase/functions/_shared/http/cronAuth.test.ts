import { beforeEach, describe, expect, it vi } from "vitest";
import { requireCronAuth } from "./cronAuth.ts";

// vitest runs on Node: provide a minimal Deno.env when the real one is absent.
const store = new Map<string, string>();
(globalThis as any).Deno ??= {
  env: { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) },
};

const req = (h?: string) => new Request("https://x.test/", { headers: h ? { "x-cron-secret": h } : {} });

describe("requireCronAuth (fail closed)", () => {
  beforeEach(() => { Deno.env.delete("CRON_SECRET"); Deno.env.delete("CRON_SECRET_NEXT"); });

  it("rejects with 500 when the secret is unset, even with no header", () => {
    const r = requireCronAuth(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(500);
  });
  it("honours misconfiguredStatus, merges responseHeaders and logs without leaking secrets", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = requireCronAuth(req("x"), { envName: "MY_CRON_SECRET", fn: "demo-fn", misconfiguredStatus: 503, responseHeaders: { "Access-Control-Allow-Origin": "*" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      expect(r.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(r.response.headers.get("Content-Type")).toBe("application/json");
    }
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("cron_auth_misconfigured");
    expect(line).toContain("demo-fn");
    expect(line).toContain("MY_CRON_SECRET");
    expect(line).not.toContain('"x"');
    spy.mockRestore();
  });
    const r = requireCronAuth(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(503);
  });
  it("rejects when secret unset and caller sends a guessed header", () => {
    expect(requireCronAuth(req("anything")).ok).toBe(false);
  });
  it("treats an empty-string secret as unset", () => {
    Deno.env.set("CRON_SECRET", "");
    expect(requireCronAuth(req("")).ok).toBe(false);
  });
  it("accepts the correct secret, rejects wrong/missing with 401", () => {
    Deno.env.set("CRON_SECRET", "s3cret-value");
    expect(requireCronAuth(req("s3cret-value")).ok).toBe(true);
    const bad = requireCronAuth(req("nope"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.response.status).toBe(401);
    expect(requireCronAuth(req()).ok).toBe(false);
  });
  it("accepts a rotation secret via extraEnvNames", () => {
    Deno.env.set("CRON_SECRET", "old");
    Deno.env.set("CRON_SECRET_NEXT", "new");
    expect(requireCronAuth(req("new"), { extraEnvNames: ["CRON_SECRET_NEXT"] }).ok).toBe(true);
  });
  it("accepts Bearer only when allowBearer is set", () => {
    Deno.env.set("CRON_SECRET", "tok");
    const b = new Request("https://x.test/", { headers: { authorization: "Bearer tok" } });
    expect(requireCronAuth(b).ok).toBe(false);
    expect(requireCronAuth(b, { allowBearer: true }).ok).toBe(true);
  });
});
