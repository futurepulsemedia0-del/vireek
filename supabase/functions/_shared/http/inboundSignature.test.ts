import { beforeEach, describe, expect, it } from "vitest";
import { applySigPolicy, verifyMetaSignature } from "./inboundSignature.ts";
import { hmacSha256 } from "./webhook.ts";

const store = new Map<string, string>();
(globalThis as any).Deno ??= {
  env: { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) },
};

const body = '{"entry":[{"id":"1"}]}';
const sign = async (s: string, b = body) => "sha256=" + (await hmacSha256(s, b, "hex"));

describe("verifyMetaSignature", () => {
  it("accepts a valid signature", async () => {
    expect((await verifyMetaSignature(body, await sign("app"), ["app"])).ok).toBe(true);
  });
  it("rejects wrong secret, tampered body, missing header, no secret", async () => {
    expect((await verifyMetaSignature(body, await sign("wrong"), ["app"])).ok).toBe(false);
    expect((await verifyMetaSignature(body + " ", await sign("app"), ["app"])).ok).toBe(false);
    expect((await verifyMetaSignature(body, null, ["app"])).ok).toBe(false);
    expect((await verifyMetaSignature(body, await sign("app"), [undefined, ""])).ok).toBe(false);
  });
  it("supports secret rotation", async () => {
    expect((await verifyMetaSignature(body, await sign("new"), ["old", "new"])).ok).toBe(true);
  });
});

describe("applySigPolicy", () => {
  beforeEach(() => Deno.env.delete("WEBHOOK_SIG_MODE"));
  it("shadow (default) lets failures through", () => {
    expect(applySigPolicy("whatsapp", { ok: false, reason: "x" })).toBeNull();
  });
  it("enforce rejects failures with 403 and passes successes", () => {
    Deno.env.set("WEBHOOK_SIG_MODE", "enforce");
    expect(applySigPolicy("whatsapp", { ok: false, reason: "x" })?.status).toBe(403);
    expect(applySigPolicy("whatsapp", { ok: true })).toBeNull();
  });
});
