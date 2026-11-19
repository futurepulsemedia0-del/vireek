import { describe, expect, it } from "vitest";
import { applySignedInboundPolicy, deriveSigningSecret, parseMode, signRequest, verifyInboundSignature } from "./signedInbound.ts";
import type { ReplayStore } from "./webhook.ts";

const MASTER = "m".repeat(48);
const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ records: [{ entity: "customer", external_id: "c1", data: { name: "Ana" } }] });

function memReplay(): ReplayStore & { seen: Set<string> } {
  const seen = new Set<string>();
  return { seen, async claim(p, id) { const k = `${p}|${id}`; if (seen.has(k)) return false; seen.add(k); return true; } };
}
const headersOf = (h: Record<string, string>) => new Headers(h);
const verify = (rawBody: string, h: Record<string, string>, secrets: (string | null)[], replay = memReplay(), now = NOW) =>
  verifyInboundSignature({ provider: "fabric:conn-1", rawBody, headers: headersOf(h), secrets, replay, now: () => now });

describe("signed inbound (HMAC + timestamp + replay)", () => {
  it("accepts a correctly signed, fresh request", async () => {
    const secret = await deriveSigningSecret(MASTER, "conn-1");
    const h = await signRequest(secret, BODY, NOW / 1000);
    expect(await verify(BODY, h, [secret])).toEqual({ ok: true });
  });
  it("rejects a replay of the exact same signed request", async () => {
    const secret = await deriveSigningSecret(MASTER, "conn-1");
    const h = await signRequest(secret, BODY, NOW / 1000);
    const replay = memReplay();
    expect((await verify(BODY, h, [secret], replay)).ok).toBe(true);
    const again = await verify(BODY, h, [secret], replay);
    expect(again.ok).toBe(false);
  });
  it("rejects a tampered body", async () => {
    const secret = await deriveSigningSecret(MASTER, "conn-1");
    const h = await signRequest(secret, BODY, NOW / 1000);
    expect((await verify(BODY.replace("Ana", "Eve"), h, [secret])).ok).toBe(false);
  });
  it("rejects a wrong secret and a secret derived for another connection", async () => {
    const mine = await deriveSigningSecret(MASTER, "conn-1");
    const other = await deriveSigningSecret(MASTER, "conn-2");
    const h = await signRequest(other, BODY, NOW / 1000);
    expect((await verify(BODY, h, [mine])).ok).toBe(false);
    expect(mine).not.toBe(other);
  });
  it("rejects missing, malformed and non-sha256 signature headers", async () => {
    const secret = await deriveSigningSecret(MASTER, "conn-1");
    const good = await signRequest(secret, BODY, NOW / 1000);
    expect((await verify(BODY, {}, [secret])).ok).toBe(false);
    expect((await verify(BODY, { "x-vireek-timestamp": good["x-vireek-timestamp"] }, [secret])).ok).toBe(false);
    expect((await verify(BODY, { ...good, "x-vireek-signature": "md5=abc" }, [secret])).ok).toBe(false);
    expect((await verify(BODY, { "x-vireek-signature": good["x-vireek-signature"] }, [secret])).ok).toBe(false);
  });
  it("rejects stale and far-future timestamps (tolerance 300 s)", async () => {
    const secret = await deriveSigningSecret(MASTER, "conn-1");
    const old = await signRequest(secret, BODY, NOW / 1000 - 301);
    const future = await signRequest(secret, BODY, NOW / 1000 + 301);
    expect((await verify(BODY, old, [secret])).ok).toBe(false);
    expect((await verify(BODY, future, [secret])).ok).toBe(false);
  });
  it("fails closed when no secret is configured", async () => {
    const h = await signRequest("anything", BODY, NOW / 1000);
    const v = await verify(BODY, h, [undefined, ""]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("no secret configured");
  });
  it("supports secret rotation (old and new both accepted)", async () => {
    const oldS = await deriveSigningSecret("o".repeat(48), "conn-1");
    const newS = await deriveSigningSecret(MASTER, "conn-1");
    const h = await signRequest(oldS, BODY, NOW / 1000);
    expect((await verify(BODY, h, [newS, oldS])).ok).toBe(true);
  });
});

describe("rollout policy", () => {
  it("shadow lets an unsigned request through, enforce rejects with 401", () => {
    const bad = { ok: false, reason: "missing signature" };
    expect(applySignedInboundPolicy("fabric", bad, "shadow")).toBeNull();
    expect(applySignedInboundPolicy("fabric", bad, "enforce")?.status).toBe(401);
    expect(applySignedInboundPolicy("fabric", { ok: true }, "enforce")).toBeNull();
  });
  it("any value other than 'enforce' is shadow", () => {
    expect(parseMode("enforce")).toBe("enforce");
    expect(parseMode("ENFORCE")).toBe("shadow");
    expect(parseMode(undefined)).toBe("shadow");
  });
});
