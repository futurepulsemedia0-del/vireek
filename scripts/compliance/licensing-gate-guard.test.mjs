// Static guard: escrow / stored-funds code must never ship without the licensing gate.
// Run: node --experimental-strip-types --no-warnings --test scripts/compliance/licensing-gate-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCAN = ["src", "supabase/functions", "supabase/migrations", "services", "packages"];
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build"]);
const EXT = /\.(ts|tsx|sql|mjs|js|sql)$/;
// Files that may mention escrow because they ARE the gate or its tests.
const ALLOW = [/licensing_gate\.sql$/, /_shared\/licensing\//, /licensing-gate-guard\.test\.mjs$/];

function* walk(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP_DIR.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(n)) yield p;
  }
}

test("any file that mentions escrow also references the licensing gate", () => {
  const offenders = [];
  for (const d of SCAN) {
    for (const f of walk(join(ROOT, d))) {
      const rel = relative(ROOT, f);
      if (ALLOW.some((re) => re.test(rel))) continue;
      const text = readFileSync(f, "utf8");
      if (/escrow/i.test(text) && !/licensing_gate|requireLicensingGate|checkLicensingGate/.test(text)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `Escrow code without a licensing gate: ${offenders.join(", ")}`);
});

test("the legacy BNPL edge function calls the gate before touching data", () => {
  const src = readFileSync(join(ROOT, "supabase/functions/financing-create-offer/index.ts"), "utf8");
  const gate = src.indexOf('requireLicensingGate(admin, "bnpl_legacy"');
  assert.ok(gate > 0, "financing-create-offer must call requireLicensingGate(admin, \"bnpl_legacy\", ...)");
  assert.ok(gate < src.indexOf('.from("jobs")'), "gate must run before the first database read");
  assert.ok(gate < src.indexOf('.from("financing_offers")'), "gate must run before creating an offer");
});
