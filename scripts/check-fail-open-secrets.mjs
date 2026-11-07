// Fails (exit 1) if any Edge Function uses a fail-open secret guard.
// Run: node scripts/check-fail-open-secrets.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = "supabase/functions";
// `if (cronSecret && header !== cronSecret)` style: secret optional => unset == open
const FAIL_OPEN = [
  /if\s*\(\s*(cronSecret|expectedSecret|secret)\s*&&.*(!==|!=)/,
  /if\s*\(\s*(cronSecret|expectedSecret|secret)\s*&&.*===\s*(cronSecret|expectedSecret|secret)\s*\)/,
  /if\s*\(\s*(expectedSecret)\s*\)\s*\{/,
];
const bad = [];
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === "_shared") continue;
  const f = join(root, d.name, "index.ts");
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    if (FAIL_OPEN.some((r) => r.test(line))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}
console.log(bad.length ? bad.join("\n") : "OK");
console.log(`fail-open entry points: ${bad.length}`);
process.exit(bad.length ? 1 : 0);
