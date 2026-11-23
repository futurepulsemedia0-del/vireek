import { describe, expect, it } from "vitest";
import { buildCertificatePayload, signCertificatePayload, type ErasureBaseline } from "./erasureCertificate";
import { handleErasureCertificateRequest, type CertClient, type HandlerDeps } from "./erasureCertificateHandler";

const REQ = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-secret-test-secret-test-secret-123";
const URL_BASE = "https://x.test/functions/v1/erasure-certificate";

const baseline: ErasureBaseline = {
  certificate: {
    schemaVersion: 1,
    systems: [{ id: "postgres-owned-tables", name: "DB", automated: true, evidenceKey: "ownedTables" }],
    subprocessors: [{ id: "twilio", name: "Twilio", automated: false, gap: "not covered" }],
  },
  uncovered: ["a", "b"],
};

async function storedRow(number = "VRK-ERC-0123456789AB") {
  const payload = await buildCertificatePayload({
    deletionRequestId: REQ, accountId: ACC, requestedAt: "2030-01-01T00:00:00Z", scheduledFor: "2030-01-09T00:00:00Z",
    completedAt: "2030-01-10T00:00:00Z", evidence: { ownedTables: { jobs: 1 } }, baseline, backupRetentionDays: 30, now: new Date("2030-01-10T01:00:00Z"),
  });
  const s = await signCertificatePayload(payload, { id: "k1", secret: SECRET });
  return { certificate_number: number, document_json: s.documentJson, sha256: s.sha256, status: payload.status, issued_at: payload.issuedAt };
}

interface Fake { client: CertClient; eqCalls: [string, string][]; tokens: string[] }
function fake(opts: { user?: { id: string } | null; row?: Record<string, unknown> | null; list?: Record<string, unknown>[]; dbError?: string }): Fake & { deps: HandlerDeps } {
  const eqCalls: [string, string][] = [];
  const tokens: string[] = [];
  const client = {
    auth: { getUser: async (t: string) => { tokens.push(t); return { data: { user: opts.user === undefined ? { id: ACC } : opts.user }, error: opts.user === null ? { message: "bad" } : null }; } },
    from: () => ({
      select: () => ({
        eq: (c: string, v: string) => { eqCalls.push([c, v]); return { maybeSingle: async () => ({ data: opts.row ?? null, error: opts.dbError ? { message: opts.dbError } : null }) }; },
        order: () => ({ limit: async () => ({ data: opts.list ?? [], error: opts.dbError ? { message: opts.dbError } : null }) }),
      }),
    }),
  } as unknown as CertClient;
  const created: string[] = [];
  const deps: HandlerDeps = { createUserClient: (t) => { created.push(t); return client; }, verifyKeys: { k1: SECRET } };
  return { client, eqCalls, tokens: created, deps };
}
const get = (qs = "", headers: Record<string, string> = { authorization: "Bearer tok" }, method = "GET") =>
  new Request(`${URL_BASE}${qs}`, { method, headers });

describe("erasure-certificate handler", () => {
  it("answers CORS preflight and rejects other methods", async () => {
    const f = fake({});
    expect((await handleErasureCertificateRequest(get("", {}, "OPTIONS"), f.deps)).status).toBe(204);
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`, {}, "POST"), f.deps);
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toContain("GET");
  });

  it("requires a bearer token (401) before touching the database", async () => {
    const f = fake({});
    for (const h of [{}, { authorization: "Basic abc" }, { authorization: "Bearer " }]) {
      const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`, h as Record<string, string>), f.deps);
      expect(r.status).toBe(401);
    }
    expect(f.eqCalls).toHaveLength(0);
  });

  it("returns 401 for an invalid or expired session", async () => {
    const f = fake({ user: null });
    expect((await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), f.deps)).status).toBe(401);
    expect(f.eqCalls).toHaveLength(0);
  });

  it("returns 503 when the runtime is not configured", async () => {
    const f = fake({});
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), { ...f.deps, createUserClient: () => null });
    expect(r.status).toBe(503);
  });

  it("validates the request id and verify flag (400)", async () => {
    const f = fake({});
    expect((await handleErasureCertificateRequest(get("?deletionRequestId=abc"), f.deps)).status).toBe(400);
    expect((await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}' OR 1=1`), f.deps)).status).toBe(400);
    expect((await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}&verify=yes`), f.deps)).status).toBe(400);
    expect(f.eqCalls).toHaveLength(0);
  });

  it("uses the caller's own token for every database read (RLS is the authority)", async () => {
    const f = fake({ row: await storedRow() });
    await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`, { authorization: "Bearer caller-token" }), f.deps);
    expect(f.tokens).toEqual(["caller-token"]);
  });

  it("returns an identical 404 for a certificate that is not visible to the caller", async () => {
    const f = fake({ row: null });
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), f.deps);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.code).toBe("not_found");
    expect(JSON.stringify(body)).not.toContain(ACC);
  });

  it("downloads the exact stored document as a non-cacheable attachment", async () => {
    const row = await storedRow();
    const f = fake({ row });
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), f.deps);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(row.document_json);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="VRK-ERC-0123456789AB.json"');
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-certificate-sha256")).toBe(row.sha256);
    expect(f.eqCalls).toEqual([["deletion_request_id", REQ]]);
  });

  it("never puts an unexpected certificate number into the filename header", async () => {
    const row = await storedRow('evil"\r\nSet-Cookie: x=1');
    const f = fake({ row });
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), f.deps);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="certificate.json"');
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("verifies an intact certificate", async () => {
    const f = fake({ row: await storedRow() });
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}&verify=1`), f.deps);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.valid).toBe(true);
    expect(body.checks.signatureValid).toBe(true);
    expect(body.document_json).toBeUndefined();
  });

  it("reports a tampered stored document as invalid", async () => {
    const row = await storedRow();
    const doc = JSON.parse(row.document_json);
    doc.status = "completed_with_exceptions";
    const f = fake({ row: { ...row, document_json: JSON.stringify(doc) } });
    const body = await (await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}&verify=1`), f.deps)).json();
    expect(body.valid).toBe(false);
    expect(body.checks.hashMatches).toBe(false);
  });

  it("returns 503 for verify when no keys are configured, but still serves downloads", async () => {
    const row = await storedRow();
    const f = fake({ row });
    const deps = { ...f.deps, verifyKeys: {} };
    expect((await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}&verify=1`), deps)).status).toBe(503);
    expect((await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), deps)).status).toBe(200);
  });

  it("lists only metadata, never the document body", async () => {
    const f = fake({ list: [{ deletion_request_id: REQ, certificate_number: "VRK-ERC-0123456789AB", status: "completed", issued_at: "2030-01-10T01:00:00Z", backup_expires_at: null, sha256: "a".repeat(64) }] });
    const r = await handleErasureCertificateRequest(get(""), f.deps);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.certificates).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("document_json");
  });

  it("does not leak database error text", async () => {
    const f = fake({ dbError: 'relation "erasure_certificates" secret detail' });
    const r = await handleErasureCertificateRequest(get(`?deletionRequestId=${REQ}`), f.deps);
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret detail");
  });
});
