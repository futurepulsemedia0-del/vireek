// CI ratchet: every Edge Function with an outbound send / call / charge / refund must call
// authorizeAgentAction OR carry `// governance-exempt: <reason>` (e.g. human-initiated).
// Existing offenders live in scripts/governance-baseline.json; NEW offenders fail CI,
// and the baseline can only shrink. Heuristic (text-based): it proves absence of the gate
// call, not correctness of its placement.
//   node scripts/check-ungoverned-side-effects.mjs            -> check
//   node scripts/check-ungoverned-side-effects.mjs --write    -> regenerate baseline (shrink only in review)
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = "supabase/functions";
const baselinePath = "scripts/governance-baseline.json";
const SIDE_EFFECT = /sendSms|sendVoiceCall|sendCompliantSms|api\.vapi\.ai\/call|api\.stripe\.com\/v1\/(refunds|payment_intents|charges)|stripe\.(refunds|paymentIntents|charges)\.create|from\(["']twilio|twilio\.com\/.*Messages|api\.twilio\.com/;
const GATE = /authorizeAgentAction/;
const EXEMPT = /governance-exempt:\s*\S+/;
const found = []; let governed = 0, exempt = 0;
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === "_shared") continue;
  const f = join(root, d.name, "index.ts");
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  if (!SIDE_EFFECT.test(src)) continue;
  if (GATE.test(src)) governed++; else if (EXEMPT.test(src)) exempt++; else found.push(d.name);
}
const total = governed + exempt + found.length;
if (process.argv.includes("--write")) {
  writeFileSync(baselinePath, JSON.stringify({ ungoverned: found.sort() }, null, 2) + "\n");
  console.log(`baseline written: ${found.length} ungoverned`); process.exit(0);
}
const base = new Set(existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")).ungoverned : []);
const fresh = found.filter((n) => !base.has(n));
const fixed = [...base].filter((n) => !found.includes(n));
console.log(`side-effect functions: ${total} | governed: ${governed} | exempt: ${exempt} | ungoverned: ${found.length} (baseline ${base.size})`);
console.log(`governed coverage: ${total ? ((100 * (governed + exempt)) / total).toFixed(1) : 100}%`);
if (fixed.length) console.log(`now governed (remove from baseline via --write): ${fixed.join(", ")}`);
if (fresh.length) { console.error(`NEW ungoverned side-effect functions:\n  ${fresh.join("\n  ")}`); process.exit(1); }
console.log("OK: no new ungoverned side effects");
