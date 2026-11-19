// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildContextJson, C2PA_MAX_BYTES, normalizeManifestStore, readC2pa } from "./c2pa.ts";
import { nodeC2paDeps } from "./c2paNodeDeps.testkit.ts";
import { tinyJpeg } from "./testkit.ts";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const anchors = readFileSync(new URL("./fixtures/c2pa-test-trust-anchors.pem", import.meta.url), "utf8");

// Real library + real files from the official c2pa-rs repository.
describe("readC2pa with the real @contentauth/c2pa-wasm reader", () => {
  it("reads a valid manifest; signer is NOT evaluated without trust anchors", async () => {
    const r = await readC2pa(nodeC2paDeps(), fx("c2pa-valid-test-signer.jpg"), "image/jpeg");
    expect(r.status).toBe("read");
    expect(r.validation).toBe("valid");
    expect(r.trust).toBe("not_evaluated");
    expect(r.problems).toEqual([]);
    expect(r.signer?.commonName).toBe("C2PA Signer");
    expect(r.actions).toContain("c2pa.created");
    expect(r.declaresGeneratedMedia).toBe(true); // this fixture declares algorithmicMedia
    expect(r.declaresCapture).toBe(false);
    expect(r.manifestCount).toBe(1);
  });
  it("becomes trusted only when operator anchors match (test roots here)", async () => {
    const r = await readC2pa(nodeC2paDeps(anchors), fx("c2pa-valid-test-signer.jpg"), "image/jpeg");
    expect(r.validation).toBe("valid");
    expect(r.trust).toBe("trusted");
  });
  it("reports a file changed after signing as invalid", async () => {
    const r = await readC2pa(nodeC2paDeps(), fx("c2pa-asset-tampered.jpg"), "image/jpeg");
    expect(r.validation).toBe("invalid");
    expect(r.problems).toContain("asset_changed_after_signing");
    expect(r.statusCodes).toContain("assertion.dataHash.mismatch");
  });
  it("reports a broken signature as invalid", async () => {
    const r = await readC2pa(nodeC2paDeps(), fx("c2pa-signature-broken.jpg"), "image/jpeg");
    expect(r.validation).toBe("invalid");
    expect(r.problems).toContain("signature_invalid");
  });
  it("flips a single byte of a valid file: validation must fail, never pass silently", async () => {
    const bytes = Uint8Array.from(fx("c2pa-valid-test-signer.jpg"));
    bytes[bytes.length - 40] ^= 0xff; // inside the entropy-coded image data
    const r = await readC2pa(nodeC2paDeps(), bytes, "image/jpeg");
    expect(r.status === "read" ? r.validation : "invalid").toBe("invalid");
  });
  it("no manifest => not_present (and says nothing about authenticity)", async () => {
    const r = await readC2pa(nodeC2paDeps(), tinyJpeg(), "image/jpeg");
    expect(r.status).toBe("not_present");
    expect(r.validation).toBe("unknown");
  });
  it("garbage bytes => unsupported_format, never throws", async () => {
    const r = await readC2pa(nodeC2paDeps(), new Uint8Array([1, 2, 3, 4]), "image/jpeg");
    expect(r.status).toBe("unsupported_format");
  });
  it("a malformed trust configuration is an error, not a silent downgrade", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await readC2pa(nodeC2paDeps("not a pem"), fx("c2pa-valid-test-signer.jpg"), "image/jpeg");
    expect(r.status).toBe("error");
    expect(spy.mock.calls.join(" ")).not.toContain("not a pem");
    spy.mockRestore();
  });
});

describe("readC2pa guards", () => {
  it("is unavailable without a reader, skips oversized and unsupported types", async () => {
    expect((await readC2pa(null, tinyJpeg(), "image/jpeg")).status).toBe("unavailable");
    const deps = { readManifestStore: vi.fn() };
    expect((await readC2pa(deps, new Uint8Array(C2PA_MAX_BYTES + 1), "image/jpeg")).status).toBe("too_large");
    expect((await readC2pa(deps, tinyJpeg(), "image/gif")).status).toBe("unsupported_format");
    expect(deps.readManifestStore).not.toHaveBeenCalled();
  });
  it("builds a context that disables trust checks unless anchors are given", () => {
    expect(JSON.parse(buildContextJson(""))).toEqual({ verify: { verify_trust: false } });
    expect(JSON.parse(buildContextJson("PEM"))).toEqual({ verify: { verify_trust: true }, trust: { trust_anchors: "PEM" } });
  });
});

describe("normalizeManifestStore (synthetic stores; shapes copied from real output)", () => {
  const store = (extra: Record<string, unknown> = {}, active: Record<string, unknown> = {}) => ({
    active_manifest: "m1",
    manifests: { m1: { claim_generator: "Cam/1.0", assertions: [{ label: "c2pa.actions.v2", data: { actions: [{ action: "c2pa.created", digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture" }] } }], signature_info: { issuer: "I", common_name: "CN", alg: "Es256", time: "2026-11-10T10:00:00+00:00" }, ...active } },
    validation_state: "Valid",
    ...extra,
  });
  it("recognises a capture claim", () => {
    const r = normalizeManifestStore(store(), false);
    expect(r.declaresCapture).toBe(true);
    expect(r.declaresGeneratedMedia).toBe(false);
    expect(r.signer?.signedAt).toBe("2026-11-10T10:00:00.000Z");
  });
  it("Trusted state maps to trusted only when trust was configured", () => {
    expect(normalizeManifestStore(store({ validation_state: "Trusted" }), true).trust).toBe("trusted");
    expect(normalizeManifestStore(store({ validation_state: "Trusted" }), false).trust).toBe("not_evaluated");
    expect(normalizeManifestStore(store({ validation_status: [{ code: "signingCredential.untrusted" }] }), true).trust).toBe("untrusted");
  });
  it("detects declared edits and AI-generated sources", () => {
    const r = normalizeManifestStore(store({}, { assertions: [{ label: "c2pa.actions", data: { actions: [{ action: "c2pa.edited", digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" }] } }] }), false);
    expect(r.declaresEdits).toBe(true);
    expect(r.declaresGeneratedMedia).toBe(true);
  });
  it("drops hostile or oversized values", () => {
    const r = normalizeManifestStore(store({ validation_status: [{ code: "x".repeat(200) }, { code: "<script>" }, { code: "claimSignature.mismatch" }] }, { claim_generator: "A\u202eB".repeat(100) }), false);
    expect(r.statusCodes).toEqual(["claimSignature.mismatch"]);
    expect(r.claimGenerator!.length).toBeLessThanOrEqual(100);
    expect(r.claimGenerator).not.toMatch(/\u202e/);
  });
  it("non-object input is an error report", () => {
    expect(normalizeManifestStore(null, false).status).toBe("error");
    expect(normalizeManifestStore({ active_manifest: "zzz", manifests: {} }, false).validation).toBe("unknown");
  });
});
