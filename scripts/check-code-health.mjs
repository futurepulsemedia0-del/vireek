#!/usr/bin/env node
// scripts/check-code-health.mjs
//
// Code-health ratchets. Fails when any tracked count GROWS beyond scripts/code-health.baseline.json,
// or when a hard rule is broken (a skipped test without a reason, a bare @ts-ignore).
// The baseline can only shrink: `--update` writes min(old, current) and never raises a number.
//
// Exempt a single reviewed line with:  // code-health: allow(<metric>) <reason>
// Usage: node scripts/check-code-health.mjs [--update] [--strict] [--json] [--list=<metric>]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { METRICS, compare, scanRepo, shrinkBaseline } from "./lib/codeHealth.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const BASELINE = "scripts/code-health.baseline.json";
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const { counts, offenders, violations } = scanRepo();

const list = args.find((a) => a.startsWith("--list="))?.split("=")[1];
if (list) { console.log((offenders[list] ?? []).join("\n")); process.exit(0); }

if (has("--update")) {
  const next = { note: "Code-health ratchet baseline. Numbers may only go DOWN: fix the code, then run `node scripts/check-code-health.mjs --update`. Never raise by hand.", counts: shrinkBaseline(counts, baseline) };
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log("baseline written:", next.counts);
  process.exit(violations.length ? 1 : 0);
}

const { regressions, improvements } = compare(counts, baseline);
if (has("--json")) { console.log(JSON.stringify({ counts, baseline: baseline?.counts ?? null, regressions, improvements, violations }, null, 2)); }
else {
  console.log("code health (current / baseline)");
  for (const [k, m] of Object.entries(METRICS)) console.log(`  ${k.padEnd(22)} ${String(counts[k]).padStart(5)} / ${String(baseline?.counts?.[k] ?? "-").padStart(5)}  ${m.label}`);
}
let fail = false;
for (const r of regressions) { fail = true; console.error(`FAIL ${r.metric}: ${r.reason === "missing_baseline" ? "no baseline entry" : `${r.current} > baseline ${r.baseline}`} (find them: node scripts/check-code-health.mjs --list=${r.metric})`); }
for (const v of violations) { fail = true; console.error(`FAIL ${v.rule}: ${v.path}:${v.line}  ${v.text}`); }
if (improvements.length) {
  console.log(`\nImproved: ${improvements.map((i) => `${i.metric} ${i.baseline}→${i.current}`).join(", ")}. Run with --update to lock it in.`);
  if (has("--strict")) fail = true;
}
process.exit(fail ? 1 : 0);
