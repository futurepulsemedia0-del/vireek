import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ErasureBaseline, ErasureEvidence } from "./erasureCertificate";
import { issueErasureCertificate, issueMissingCertificates, recordErasureEvidence, type DeletionRequestRow, type IssuerOptions } from "./erasureCertificateIssuer";

const baseline = JSON.parse(
  readFileSync(new URL("../../../../docs/compliance/erasure-coverage-baseline.json", import.meta.url), "utf8"),
) as ErasureBaseline;

const REQ = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";
const KEY = { id: "k1", secret: "test-secret-test-secret-test-secret-123" };
const opts = (over: Partial<IssuerOptions> = {}): IssuerOptions => ({ baseline, signingKey: KEY, backupRetentionDays: 35, now: new Date("2030-01-10T12:00:00Z"), ...over });
const request = (over: Partial<DeletionRequestRow> = {}): DeletionRequestRow => ({
  id: REQ, user_id: ACC, request_type: "full_account", status: "completed",
  scheduled_for: "2030-01-09T00:00:00Z", created_at: "2030-01-01T00:00:00Z", completed_at: "2030-01-10T11:59:00Z", ...over,
});
const evidence: ErasureEvidence = {
  ownedTables: { jobs: 1 }, catalogErase: { deleted: {}, blocked: {} }, trustPack: { ok: true },
  provider: { ok: true, skipped: [], failed: [], erased: { elevenlabsVoices: 0, vapiCalls: 0 } },
};

type Row = Record<string, unknown>;
/** Records writes; reads are served from `tables`. Every read chain is awaitable. */
function fakeAdmin(tables: Record<string, Row[] | { error: string }> = {}, insertError: { code?: string; message: string } | null = null) {
  const writes: { table: string; op: string; row: Row }[] = [];
  const reads: string[] = [];
  const admin = {
    from(table: string) {
      const res = () => {
        const t = tables[table];
        return t && !Array.isArray(t) ? { data: null, error: { message: t.error } } : { data: t ?? [], error: null };
      };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "in", "order", "limit"]) q[m] = () => q;
      q.then = (r: (v: unknown) => unknown) => Promise.resolve(res()).then(r);
      q.insert = (row: Row) => { writes.push({ table, op: "insert", row }); return Promise.resolve({ error: insertError }); };
      q.upsert = (row: Row) => { writes.push({ table, op: "upsert", row }); return Promise.resolve({ error: null }); };
      const sel = q.select as () => unknown;
      q.select = () => { reads.push(table); return sel(); };
      return q;
    },
  };
  return { admin: admin as never, writes, reads };
}

describe("issueErasureCertificate", () => {
  it("inserts one signed certificate carrying the hash and backup expiry", async () => {
    const f = fakeAdmin();
    const r = await issueErasureCertificate(f.admin, request(), evidence, opts());
    expect(r.status).toBe("issued");
    const row = f.writes[0].row;
    expect(f.writes[0].table).toBe("erasure_certificates");
    expect(row.deletion_request_id).toBe(REQ);
    expect(row.account_id).toBe(ACC);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_id).toBe("k1");
    expect(row.backup_expires_at).toBe("2030-02-14T11:59:00.000Z");
    expect(String(row.document_json)).not.toContain("@");
    expect("user_id" in row).toBe(false);
  });

  it("treats a unique violation as already issued", async () => {
    const f = fakeAdmin({}, { code: "23505", message: "duplicate key" });
    expect((await issueErasureCertificate(f.admin, request(), evidence, opts())).status).toBe("exists");
  });

  it("reports other database errors without throwing", async () => {
    const f = fakeAdmin({}, { code: "XX000", message: "boom" });
    const r = await issueErasureCertificate(f.admin, request(), evidence, opts());
    expect(r).toEqual({ status: "error", reason: "boom" });
  });

  it("skips ineligible requests and never writes", async () => {
    for (const r of [request({ status: "grace_period" }), request({ request_type: "dataset" }), request({ completed_at: null })]) {
      const f = fakeAdmin();
      expect(await issueErasureCertificate(f.admin, r, evidence, opts())).toEqual({ status: "skipped", reason: "not_eligible" });
      expect(f.writes).toHaveLength(0);
    }
  });

  it("skips when evidence or the signing key is missing", async () => {
    const f = fakeAdmin();
    expect(await issueErasureCertificate(f.admin, request(), null, opts())).toEqual({ status: "skipped", reason: "no_evidence" });
    expect(await issueErasureCertificate(f.admin, request(), evidence, opts({ signingKey: null }))).toEqual({ status: "skipped", reason: "not_configured" });
    expect(f.writes).toHaveLength(0);
  });

  it("converts unexpected failures (bad input) into an error result", async () => {
    const f = fakeAdmin();
    const r = await issueErasureCertificate(f.admin, request({ id: "not-a-uuid" }), evidence, opts());
    expect(r.status).toBe("error");
  });
});

describe("recordErasureEvidence", () => {
  it("upserts evidence keyed by the deletion request", async () => {
    const f = fakeAdmin();
    expect(await recordErasureEvidence(f.admin, { id: REQ, user_id: ACC }, evidence)).toBeNull();
    expect(f.writes[0].table).toBe("erasure_job_evidence");
    expect(f.writes[0].op).toBe("upsert");
    expect(f.writes[0].row.account_id).toBe(ACC);
  });
});

describe("issueMissingCertificates", () => {
  it("issues only for evidence rows without a certificate", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const f = fakeAdmin({
      erasure_job_evidence: [{ deletion_request_id: REQ, evidence }, { deletion_request_id: other, evidence }],
      erasure_certificates: [{ deletion_request_id: other }],
      deletion_requests: [request() as unknown as Row],
    });
    const s = await issueMissingCertificates(f.admin, opts());
    expect(s).toEqual({ issued: 1, exists: 0, skipped: 0, errors: [] });
    expect(f.writes.filter((w) => w.table === "erasure_certificates")).toHaveLength(1);
  });

  it("does nothing, and reads nothing, when no key is configured", async () => {
    const f = fakeAdmin({ erasure_job_evidence: [{ deletion_request_id: REQ, evidence }] });
    const s = await issueMissingCertificates(f.admin, opts({ signingKey: null }));
    expect(s.issued).toBe(0);
    expect(f.reads).toHaveLength(0);
  });

  it("skips evidence whose request is not a completed full-account request", async () => {
    const f = fakeAdmin({ erasure_job_evidence: [{ deletion_request_id: REQ, evidence }], erasure_certificates: [], deletion_requests: [] });
    const s = await issueMissingCertificates(f.admin, opts());
    expect(s.skipped).toBe(1);
    expect(f.writes).toHaveLength(0);
  });

  it("surfaces load errors instead of swallowing them", async () => {
    const f = fakeAdmin({ erasure_job_evidence: { error: "denied" } });
    const s = await issueMissingCertificates(f.admin, opts());
    expect(s.errors[0]).toContain("denied");
  });
});
