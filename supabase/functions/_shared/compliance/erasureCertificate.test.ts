import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSigningKey,
  baselineDigest,
  buildCertificatePayload,
  canonicalize,
  certificateNumberFor,
  computeBackupExpiry,
  isUuid,
  loadSigningKeys,
  parseBackupRetentionDays,
  signCertificatePayload,
  verifyCertificateJson,
  type ErasureBaseline,
  type ErasureEvidence,
} from "./erasureCertificate";

const baseline = JSON.parse(
  readFileSync(new URL("../../../../docs/compliance/erasure-coverage-baseline.json", import.meta.url), "utf8"),
) as ErasureBaseline;

const REQ = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2030-01-10T12:00:00.000Z");
const KEY = { id: "k1", secret: "test-secret-test-secret-test-secret-123" };

const goodEvidence = (): ErasureEvidence => ({
  ownedTables: { jobs: 3, leads: 2 },
  catalogErase: { deleted: { notes: 4 }, blocked: {} },
  trustPack: { ok: true },
  provider: { ok: true, skipped: [], failed: [], erased: { elevenlabsVoices: 1, vapiCalls: 2 } },
});

const build = (over: Partial<Parameters<typeof buildCertificatePayload>[0]> = {}) =>
  buildCertificatePayload({
    deletionRequestId: REQ,
    accountId: ACC,
    requestedAt: "2030-01-01T00:00:00Z",
    scheduledFor: "2030-01-09T00:00:00Z",
    completedAt: "2030-01-10T11:59:00Z",
    evidence: goodEvidence(),
    baseline,
    backupRetentionDays: 35,
    now: NOW,
    ...over,
  });

describe("canonicalize", () => {
  it("is independent of key insertion order and has no whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [2, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it("refuses values it cannot represent faithfully", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize({ a: BigInt(1) })).toThrow();
    expect(() => canonicalize([undefined])).toThrow();
  });
});

