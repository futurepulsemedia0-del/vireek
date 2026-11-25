// Run: node --experimental-strip-types --no-warnings --test supabase/functions/_shared/licensing/gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { LICENSING_CAPABILITIES, checkLicensingGate, parseLicensingDecision, requireLicensingGate } from "./gate.ts";

const client = (result) => ({ rpc: async () => result });
const throwing = { rpc: async () => { throw new Error("network"); } };

test("only an explicit allowed:true opens the gate", () => {
  assert.deepEqual(parseLicensingDecision({ allowed: true, reason: null }), { allowed: true, reason: null });
  for (const bad of [null, undefined, "yes", 1, [], {}, { allowed: "true" }, { allowed: 1 }, { allowed: false }]) {
    assert.equal(parseLicensingDecision(bad).allowed, false);
  }
  assert.equal(parseLicensingDecision({ allowed: false, reason: "killed" }).reason, "killed");
  assert.equal(parseLicensingDecision({ allowed: false }).reason, "licensing_not_confirmed");
});

test("RPC error, thrown error and malformed payload all fail closed", async () => {
  assert.deepEqual(await checkLicensingGate(client({ data: null, error: { message: "x" } }), "bnpl_legacy"), { allowed: false, reason: "gate_unreadable" });
  assert.deepEqual(await checkLicensingGate(throwing, "bnpl_legacy"), { allowed: false, reason: "gate_unreadable" });
  assert.equal((await checkLicensingGate(client({ data: "oops", error: null }), "bnpl_legacy")).allowed, false);
});

test("unknown capability is refused without calling the database", async () => {
  let called = false;
  const db = { rpc: async () => { called = true; return { data: { allowed: true }, error: null }; } };
  const r = await checkLicensingGate(db, "made_up");
  assert.deepEqual(r, { allowed: false, reason: "unknown_capability" });
  assert.equal(called, false);
});

test("requireLicensingGate returns 403 when closed and null when open", async () => {
  const closed = await requireLicensingGate(client({ data: { allowed: false, reason: "licensing_not_confirmed" }, error: null }), "escrow", { "Access-Control-Allow-Origin": "*" });
  assert.equal(closed.status, 403);
  const body = await closed.json();
  assert.equal(body.error, "licensing_not_confirmed");
  assert.equal(closed.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await requireLicensingGate(client({ data: { allowed: true, reason: null }, error: null }), "escrow", {}), null);
});

test("capability list matches the migration seed", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../../../migrations/20290312000000_licensing_gate.sql", import.meta.url), "utf8");
  const seeded = [...sql.matchAll(/^\s+\('([a-z_]+)',\s+'/gm)].map((m) => m[1]).sort();
  assert.deepEqual(seeded, [...LICENSING_CAPABILITIES].sort());
});
