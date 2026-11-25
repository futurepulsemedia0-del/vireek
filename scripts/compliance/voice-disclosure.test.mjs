// Run: npm run test:scripts:voice-disclosure
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discover, evaluate, SCAN_ROOT } from "./voice-disclosure-lib.mjs";

const reg = (flows) => ({ flows });
const base = { knownGaps: [] };
const F = "supabase/functions/";
const ai = (path, evidence, mode = "variable_injection") => ({ path, aiSpeaksToThirdParty: true, disclosure: { mode, evidence } });

test("a new call flow that is not in the registry fails (R1)", () => {
  const files = [{ path: F + "new-dialer/index.ts", text: 'fetch("https://api.vapi.ai/call", {})' }];
  const r = evaluate({ files, registry: reg([]), baseline: base });
  assert.ok(r.errors.some((e) => e.startsWith("R1")));
});

test("an AI flow with no disclosure fails unless baselined (R5)", () => {
  const p = F + "x/index.ts";
  const files = [{ path: p, text: 'await fetch("https://api.vapi.ai/call")' }];
  const registry = reg([{ path: p, aiSpeaksToThirdParty: true, disclosure: { mode: "none" } }]);
  assert.ok(evaluate({ files, registry, baseline: base }).errors.some((e) => e.startsWith("R5 NEW")));
  const ok = evaluate({ files, registry, baseline: { knownGaps: [p] } });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.warnings.length, 1);
});

test("claimed disclosure whose evidence disappears from the code fails (R3)", () => {
  const p = F + "d/index.ts";
  const files = [{ path: p, text: 'fetch("https://api.vapi.ai/call") // disclosure removed' }];
  const registry = reg([ai(p, [{ file: p, pattern: "outboundDisclosureVariables\\(" }])]);
  const r = evaluate({ files, registry, baseline: base });
  assert.ok(r.errors.some((e) => e.startsWith("R3")));
  assert.ok(r.errors.some((e) => e.startsWith("R5 NEW")));
});

test("evidence present -> passes; non-AI flow needs a reason (R4); stale entries and stale baseline fail (R2/R5)", () => {
  const p = F + "d/index.ts";
  const q = F + "h/index.ts";
  const files = [
    { path: p, text: 'fetch("https://api.vapi.ai/call"); outboundDisclosureVariables(a)' },
    { path: q, text: "<Say>hi</Say>" },
  ];
  const good = reg([ai(p, [{ file: p, pattern: "outboundDisclosureVariables\\(" }]), { path: q, aiSpeaksToThirdParty: false, reason: "human bridge" }]);
  assert.equal(evaluate({ files, registry: good, baseline: base }).errors.length, 0);
  const noReason = reg([ai(p, [{ file: p, pattern: "outboundDisclosureVariables\\(" }]), { path: q, aiSpeaksToThirdParty: false }]);
  assert.ok(evaluate({ files, registry: noReason, baseline: base }).errors.some((e) => e.startsWith("R4")));
  const stale = reg([...good.flows, { path: F + "gone.ts", aiSpeaksToThirdParty: false, reason: "x" }]);
  assert.ok(evaluate({ files, registry: stale, baseline: base }).errors.some((e) => e.startsWith("R2")));
  assert.ok(evaluate({ files, registry: good, baseline: { knownGaps: [p] } }).errors.some((e) => e.startsWith("R5 baseline")));
});

test("test files and GET-only provider calls are not discovered", () => {
  const files = [
    { path: F + "a.test.ts", text: 'fetch("https://api.vapi.ai/call")' },
    { path: F + "b.ts", text: "fetch(`https://api.vapi.ai/call/${id}`)" },
  ];
  assert.deepEqual(discover(files), []);
});

// ---------------------------------------------------------------- the real repository
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|mjs|js)$/.test(n)) out.push(p.split("\\").join("/"));
  }
  return out;
}
const real = existsSync(SCAN_ROOT);
test("REAL REPO: every voice flow has a verified AI disclosure or is a baselined gap", { skip: !real }, () => {
  const files = walk(SCAN_ROOT).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const r = evaluate({
    files,
    registry: JSON.parse(readFileSync("scripts/compliance/voice-disclosure-registry.json", "utf8")),
    baseline: JSON.parse(readFileSync("scripts/compliance/voice-disclosure-baseline.json", "utf8")),
  });
  assert.deepEqual(r.errors, []);
});

test("REAL REPO: removing the disclosure from outbound-dialer makes the guard fail", { skip: !real }, () => {
  const files = walk(SCAN_ROOT).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const target = F + "outbound-dialer/index.ts";
  const tampered = files.map((f) => (f.path === target ? { ...f, text: f.text.replaceAll("outboundDisclosureVariables(", "noop(") } : f));
  const r = evaluate({
    files: tampered,
    registry: JSON.parse(readFileSync("scripts/compliance/voice-disclosure-registry.json", "utf8")),
    baseline: JSON.parse(readFileSync("scripts/compliance/voice-disclosure-baseline.json", "utf8")),
  });
  assert.ok(r.errors.some((e) => e.includes("outbound-dialer")));
});
