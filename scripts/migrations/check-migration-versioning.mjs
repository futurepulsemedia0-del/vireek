#!/usr/bin/env node
/**
 * Vireek — migration versioning guard (fails ONLY on NEW violations; legacy ones are baselined).
 *
 *   check        [--base <git-ref>] [--baseline <file>] [--dir <dir>] [--repair-pr]   exit 1 on new violations
 *   baseline     [--write]        print (or write) supabase/migrations snapshot of legacy violations
 *   report       audit summary of the current directory (counts, duplicates, irregular names, future-dated)
 *   next                          print the next safe version for `supabase migration new`-style naming
 *   repair-plan                   PRINT (never execute) git mv + `supabase migration repair` commands that
 *                                 compress future-dated versions into the past, order preserved
 * Common: --dir supabase/migrations  --now <ISO-8601, tests only>
 * Exit codes: 0 ok · 1 violations · 2 usage / I/O / git problem.
 * Never renames or edits files. See docs/runbooks/migration-versioning.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { INVENTORY_KINDS, KINDS, buildBaseline, evaluate, formatVersion, inventoryViolations, maxStrictVersion, nextVersion, planFutureRepair } from "./migration-versioning-lib.mjs";

export function parseArgs(argv) {
  const o = { _: [], dir: "supabase/migrations", baseline: "scripts/migrations/versioning-baseline.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write" || a === "--repair-pr") o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

const die = (msg, code = 2) => { console.error(`✖ ${msg}`); process.exit(code); };
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const top = (p, dir) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p).split("/")[0];

export function listNames(dir) {
  if (!existsSync(dir)) die(`Migrations directory not found: ${dir}`);
  return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
}

export function gitBase(dir, ref) {
  try {
    if (git(["rev-parse", "--show-prefix"]).trim() !== "") die("Run from the repository root (paths are matched relative to it).");
    const names = [...new Set(git(["ls-tree", "-r", "--name-only", ref, "--", dir]).split("\n").filter(Boolean).map((p) => top(p, dir)))].sort();
    const changes = git(["diff", "--name-status", "-M", "--no-color", ref, "--", dir]).split("\n").filter(Boolean).map((l) => {
      const [status, a, b] = l.split("\t");
      return status[0] === "R" ? { status, oldPath: top(a, dir), path: top(b, dir) } : { status, path: top(a, dir) };
    });
    return { names, changes: changes.filter((c) => c.status[0] !== "A") };
  } catch (e) {
    return die(`Cannot read git ref "${ref}" (${String(e.stderr || e.message).trim().split("\n")[0]}). In CI use actions/checkout with fetch-depth: 0.`);
  }
}

function loadBaseline(file) {
  if (!existsSync(file)) die(`Baseline not found: ${file}. Create it once with: node scripts/migrations/check-migration-versioning.mjs baseline --write`);
  const b = JSON.parse(readFileSync(file, "utf8"));
  if (b.schema !== 1 || !Array.isArray(b.files) || !b.violations) die(`Unsupported baseline format in ${file}`);
  return b;
}

export function run(argv, now = new Date()) {
  const o = parseArgs(argv);
  const cmd = o._[0] ?? "check";
  if (o.now) now = new Date(o.now);
  if (Number.isNaN(now.getTime())) die("Invalid --now");
  o.dir = o.dir.replace(/^\.\//, "").replace(/\/+$/, "");
  const names = listNames(o.dir);

  if (cmd === "baseline") {
    const json = JSON.stringify(buildBaseline(names, now), null, 2) + "\n";
    if (o.write) { writeFileSync(o.baseline, json); console.log(`✔ wrote ${o.baseline} (${names.length} files)`); } else process.stdout.write(json);
    return 0;
  }

  if (cmd === "next") { console.log(nextVersion(names, now)); return 0; }

  if (cmd === "report") {
    const inv = inventoryViolations(names, formatVersion(now));
    const by = (k) => inv.filter((v) => v.kind === k).map((v) => v.file);
    const dups = by("duplicate-version");
    const years = {};
    for (const n of names) if (/^\d{4}/.test(n)) years[n.slice(0, 4)] = (years[n.slice(0, 4)] ?? 0) + 1;
    console.log(`entries: ${names.length}   latest version: ${maxStrictVersion(names)}   now: ${formatVersion(now)}`);
    console.log(`by year prefix: ${Object.entries(years).map(([y, n]) => `${y}=${n}`).join("  ")}`);
    console.log(`future-dated: ${by("future-dated").length}`);
    console.log(`duplicate-version: ${dups.length} files in ${new Set(dups.map((d) => d.slice(0, 14))).size} groups`);
    console.log(`irregular-name (${by("irregular-name").length}):\n${by("irregular-name").map((n) => `  ${n}`).join("\n") || "  (none)"}`);
    return 0;
  }

  if (cmd === "repair-plan") {
    const plan = planFutureRepair(names, now);
    if (plan.error) die(plan.error, 1);
    const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
    const L = ["# PRINTED PLAN — nothing here has been executed. Read docs/runbooks/migration-versioning.md first.",
      `# ${plan.renames.length} future-dated migration(s) -> versions ${plan.base}+1s … (all <= now), execution order preserved.`, "", "# A) In a branch: rename the files"];
    for (const r of plan.renames) L.push(`git mv supabase/migrations/${r.oldName} supabase/migrations/${r.newName}`);
    L.push("", "# B) Per ALREADY-MIGRATED environment (staging first), after the runbook pre-checks (backup, schema parity):", "supabase link --project-ref <ref>");
    for (const c of chunk([...new Set(plan.renames.map((r) => r.oldVersion))], 20)) L.push(`supabase migration repair --status reverted ${c.join(" ")}`);
    for (const c of chunk(plan.renames.map((r) => r.newVersion), 20)) L.push(`supabase migration repair --status applied ${c.join(" ")}`);
    L.push("supabase migration list   # Local and Remote must match row for row", "supabase db push --dry-run   # must report: Remote database is up to date.");
    console.log(L.join("\n"));
    return 0;
  }

  if (cmd !== "check") die(`Unknown command "${cmd}". Use: check | baseline | report | next | repair-plan`);

  const baseline = loadBaseline(o.baseline);
  let base = { names: null, changes: [] };
  if (o.base) base = gitBase(o.dir, o.base);
  else console.error("⚠ no --base given: 'new file' detection falls back to the baseline snapshot and edit/rename detection is skipped (CI always passes --base).");
  const r = evaluate({ names, now, baseline, baseNames: base.names, changes: base.changes, repairPr: !!o.repairPr });

  for (const v of r.violations) console.error(`✖ [${v.kind}] ${v.file}${v.detail ? ` — ${v.detail}` : ""}\n    ${KINDS[v.kind]}`);
  if (r.stale.length) console.error(`ℹ ${r.stale.length} baselined violation(s) no longer present (safe to prune from the baseline in a reviewed PR).`);
  if (r.violations.length) {
    console.error(`\n${r.violations.length} NEW violation(s). Get a safe version with: node scripts/migrations/check-migration-versioning.mjs next`);
    return 1;
  }
  console.log(`✔ no new violations (${names.length} entries; ${INVENTORY_KINDS.reduce((n, k) => n + baseline.violations[k].length, 0)} legacy violations baselined)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run(process.argv.slice(2)));
