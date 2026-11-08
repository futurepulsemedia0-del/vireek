// Run: node --experimental-strip-types --test supabase/functions/_shared/photo-provenance/handler.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePhotoProvenance } from "./handler.ts";
import { expectedPath, parseCaptureRequest, sha256Hex, timingSafeEqual } from "./core.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const CAPTURE = "55555555-5555-4555-8555-555555555555";

const bytes = new TextEncoder().encode("pretend-jpeg-bytes");

async function fixture(opts: { stored?: Uint8Array | null; recent?: number; erasureAllowed?: boolean; removeError?: boolean } = {}) {
  const sha = await sha256Hex(bytes);
  const path = expectedPath(OWNER, JOB, sha, "image/jpeg");
  const calls: { name: string; args: unknown }[] = [];
  const stored = opts.stored === undefined ? bytes : opts.stored;
  const admin = {
    auth: { getUser: async (jwt: string) => (jwt === "good" ? { data: { user: { id: ACTOR } }, error: null } : { data: null, error: { message: "bad" } }) },
    storage: {
      from: () => ({
        download: async () => (stored ? { data: new Blob([stored as BlobPart]), error: null } : { data: null, error: { message: "nf" } }),
        remove: async (paths: string[]) => { calls.push({ name: "remove", args: paths }); return { error: opts.removeError ? { message: "x" } : null }; },
      }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { job_id: JOB, user_id: OWNER } }) }) }) }),
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === "evp_recent_capture_count") return { data: opts.recent ?? 0, error: null };
      if (name === "evp_record_capture") return { data: { duplicate: false, capture_id: CAPTURE }, error: null };
      if (name === "evp_register_derivative") return { data: { derivative_id: "d" }, error: null };
      if (name === "evp_capture_file_paths") return { data: [path], error: null };
      if (name === "evp_mark_files_erased") return { data: true, error: null };
      if (name === "evp_retention_sweep") return { data: { locations_purged: 2, erase_capture_ids: [CAPTURE] }, error: null };
      return { data: null, error: null };
    },
  };
  const user = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name: `user:${name}`, args });
      if (name === "get_account_owner_id") return { data: OWNER, error: null };
      if (name === "request_evidence_photo_erasure") return { data: opts.erasureAllowed ?? true, error: null };
      return { data: null, error: null };
    },
  };
  const deps = {
    createClient: (_u: string, key: string) => (key === "anon" ? user : admin),
    env: (n: string) => ({ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon", PHOTO_PROVENANCE_CRON_SECRET: "super-secret-cron-value" })[n],
  };
  const post = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer good" }) =>
    handlePhotoProvenance(new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) }), deps);
  const capture = (over: Record<string, unknown> = {}) => ({
    action: "record_capture", job_id: JOB, client_capture_id: CLIENT_ID,
    original: { path, sha256: sha, mime: "image/jpeg", bytes: bytes.length },
    source: "in_app_camera", device_captured_at: "2028-11-03T10:00:00Z", offline: false, ...over,
  });
  return { post, calls, capture, sha, path };
}

test("happy path: re-hashes stored bytes, then writes the capture with server-derived identity", async () => {
  const f = await fixture();
  const res = await f.post(f.capture({ location: { lat: 52.52, lng: 13.4, accuracy_m: 8 } }));
  assert.equal(res.status, 200);
  const rec = f.calls.find((c) => c.name === "evp_record_capture")!.args as Record<string, unknown>;
  assert.equal(rec.p_owner, OWNER);
  assert.equal(rec.p_actor, ACTOR);            // from the JWT, never from the body
  assert.equal(rec.p_sha256, f.sha);
  assert.deepEqual(rec.p_location, { lat: 52.52, lng: 13.4, accuracy_m: 8 });
});

test("tamper: stored bytes differ from the claimed hash -> 422 and nothing is written", async () => {
  const f = await fixture({ stored: new TextEncoder().encode("different-bytes!!") });
  const res = await f.post(f.capture());
  assert.equal(res.status, 422);
  assert.equal(f.calls.some((c) => c.name === "evp_record_capture"), false);
});

test("size mismatch -> 422", async () => {
  const f = await fixture();
  const res = await f.post(f.capture({ original: { path: f.path, sha256: f.sha, mime: "image/jpeg", bytes: bytes.length + 1 } }));
  assert.equal(res.status, 422);
});

test("missing stored file -> 422", async () => {
  const f = await fixture({ stored: null });
  assert.equal((await f.post(f.capture())).status, 422);
});

