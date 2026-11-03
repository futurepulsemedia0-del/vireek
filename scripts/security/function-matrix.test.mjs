// Unit tests for scripts/security/function-matrix.mjs (synthetic repo fixtures in a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeFunction, configIntegrity, evaluateRules, fixConfigText, gate, makeBaseline, parseVerifyJwt } from "./function-matrix.mjs";
import { stripComments } from "./lib.mjs";

const dirs = [];
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vireek-sec-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const analyze = (root, name, verifyJwt = true, declared = {}) => analyzeFunction({ root, name, verifyJwt, policy: { declared } });

describe("stripComments", () => {
  it("drops comments but keeps URLs inside strings", () => {
    const out = stripComments('const u = "https://x.test/a"; // --no-verify-jwt\n/* getUser( */ const y = 1;');
    expect(out).toContain("https://x.test/a");
    expect(out).not.toContain("no-verify-jwt");
    expect(out).not.toContain("getUser(");
  });
});

describe("parseVerifyJwt", () => {
  it("reads per-function verify_jwt and ignores other tables", () => {
    const m = parseVerifyJwt("[functions.a]\nverify_jwt = false\n[api]\nverify_jwt = true\n[functions.b]\nverify_jwt = true # c\n");
    expect([...m]).toEqual([["a", false], ["b", true]]);
  });
});

describe("analyzeFunction", () => {
  it("detects an in-function JWT check, rate limit and tests", () => {
    const root = repo({
      "supabase/functions/ok/index.ts": 'const { data } = await sb.auth.getUser(jwt); await rateLimit(req); if (typeof body.id !== "string") throw 1;',
      "supabase/functions/ok/index.test.ts": "// test",
    });
    const r = analyze(root, "ok");
    expect(r.authModes).toContain("jwt");
    expect(r.rateLimit).toBe(true);
    expect(r.validation).toBe("manual");
    expect(r.tests).toBe("own");
    expect(r.violations).toEqual([]);
  });

  it("ignores patterns that only appear in comments", () => {
    const root = repo({ "supabase/functions/c/index.ts": "// auth.getUser( rateLimit timingSafeEqual\nDeno.serve(() => new Response('x'));" });
    const r = analyze(root, "c");
    expect(r.authModes).not.toContain("jwt");
    expect(r.rateLimit).toBe(false);
  });

  it("flags a public endpoint (verify_jwt=false, no credential) without rate limit and validation", () => {
    const root = repo({ "supabase/functions/pub/index.ts": "Deno.serve(() => new Response('hi'));" });
    const r = analyze(root, "pub", false);
    expect(r.authModes).toContain("public");
    expect(r.violations).toEqual(expect.arrayContaining(["no-auth", "public-no-rate-limit", "public-no-validation"]));
  });

  it("treats a header-declared --no-verify-jwt as public even when config.toml says true, and reports drift", () => {
    const root = repo({ "supabase/functions/hdr/index.ts": "// Deploy: supabase functions deploy hdr --no-verify-jwt\nDeno.serve(() => new Response('x'));" });
    const r = analyze(root, "hdr", true);
    expect(r.verifyJwt).toBe(false);
    expect(r.violations).toContain("config-drift");
  });

  it("does not treat 'do NOT use --no-verify-jwt' as a public declaration", () => {
    const root = repo({ "supabase/functions/neg/index.ts": "// JWT verified; do NOT use --no-verify-jwt\nDeno.serve(() => new Response('x'));" });
    expect(analyze(root, "neg", true).verifyJwt).toBe(true);
  });

  it("flags a gateway-JWT-only function (anon key would pass the gateway)", () => {
    const root = repo({ "supabase/functions/gw/index.ts": "Deno.serve(() => new Response('x'));" });
    expect(analyze(root, "gw", true).violations).toContain("gateway-jwt-only");
  });

  it("flags an inbound webhook without signature verification", () => {
    const root = repo({ "supabase/functions/foo-webhook/index.ts": "Deno.serve(async (r) => { await r.json(); return new Response('ok'); });" });
    expect(analyze(root, "foo-webhook", false).violations).toContain("webhook-no-signature");
  });

  it("requires BOTH timestamp tolerance and a replay store for webhook-replay compliance", () => {
    const sigOnly = repo({ "supabase/functions/a-webhook/index.ts": "const ok = verifyWebhookSignature(body, h);" });
    expect(analyze(sigOnly, "a-webhook", false).violations).toContain("webhook-no-replay");
    const full = repo({
      "supabase/functions/b-webhook/index.ts":
        "const ok = verifyWebhookSignature(body, h); const tolerance = 300; const age = Math.abs(Date.now() - ts); await db.from('webhook_events').insert({ event_id });",
    });
    const r = analyze(full, "b-webhook", false);
    expect(r.webhook).toEqual({ signature: true, timestampTolerance: true, replayStore: true });
    expect(r.violations).not.toContain("webhook-no-replay");
  });

  it("follows imports into _shared (rate limiting provided by a shared helper counts)", () => {
    const root = repo({
      "supabase/functions/imp/index.ts": 'import { guard } from "../_shared/guard.ts"; guard();',
      "supabase/functions/_shared/guard.ts": "export const guard = () => rateLimit();",
    });
    expect(analyze(root, "imp").rateLimit).toBe(true);
  });

  it("flags fail-open secrets and non-constant-time comparisons", () => {
    const root = repo({
      "supabase/functions/fo/index.ts": 'const expectedSecret = Deno.env.get("X_SECRET"); if (expectedSecret && new URL(u).searchParams.get("secret") !== expectedSecret) return deny();',
    });
    const r = analyze(root, "fo", false);
    expect(r.violations).toEqual(expect.arrayContaining(["fail-open-secret", "plain-secret-compare"]));
    expect(r.secrets).toContain("X_SECRET");
  });

  it("recognises capability tokens and API keys as credentials", () => {
    const root = repo({
      "supabase/functions/cap/index.ts": 'const { data } = await db.from("quotes").select("*").eq("quote_token", token);',
      "supabase/functions/key/index.ts": 'const k = req.headers.get("x-api-key");',
    });
    expect(analyze(root, "cap", false).authModes).toContain("capability-token");
    expect(analyze(root, "key", false).authModes).toContain("api-key");
  });
});

