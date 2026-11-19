// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handlePhotoProvenance } from "./handler.ts";
import { expectedPath, sha256Hex } from "./core.ts";
import { nodeC2paDeps } from "../photo-authenticity/c2paNodeDeps.testkit.ts";
import { ANALYZER_VERSION } from "../photo-authenticity/types.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const CAPTURE = "55555555-5555-4555-8555-555555555555";
const bytes = new Uint8Array(readFileSync(new URL("../photo-authenticity/fixtures/sample-edited-software.jpg", import.meta.url)));

async function fixture(opts: { stored?: Uint8Array | null; capture?: Record<string, unknown> | null; existing?: Record<string, unknown> | null; withC2pa?: boolean; rpcError?: string } = {}) {
  const sha = await sha256Hex(bytes);
  const path = expectedPath(OWNER, JOB, sha, "image/jpeg");
  const calls: { name: string; args: unknown }[] = [];
  const row = opts.capture === undefined
    ? { id: CAPTURE, job_id: JOB, user_id: OWNER, original_sha256: sha, original_path: path, original_bytes: bytes.length, original_mime: "image/jpeg",
        capture_source: "gallery_import", device_captured_at: null, device_time_status: "missing", offline_queued: false,
        server_received_at: "2026-11-10T09:05:00Z", files_erased_at: null }
    : opts.capture;
  const stored = opts.stored === undefined ? bytes : opts.stored;
  const admin = {
    auth: { getUser: async (jwt: string) => (jwt === "good" ? { data: { user: { id: ACTOR } }, error: null } : { data: null, error: { message: "bad" } }) },
    storage: { from: () => ({ download: async () => (stored ? { data: new Blob([stored as BlobPart]), error: null } : { data: null, error: { message: "nf" } }) }) },
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "jobs" ? { arrived_at: "2026-11-10T08:00:00Z", started_at: null, completed_at: null } : null }) }) }) }) }),
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === "evp_store_authenticity" && opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      return { data: { ok: true }, error: null };
    },
  };
  const user = {
    rpc: async (name: string) => (name === "get_account_owner_id" ? { data: OWNER, error: null } : { data: null, error: null }),
    from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "evidence_photo_captures" ? row : (opts.existing ?? null) }) }) }) }),
  };
  const deps = {
    createClient: (_u: string, key: string) => (key === "anon" ? user : admin),
    env: (n: string) => ({ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon" } as Record<string, string>)[n],
    c2pa: opts.withC2pa === false ? undefined : async () => nodeC2paDeps(),
  };
  const post = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer good" }) =>
    handlePhotoProvenance(new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) }), deps);
  return { post, calls, sha };
}
const body = { action: "analyze_authenticity", capture_id: CAPTURE };

describe("analyze_authenticity", () => {
  it("analyses verified bytes and stores with server-derived identity", async () => {
    const f = await fixture();
    const res = await f.post(body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.report.consistency.notAVerdict).toBe(true);
    expect(json.report.consistency.reasons.map((r: { code: string }) => r.code)).toContain("editing_software");
    const call = f.calls.find((c) => c.name === "evp_store_authenticity")!.args as Record<string, unknown>;
    expect(call.p_owner).toBe(OWNER);          // from the account, never from the body
    expect(call.p_sha256).toBe(f.sha);
    expect(call.p_version).toBe(ANALYZER_VERSION);
  });
  it("ignores owner/hash values smuggled in the body", async () => {
    const f = await fixture();
    await f.post({ ...body, owner_id: OTHER_OWNER, p_owner: OTHER_OWNER, sha256: "0".repeat(64) });
    const call = f.calls.find((c) => c.name === "evp_store_authenticity")!.args as Record<string, unknown>;
    expect(call.p_owner).toBe(OWNER);
    expect(call.p_sha256).toBe(f.sha);
  });
  it("returns the stored report without recomputing when the version is current", async () => {
    const f = await fixture({ existing: { analyzer_version: ANALYZER_VERSION, report: { cached: "yes" } } });
    const json = await (await f.post(body)).json();
    expect(json.cached).toBe(true);
    expect(f.calls.some((c) => c.name === "evp_store_authenticity")).toBe(false);
  });
  it("recomputes when the stored report is from an older analyzer", async () => {
    const f = await fixture({ existing: { analyzer_version: "pa-0.0.1", report: {} } });
    expect((await (await f.post(body)).json()).cached).toBe(false);
    expect(f.calls.some((c) => c.name === "evp_store_authenticity")).toBe(true);
  });
  it("cross-tenant: a capture RLS hides, or one owned by another account, is 403 and nothing is stored", async () => {
    const hidden = await fixture({ capture: null });
    expect((await hidden.post(body)).status).toBe(403);
    expect(hidden.calls.length).toBe(0);
    const foreign = await fixture({ capture: { id: CAPTURE, user_id: OTHER_OWNER, files_erased_at: null } });
    expect((await foreign.post(body)).status).toBe(403);
    expect(foreign.calls.length).toBe(0);
  });
  it("stored bytes that no longer match the seal => 422, nothing stored", async () => {
    const f = await fixture({ stored: new Uint8Array([...bytes.subarray(0, bytes.length - 1), bytes[bytes.length - 1] ^ 1]) });
    expect((await f.post(body)).status).toBe(422);
    expect(f.calls.some((c) => c.name === "evp_store_authenticity")).toBe(false);
  });
  it("erased files => 410", async () => {
    const f = await fixture({ capture: { id: CAPTURE, user_id: OWNER, files_erased_at: "2026-11-01T00:00:00Z" } });
    expect((await f.post(body)).status).toBe(410);
  });
  it("rejects missing auth and malformed ids", async () => {
    const f = await fixture();
    expect((await f.post(body, {})).status).toBe(401);
    expect((await f.post(body, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await f.post({ ...body, capture_id: "not-a-uuid" })).status).toBe(400);
    expect(f.calls.length).toBe(0);
  });
  it("still produces a metadata-only report when the C2PA reader is not available", async () => {
    const f = await fixture({ withC2pa: false });
    const json = await (await f.post(body)).json();
    expect(json.report.c2pa.status).toBe("unavailable");
    expect(json.report.consistency.reasons.length).toBeGreaterThan(0);
  });
  it("maps a SQL rejection to a generic error without leaking details", async () => {
    const f = await fixture({ rpcError: "boom internal table detail" });
    const res = await f.post(body);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("internal table");
  });
});
