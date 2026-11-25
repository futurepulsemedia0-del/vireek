#!/usr/bin/env node
// npm run compliance:voice-disclosure   -> exit 1 on any R1-R5 violation. See voice-disclosure-lib.mjs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCAN_ROOT, evaluate } from "./voice-disclosure-lib.mjs";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(n)) out.push(p.split("\\").join("/"));
  }
  return out;
}
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const files = walk(SCAN_ROOT).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const res = evaluate({
  files,
  registry: load("scripts/compliance/voice-disclosure-registry.json"),
  baseline: load("scripts/compliance/voice-disclosure-baseline.json"),
});
for (const w of res.warnings) console.warn(`! ${w}`);
for (const e of res.errors) console.error(`x ${e}`);
console.log(`${res.errors.length ? "FAIL" : "OK"}: ${res.flows} call-flow files, ${res.errors.length} errors, ${res.warnings.length} known gaps.`);
process.exit(res.errors.length ? 1 : 0);