describe("evaluateRules", () => {
  const base = { verifyJwt: false, authModes: ["public"], rateLimit: false, validation: "none", inboundWebhook: false, webhook: {}, tenancy: "none", cors: "none", tests: "own" };
  it("honours a declared public function but still demands rate limit and validation", () => {
    const v = evaluateRules(base, { auth: "public" });
    expect(v).toEqual(["public-no-rate-limit", "public-no-validation"]);
  });
});

describe("gate (ratchet)", () => {
  const row = (over) => ({ name: "f", authModes: ["jwt"], violations: [], ...over });
  it("fails a NEW function that has no declared metadata", () => {
    const errors = gate([row()], { declared: {} }, { functions: {} });
    expect(errors.join("\n")).toMatch(/no entry in docs\/security\/function-policy\.json/);
  });
  it("fails when declared auth is not backed by the code", () => {
    const errors = gate([row()], { declared: { f: { auth: "webhook-signature", risk: "high", owner: "x" } } }, { functions: {} });
    expect(errors.join("\n")).toMatch(/not backed by the code/);
  });
  it("requires a justification for public functions", () => {
    const errors = gate([row({ authModes: ["public"] })], { declared: { f: { auth: "public", risk: "low", owner: "x" } } }, { functions: {} });
    expect(errors.join("\n")).toMatch(/justification/);
  });
  it("passes a compliant new function", () => {
    expect(gate([row()], { declared: { f: { auth: "jwt", risk: "low", owner: "platform" } } }, { functions: {} })).toEqual([]);
  });
  it("tolerates frozen legacy violations but fails regressions", () => {
    const legacy = { functions: { f: ["no-tests"] } };
    expect(gate([row({ violations: ["no-tests"] })], { declared: {} }, legacy)).toEqual([]);
    const errors = gate([row({ violations: ["no-tests", "no-auth"] })], { declared: {} }, legacy);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no-auth.*regression/);
  });
  it("makeBaseline never freezes brand-new functions once a baseline exists", () => {
    const next = makeBaseline([row({ name: "old", violations: ["no-tests"] }), row({ name: "new", violations: ["no-tests"] })], { functions: { old: [] } });
    expect(Object.keys(next.functions)).toEqual(["old"]);
  });
});

describe("config.toml integrity", () => {
  it("reports duplicates and stale entries; fixConfigText repairs them", () => {
    const toml = "[functions.a]\nverify_jwt = false\n[functions.a]\nverify_jwt = false\n[functions.gone]\nverify_jwt = false\n";
    const root = repo({ "supabase/config.toml": toml, "supabase/functions/a/index.ts": "x", "supabase/functions/b/index.ts": "// --no-verify-jwt" });
    expect(configIntegrity(root).join("\n")).toMatch(/duplicate table \[functions\.a\]/);
    expect(configIntegrity(root).join("\n")).toMatch(/\[functions\.gone\] has no/);
    const fixed = fixConfigText(toml, new Set(["a", "b"]), ["b"]);
    expect(fixed.match(/\[functions\.a\]/g)).toHaveLength(1);
    expect(fixed).not.toContain("gone");
    expect(fixed).toContain("[functions.b]\nverify_jwt = false");
  });
});