test("cross-tenant path is rejected before any download or write", async () => {
  const f = await fixture();
  const other = expectedPath("99999999-9999-4999-8999-999999999999", JOB, f.sha, "image/jpeg");
  const res = await f.post(f.capture({ original: { path: other, sha256: f.sha, mime: "image/jpeg", bytes: bytes.length } }));
  assert.equal(res.status, 400);
  assert.equal(f.calls.some((c) => c.name === "evp_record_capture"), false);
});

test("path that is not content-addressed (path traversal / wrong stem) is rejected", async () => {
  const f = await fixture();
  for (const p of [`${OWNER}/${JOB}/photo/../x.jpg`, `${OWNER}/${JOB}/photo/${"a".repeat(64)}.jpg`]) {
    const res = await f.post(f.capture({ original: { path: p, sha256: f.sha, mime: "image/jpeg", bytes: bytes.length } }));
    assert.equal(res.status, 400);
  }
});

test("auth: missing or invalid token -> 401", async () => {
  const f = await fixture();
  assert.equal((await f.post(f.capture(), {})).status, 401);
  assert.equal((await f.post(f.capture(), { Authorization: "Bearer nope" })).status, 401);
});

test("throttle: too many captures in the last hour -> 429", async () => {
  const f = await fixture({ recent: 150 });
  assert.equal((await f.post(f.capture())).status, 429);
});

test("invalid source and redacted-at-capture are rejected", async () => {
  const f = await fixture();
  assert.equal((await f.post(f.capture({ source: "magic" }))).status, 400);
  const d = { path: f.path, sha256: f.sha, mime: "image/jpeg", bytes: bytes.length, kind: "redacted" };
  assert.equal((await f.post(f.capture({ derivatives: [d] }))).status, 400);
});

test("out-of-range coordinates are dropped, not trusted", () => {
  const sha = "a".repeat(64);
  const parsed = parseCaptureRequest({
    job_id: JOB, client_capture_id: CLIENT_ID, source: "unknown",
    original: { path: expectedPath(OWNER, JOB, sha, "image/png"), sha256: sha, mime: "image/png", bytes: 5 },
    location: { lat: 999, lng: 0 },
  }, OWNER);
  assert.equal(parsed.location, null);
});

test("derivative registration verifies bytes and passes the parent hash", async () => {
  const f = await fixture();
  const res = await f.post({ action: "register_derivative", capture_id: CAPTURE, parent_sha256: "b".repeat(64),
    derivative: { path: f.path, sha256: f.sha, mime: "image/jpeg", bytes: bytes.length, kind: "redacted", width: 10, height: 10, transform: { type: "redaction", regions: 2 } } });
  assert.equal(res.status, 200);
  const args = f.calls.find((c) => c.name === "evp_register_derivative")!.args as Record<string, unknown>;
  assert.equal(args.p_parent, "b".repeat(64));
  assert.equal(args.p_kind, "redacted");
});

test("erase: SQL authorizes under the caller's JWT, then files are removed, then marked", async () => {
  const f = await fixture();
  const res = await f.post({ action: "erase", capture_id: CAPTURE });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls.map((c) => c.name).filter((n) => n !== "user:get_account_owner_id"),
    ["user:request_evidence_photo_erasure", "evp_capture_file_paths", "remove", "evp_mark_files_erased"]);
});

test("erase denied by SQL -> 403 and no file is touched", async () => {
  const f = await fixture({ erasureAllowed: false });
  assert.equal((await f.post({ action: "erase", capture_id: CAPTURE })).status, 403);
  assert.equal(f.calls.some((c) => c.name === "remove"), false);
});

test("erase: storage failure is not marked as erased", async () => {
  const f = await fixture({ removeError: true });
  assert.equal((await f.post({ action: "erase", capture_id: CAPTURE })).status, 502);
  assert.equal(f.calls.some((c) => c.name === "evp_mark_files_erased"), false);
});

test("maintenance requires the cron secret", async () => {
  const f = await fixture();
  assert.equal((await f.post({ action: "maintenance" }, { "x-cron-secret": "wrong-wrong-wrong-wrong" })).status, 401);
  assert.equal((await f.post({ action: "maintenance" }, {})).status, 401);
  const ok = await f.post({ action: "maintenance" }, { "x-cron-secret": "super-secret-cron-value" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { locations_purged: 2, files_erased: 1, failed: [] });
});

test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
});