describe("identifiers", () => {
  it("derives one stable certificate number per deletion request", async () => {
    const a = await certificateNumberFor(REQ);
    expect(a).toMatch(/^VRK-ERC-[0-9A-F]{12}$/);
    expect(await certificateNumberFor(REQ)).toBe(a);
    expect(await certificateNumberFor("33333333-3333-4333-8333-333333333333")).not.toBe(a);
  });
  it("validates uuids", () => {
    expect(isUuid(REQ)).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("baseline", () => {
  it("has a certificate block whose entries are internally consistent", () => {
    const all = [...baseline.certificate.systems, ...baseline.certificate.subprocessors];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      if (s.automated) expect(typeof s.evidenceKey).toBe("string");
      else expect(typeof s.gap).toBe("string");
    }
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    expect(Array.isArray(baseline.uncovered)).toBe(true);
  });
});

describe("buildCertificatePayload", () => {
  it("lists every automated system/subprocessor from the baseline and reports erased outcomes", async () => {
    const p = await build();
    expect(p.systems.map((s) => s.id)).toEqual(baseline.certificate.systems.filter((s) => s.automated).map((s) => s.id));
    expect(p.subprocessors.map((s) => s.id)).toEqual(baseline.certificate.subprocessors.filter((s) => s.automated).map((s) => s.id));
    expect(p.status).toBe("completed");
    const byId = Object.fromEntries([...p.systems, ...p.subprocessors].map((e) => [e.id, e]));
    expect(byId["postgres-owned-tables"].removed).toBe(5);
    expect(byId["postgres-catalog-sweep"].removed).toBe(4);
    expect(byId["elevenlabs"].outcome).toBe("erased");
    expect(byId["vapi"].removed).toBe(2);
  });

  it("states non-automated gaps as limitations and never as erased", async () => {
    const p = await build();
    const ids = p.limitations.map((l) => l.id);
    for (const id of ["supabase-storage", "database-backups", "twilio", "resend"]) expect(ids).toContain(id);
    expect([...p.systems, ...p.subprocessors].some((e) => e.id === "twilio")).toBe(false);
  });

  it("reports provider states honestly", async () => {
    const ev = goodEvidence();
    ev.provider = { ok: false, skipped: ["elevenlabs:no_key"], failed: ["vapi:c1", "vapi:c2"], erased: { elevenlabsVoices: 0, vapiCalls: 1 } };
    const p = await build({ evidence: ev });
    const byId = Object.fromEntries(p.subprocessors.map((e) => [e.id, e]));
    expect(byId["elevenlabs"].outcome).toBe("skipped_no_credential");
    expect(byId["vapi"].outcome).toBe("failed");
    expect(byId["vapi"].note).toContain("2");
    expect(p.status).toBe("completed_with_exceptions");
  });

  it("uses not_applicable when nothing existed at the provider", async () => {
    const ev = goodEvidence();
    ev.provider = { ok: true, skipped: [], failed: [], erased: { elevenlabsVoices: 0, vapiCalls: 0 } };
    const p = await build({ evidence: ev });
    expect(p.subprocessors.every((e) => e.outcome === "not_applicable")).toBe(true);
    expect(p.status).toBe("completed");
  });

  it("flags blocked catalog tables and missing evidence instead of claiming success", async () => {
    const ev = goodEvidence();
    ev.catalogErase = { deleted: {}, blocked: { some_table: "fk" } };
    delete ev.trustPack;
    const p = await build({ evidence: ev });
    const byId = Object.fromEntries(p.systems.map((e) => [e.id, e]));
    expect(byId["postgres-catalog-sweep"].outcome).toBe("failed");
    expect(byId["trust-pack-vault"].outcome).toBe("no_evidence");
    expect(p.status).toBe("completed_with_exceptions");
  });

  it("records timeline and a stable baseline digest that changes with the baseline", async () => {
    const p = await build();
    expect(p.timeline.completedAt).toBe("2030-01-10T11:59:00.000Z");
    expect(p.coverageBaseline.acceptedUncoveredTables).toBe(baseline.uncovered.length);
    expect(p.coverageBaseline.sha256).toBe(await baselineDigest(baseline));
    const changed = { ...baseline, uncovered: [...baseline.uncovered, "zz_new_table"] };
    expect(await baselineDigest(changed)).not.toBe(p.coverageBaseline.sha256);
  });

  it("contains no personal data (no email, only the pseudonymous account id)", async () => {
    const json = canonicalize(await build());
    expect(json).not.toContain("@");
    expect(json).toContain(ACC);
  });

  it("rejects malformed input", async () => {
    await expect(build({ deletionRequestId: "x" })).rejects.toThrow();
    await expect(build({ accountId: "x" })).rejects.toThrow();
    await expect(build({ completedAt: "not a date" })).rejects.toThrow();
    await expect(build({ baseline: {} as ErasureBaseline })).rejects.toThrow();
  });
});

describe("backup expiry", () => {
  it("adds the retention window to completion time", () => {
    const b = computeBackupExpiry("2030-01-10T11:59:00.000Z", 35);
    expect(b.expiresAt).toBe("2030-02-14T11:59:00.000Z");
    expect(b.status).toBe("scheduled");
  });
  it("never invents a date when retention is not configured or invalid", () => {
    for (const bad of [null, undefined, 0, -3, 1.5, 99999, Number.NaN]) {
      const b = computeBackupExpiry("2030-01-10T11:59:00.000Z", bad as number | null);
      expect(b.expiresAt).toBeNull();
      expect(b.status).toBe("unverified");
    }
  });
  it("parses the env value strictly", () => {
    expect(parseBackupRetentionDays("35")).toBe(35);
    expect(parseBackupRetentionDays(" 35 ")).toBe(35);
    for (const bad of [undefined, "", "abc", "-1", "0", "3.5", "99999", "10 days"]) expect(parseBackupRetentionDays(bad as string | undefined)).toBeNull();
  });
});

describe("sign and verify", () => {
  it("round-trips and exposes the stored hash for later verification", async () => {
    const signed = await signCertificatePayload(await build(), KEY);
    expect(signed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.document.integrity.keyId).toBe("k1");
    const r = await verifyCertificateJson(signed.documentJson, { k1: KEY.secret }, signed.sha256);
    expect(r.valid).toBe(true);
    expect(r.checks).toEqual({ wellFormed: true, hashMatches: true, keyKnown: true, signatureValid: true, storedHashMatches: true });
  });

  it("is deterministic for identical input", async () => {
    const a = await signCertificatePayload(await build(), KEY);
    const b = await signCertificatePayload(await build(), KEY);
    expect(a.documentJson).toBe(b.documentJson);
  });

  it("detects any edit to the content", async () => {
    const signed = await signCertificatePayload(await build(), KEY);
    const doc = JSON.parse(signed.documentJson);
    doc.status = "completed";
    doc.systems[0].removed = 0;
    const r = await verifyCertificateJson(JSON.stringify(doc), { k1: KEY.secret }, signed.sha256);
    expect(r.valid).toBe(false);
    expect(r.checks.hashMatches).toBe(false);
  });

  it("detects an edit whose hash was recomputed (signature still fails without the key)", async () => {
    const signed = await signCertificatePayload(await build(), KEY);
    const doc = JSON.parse(signed.documentJson);
    doc.backup.expiresAt = "2031-01-01T00:00:00.000Z";
    const { integrity, ...payload } = doc;
    const { sha256 } = await signCertificatePayload(payload, { id: "k1", secret: "attacker-secret-attacker-secret-1234" });
    doc.integrity.sha256 = sha256;
    const r = await verifyCertificateJson(JSON.stringify(doc), { k1: KEY.secret }, sha256);
    expect(r.checks.hashMatches).toBe(true);
    expect(r.checks.signatureValid).toBe(false);
    expect(r.valid).toBe(false);
  });

  it("fails when the database hash column disagrees", async () => {
    const signed = await signCertificatePayload(await build(), KEY);
    const r = await verifyCertificateJson(signed.documentJson, { k1: KEY.secret }, "0".repeat(64));
    expect(r.checks.storedHashMatches).toBe(false);
    expect(r.valid).toBe(false);
  });

  it("fails with the wrong or an unknown key, and supports rotation via retired keys", async () => {
    const signed = await signCertificatePayload(await build(), KEY);
    expect((await verifyCertificateJson(signed.documentJson, { k1: "x".repeat(40) })).valid).toBe(false);
    const unknown = await verifyCertificateJson(signed.documentJson, { k2: KEY.secret });
    expect(unknown.checks.keyKnown).toBe(false);
    expect(unknown.valid).toBe(false);
    expect((await verifyCertificateJson(signed.documentJson, { k2: "n".repeat(40), k1: KEY.secret })).valid).toBe(true);
  });

  it("does not resolve prototype keys as key ids", async () => {
    const signed = await signCertificatePayload(await build(), KEY);
    const doc = JSON.parse(signed.documentJson);
    doc.integrity.keyId = "constructor";
    const r = await verifyCertificateJson(JSON.stringify(doc), { k1: KEY.secret });
    expect(r.checks.keyKnown).toBe(false);
    expect(r.valid).toBe(false);
  });

  it("rejects malformed documents without throwing", async () => {
    for (const bad of ["", "not json", "[]", "null", "{}", '{"integrity":{}}']) {
      const r = await verifyCertificateJson(bad, { k1: KEY.secret });
      expect(r.valid).toBe(false);
      expect(r.checks.wellFormed).toBe(false);
    }
  });

  it("refuses weak keys and bad key ids when signing", async () => {
    await expect(signCertificatePayload(await build(), { id: "k1", secret: "short" })).rejects.toThrow();
    await expect(signCertificatePayload(await build(), { id: "bad id!", secret: KEY.secret })).rejects.toThrow();
    expect(() => assertSigningKey(undefined)).toThrow();
  });
});

describe("loadSigningKeys", () => {
  const env = (o: Record<string, string>) => (n: string) => o[n];
  it("returns no current key when unset or too short", () => {
    expect(loadSigningKeys(env({})).current).toBeNull();
    expect(loadSigningKeys(env({ ERASURE_CERT_SIGNING_KEY: "short" })).current).toBeNull();
  });
  it("defaults the key id and merges retired keys; ignores malformed JSON", () => {
    const k = loadSigningKeys(env({ ERASURE_CERT_SIGNING_KEY: KEY.secret, ERASURE_CERT_VERIFY_KEYS: JSON.stringify({ k0: "o".repeat(40), bad: 5 }) }));
    expect(k.current).toEqual({ id: "k1", secret: KEY.secret });
    expect(Object.keys(k.verify).sort()).toEqual(["k0", "k1"]);
    expect(loadSigningKeys(env({ ERASURE_CERT_SIGNING_KEY: KEY.secret, ERASURE_CERT_VERIFY_KEYS: "{oops" })).current).not.toBeNull();
  });
  it("rejects an invalid key id", () => {
    expect(loadSigningKeys(env({ ERASURE_CERT_SIGNING_KEY: KEY.secret, ERASURE_CERT_KEY_ID: "a b" })).current).toBeNull();
  });
});
