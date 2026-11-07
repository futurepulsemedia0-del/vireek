// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  MAX_ATTEMPTS, backoffSeconds, buildEventPayload, classifyDelivery, isPublicIp,
  resolvedAddressesSafe, retryAfterSeconds, signDelivery, validateDeliveryUrl, verifyDelivery,
} from "./outbound.ts";

const body = JSON.stringify({ id: "d1", event: "job.completed" });
const now = 1_800_000_000;

describe("retry schedule", () => {
  it("grows exponentially within jitter bounds and is capped at 6h", () => {
    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      const lo = backoffSeconds(a, () => 0);
      const hi = backoffSeconds(a, () => 0.999999);
      const ceiling = Math.min(30 * 2 ** (a - 1), 21600);
      expect(lo).toBeGreaterThanOrEqual(5);
      expect(hi).toBeLessThanOrEqual(ceiling);
      expect(lo).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
    }
    expect(backoffSeconds(99, () => 0.999999)).toBeLessThanOrEqual(21600);
  });
  it("honours Retry-After (seconds and HTTP date), capped", () => {
    expect(retryAfterSeconds("120", 0)).toBe(120);
    expect(retryAfterSeconds("999999", 0)).toBe(21600);
    expect(retryAfterSeconds(new Date(60_000).toUTCString(), 0)).toBe(60);
    expect(retryAfterSeconds("soon", 0)).toBeNull();
    expect(retryAfterSeconds(null, 0)).toBeNull();
  });
  it("classifies responses", () => {
    expect(classifyDelivery(200)).toBe("delivered");
    expect(classifyDelivery(204)).toBe("delivered");
    expect(classifyDelivery(429)).toBe("retry");
    expect(classifyDelivery(503)).toBe("retry");
    expect(classifyDelivery(undefined)).toBe("retry");
    expect(classifyDelivery(404)).toBe("dead");
    expect(classifyDelivery(301)).toBe("dead"); // redirects are never followed
  });
});

describe("SSRF guards", () => {
  it("accepts only public https URLs", () => {
    expect(validateDeliveryUrl("https://hooks.example.com/v1").ok).toBe(true);
    for (const bad of [
      "http://hooks.example.com", "https://user:pw@hooks.example.com", "https://localhost/x", "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://[::1]/x", "https://2130706433/x",
      "https://metadata.google.internal/x", "https://intranet/x", "https://example.com:22/x", "not a url",
    ]) expect(validateDeliveryUrl(bad).ok).toBe(false);
  });
  it("DNS-rebinding simulation: a public name that resolves privately is refused", () => {
    expect(resolvedAddressesSafe(["93.184.216.34"])).toBe(true);
    expect(resolvedAddressesSafe(["93.184.216.34", "10.0.0.1"])).toBe(false); // mixed answer
    expect(resolvedAddressesSafe(["169.254.169.254"])).toBe(false);
    expect(resolvedAddressesSafe(["::1"])).toBe(false);
    expect(resolvedAddressesSafe(["::ffff:127.0.0.1"])).toBe(false);
    expect(resolvedAddressesSafe(["fd00::1"])).toBe(false);
    expect(resolvedAddressesSafe([])).toBe(false); // fail closed
    expect(isPublicIp("8.8.8.8")).toBe(true);
  });
});

describe("signing + reference receiver", () => {
  it("round-trips and sets all headers", async () => {
    const s = await signDelivery({ secrets: ["whsec_new"], body, deliveryId: "d1", event: "job.completed", timestamp: now });
    expect(s.headers["X-Vireek-Delivery-Id"]).toBe("d1");
    expect(s.headers["X-Vireek-Signature"]).toMatch(/^[0-9a-f]{64}$/); // legacy header preserved
    const v = await verifyDelivery({ secret: "whsec_new", body, timestampHeader: s.headers["X-Vireek-Timestamp"], signatureHeader: s.headers["X-Vireek-Signature-V1"], nowMs: now * 1000 });
    expect(v).toEqual({ ok: true });
  });
  it("rotation without dropped events: old and new secret both verify during the grace window", async () => {
    const s = await signDelivery({ secrets: ["whsec_new", "whsec_old"], body, deliveryId: "d1", event: "e", timestamp: now });
    for (const secret of ["whsec_new", "whsec_old"]) {
      const v = await verifyDelivery({ secret, body, timestampHeader: String(now), signatureHeader: s.headers["X-Vireek-Signature-V1"], nowMs: now * 1000 });
      expect(v.ok).toBe(true);
    }
    const after = await signDelivery({ secrets: ["whsec_new"], body, deliveryId: "d1", event: "e", timestamp: now });
    const old = await verifyDelivery({ secret: "whsec_old", body, timestampHeader: String(now), signatureHeader: after.headers["X-Vireek-Signature-V1"], nowMs: now * 1000 });
    expect(old).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects tampered body, wrong secret, stale timestamp and a replay with a re-stamped header", async () => {
    const s = await signDelivery({ secrets: ["k1"], body, deliveryId: "d", event: "e", timestamp: now });
    const sig = s.headers["X-Vireek-Signature-V1"];
    expect((await verifyDelivery({ secret: "k1", body: body + " ", timestampHeader: String(now), signatureHeader: sig, nowMs: now * 1000 })).ok).toBe(false);
    expect((await verifyDelivery({ secret: "k2", body, timestampHeader: String(now), signatureHeader: sig, nowMs: now * 1000 })).ok).toBe(false);
    expect(await verifyDelivery({ secret: "k1", body, timestampHeader: String(now), signatureHeader: sig, nowMs: (now + 301) * 1000 })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyDelivery({ secret: "k1", body, timestampHeader: String(now + 100), signatureHeader: sig, nowMs: (now + 100) * 1000 })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyDelivery({ secret: "k1", body, timestampHeader: null, signatureHeader: sig })).toEqual({ ok: false, reason: "missing" });
  });
  it("refuses to sign without a secret", async () => {
    await expect(signDelivery({ secrets: ["", ""], body, deliveryId: "d", event: "e", timestamp: now })).rejects.toThrow("no_signing_secret");
  });
});

describe("event payload", () => {
  it("is versioned, strips credential-like keys at any depth and caps size", () => {
    const r = buildEventPayload({ deliveryId: "d", event: "job.created", createdAt: "2026-11-06T00:00:00Z", data: { id: 1, nested: { api_key: "x", ok: 1 }, password: "p" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = JSON.parse(r.body);
      expect(p.version).toBeTruthy();
      expect(p.data).toEqual({ id: 1, nested: { ok: 1 } });
    }
    const big = buildEventPayload({ deliveryId: "d", event: "e", createdAt: "t", data: { blob: "x".repeat(300_000) } });
    expect(big).toEqual({ ok: false, error: "payload_too_large" });
  });
});
