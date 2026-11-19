// Contract test for docs/security/public-endpoints.md: guards the decisions taken for the 15 "no-auth" functions
// and the 6 unsigned inbound endpoints against regression. Static (reads source), runs with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fn = (n) => fs.readFileSync(path.join(root, "supabase/functions", n, "index.ts"), "utf8");
const config = fs.readFileSync(path.join(root, "supabase/config.toml"), "utf8");
const policy = JSON.parse(fs.readFileSync(path.join(root, "docs/security/function-policy.json"), "utf8")).declared;
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const idx = (src, needle) => { const i = strip(src).indexOf(needle); assert.notEqual(i, -1, `missing: ${needle}`); return i; };

const CRON = ["analyze-equipment-lifecycle", "business-immune-scan"];
const PUBLIC_GUARDED = { "careers-sitemap": false, "status-feed": false, "job-feeds": false, "google-booking-feed": false, "punchout-return": true, "video-ice": true };
const PUBLIC_DB_LIMITED = ["event-register", "warranty-register", "membership-join-checkout", "exit-dataroom-public"];
const CALLBACKS = { "acct-oauth-callback": "acct-oauth-start", "crm-oauth-callback": "crm-oauth-start", "google-calendar-oauth-callback": "google-calendar-oauth-start", "hubspot-oauth-callback": "hubspot-oauth-start" };
const ALL = [...CRON, "email-campaign-dispatcher", "dispatch-optimizer", ...Object.keys(PUBLIC_GUARDED), ...PUBLIC_DB_LIMITED, "fabric-ingest", "synthetic-webhook-sink", ...Object.keys(CALLBACKS)];

test("every function is declared in function-policy.json and has an explicit config.toml entry", () => {
  for (const n of ALL) {
    assert.ok(policy[n]?.auth, `${n}: missing policy declaration`);
    assert.match(config, new RegExp(`\\[functions\\.${n}\\]`), `${n}: missing config.toml entry`);
  }
  for (const n of [...Object.keys(PUBLIC_GUARDED), ...PUBLIC_DB_LIMITED]) {
    assert.equal(policy[n].auth, "public");
    assert.ok(String(policy[n].justification).length > 40, `${n}: justification too short`);
  }
});

test("cron-only functions authenticate before touching any data", () => {
  for (const n of [...CRON, "email-campaign-dispatcher"]) {
    const s = fn(n);
    const auth = idx(s, n === "email-campaign-dispatcher" ? "secretEquals(" : "requireCronAuth(req)");
    const st = strip(s), handler = st.indexOf("Deno.serve");
    assert.ok(auth > handler && auth < st.indexOf(".from(", handler), `${n}: auth must be inside the handler and precede its first query`);
    assert.ok(!/Allow-Origin/.test(strip(s)) || n === "email-campaign-dispatcher", `${n}: no browser CORS`);
  }
  assert.doesNotMatch(strip(fn("email-campaign-dispatcher")), /auth !== serviceKey/, "plain (non constant-time) compare is back");
});

test("dispatch-optimizer requires a real signed-in user", () => {
  const s = fn("dispatch-optimizer");
  assert.ok(idx(s, "auth.getUser(") < idx(s, "dispatch_optimizer_access"));
});

test("public endpoints are rate limited, with the right failure policy", () => {
  for (const [n, closed] of Object.entries(PUBLIC_GUARDED)) {
    const s = strip(fn(n));
    assert.match(s, /guardPublic\(req,/, `${n}: no rate limit`);
    assert.match(s, new RegExp(`failClosed: ${closed}`), `${n}: wrong failure policy`);
  }
  for (const n of PUBLIC_DB_LIMITED) assert.match(strip(fn(n)), /rate[_-]?limit/i, `${n}: lost its rate limit`);
});

test("OAuth start records and callback redeems the state (replay + session binding)", () => {
  for (const [cb, start] of Object.entries(CALLBACKS)) {
    const c = strip(fn(cb)), st = strip(fn(start));
    assert.match(st, /recordIssuedState\(/, `${start}: must record the issued state`);
    assert.match(c, /redeemIssuedState\(/, `${cb}: must redeem the state`);
    const redeem = c.indexOf("redeemIssuedState(");
    const firstExternal = Math.min(...["fetch(", "saveSecrets(", "upsert(", "insert(", "exchange"].map((k) => c.indexOf(k, redeem + 20)).filter((i) => i > -1));
    assert.ok(redeem < firstExternal, `${cb}: state must be redeemed BEFORE any token exchange or write`);
    assert.match(c, /\.ok\b/, `${cb}: must check the redeem result`);
  }
  for (const cb of ["google-calendar-oauth-callback", "hubspot-oauth-callback"])
    assert.match(fn(cb), /import \{ saveSecrets \}/, `${cb}: saveSecrets import regression`);
});

test("fabric-ingest and synthetic-webhook-sink verify an HMAC over the raw body before parsing", () => {
  for (const [n, parse] of [["fabric-ingest", "JSON.parse(text)"], ["synthetic-webhook-sink", "JSON.parse(raw)"]]) {
    const s = strip(fn(n));
    assert.ok(idx(s, "verifyInboundSignature(") < idx(s, parse) || !s.includes(parse), `${n}: verify before parse`);
    assert.match(s, /applySignedInboundPolicy\(/);
    assert.match(s, /guardPublic\(req,/);
    assert.match(s, /replay: dbReplayStore\(/);
  }
  assert.doesNotMatch(strip(fn("fabric-ingest")), /Allow-Origin/);
});
