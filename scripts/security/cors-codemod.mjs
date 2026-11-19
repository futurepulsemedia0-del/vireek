#!/usr/bin/env node
// scripts/security/cors-codemod.mjs
//
// Removes CORS headers from SERVER-TO-SERVER edge functions (webhooks / cron / API-key) that the matrix flags as
// `wildcard-cors-non-browser`. A function is only touched when ALL of these hold:
//   1. the matrix reports `wildcard-cors-non-browser` for it,
//   2. NO browser code (src, public, chrome-extension, worker, packages, api) references the function name,
//   3. every transformation succeeds, no CORS identifier/header remains, and the result still parses.
// Anything else is skipped and listed (with the reason) for manual migration (browser-facing ones use `withCors`).
//
//   node scripts/security/cors-codemod.mjs            dry run (default): prints the plan, writes nothing
//   node scripts/security/cors-codemod.mjs --write    applies the changes
//   node scripts/security/cors-codemod.mjs --only a,b restrict to named functions
//
// After --write: node scripts/security/function-matrix.mjs --write && npx vitest run && review `git diff`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildMatrix, DEFAULT_ROOT } from "./function-matrix.mjs";

const BROWSER_DIRS = ["src", "public", "chrome-extension", "worker", "packages", "api"];
const BROWSER_EXT = /\.(?:[cm]?[jt]sx?|html|json)$/;
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

function* walkFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (BROWSER_EXT.test(e.name) && !/\.(?:test|spec)\./.test(e.name)) yield p;
  }
}

/** Map functionName -> first browser-side file referencing it (quoted name or /functions/v1/<name>). */
export function browserCallers(root, names) {
  const found = new Map();
  const res = names.map((n) => [n, new RegExp(`["'\`]${n}["'\`]|functions/v1/${n}(?![\\w-])`)]);
  for (const d of BROWSER_DIRS) {
    for (const f of walkFiles(path.join(root, d))) {
      const text = fs.readFileSync(f, "utf8");
      for (const [n, re] of res) if (!found.has(n) && re.test(text)) found.set(n, path.relative(root, f).split(path.sep).join("/"));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Transformation (pure, exported for tests)
// ---------------------------------------------------------------------------------------------
const CONST_RE = /(^|\n)[ \t]*(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=\n]+)?=\s*\{[^{}]*?["']Access-Control-Allow-Origin["'][^{}]*?\}\s*(?:as\s+const\s*)?;?[ \t]*(?=\n)/;

/** Returns { text } or { error }. */
export function stripCors(source) {
  let text = source;
  const m = text.match(CONST_RE);
  if (!m) return { error: "no `const X = { \"Access-Control-Allow-Origin\": ... }` block found (shared helper or unusual pattern)" };
  const name = m[2];
  text = text.replace(CONST_RE, "");

  const id = name.replace(/[$]/g, "\\$");
  // Preflight: a browser must never get a 2xx for OPTIONS on a server-to-server endpoint.
  text = text.replace(new RegExp(`(req\\.method\\s*===\\s*["']OPTIONS["'][\\s\\S]{0,160}?status:\\s*)200(\\s*,\\s*headers:\\s*${id}\\b)`), "$1405$2");
  // `{ ...name, "X": y }` / `{ ...name }`
  text = text.replace(new RegExp(`\\.\\.\\.${id}\\s*,\\s*`, "g"), "");
  text = text.replace(new RegExp(`\\{\\s*\\.\\.\\.${id}\\s*\\}`, "g"), "{}");
  text = text.replace(new RegExp(`,\\s*\\.\\.\\.${id}\\b`, "g"), "");
  // `{ status: 500, headers: name }` -> `{ status: 500 }` ; `{ headers: name }` -> `{}` ; `{ headers: name, status: 1 }`
  text = text.replace(new RegExp(`,\\s*headers:\\s*${id}(?=\\s*[,}])`, "g"), "");
  text = text.replace(new RegExp(`\\{\\s*headers:\\s*${id}\\s*,\\s*`, "g"), "{ ");
  text = text.replace(new RegExp(`\\{\\s*headers:\\s*${id}\\s*\\}`, "g"), "{}");

  if (new RegExp(`\\b${id}\\b`).test(text)) return { error: `identifier \`${name}\` still referenced after transform (manual edit needed)` };
  if (/Access-Control-/i.test(text)) return { error: "an Access-Control header remains (set elsewhere)" };
  return { text, name };
}

// ---------------------------------------------------------------------------------------------
// Syntax verification: TypeScript compiler if installed, else Node's strip-types parser.
// ---------------------------------------------------------------------------------------------
export function syntaxOk(text, root = DEFAULT_ROOT) {
  try {
    const ts = createRequire(path.join(root, "package.json"))("typescript");
    const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: "x.ts" });
    return !(out.diagnostics ?? []).some((d) => d.category === ts.DiagnosticCategory.Error);
  } catch { /* typescript not installed */ }
  const tmp = path.join(os.tmpdir(), `cors-codemod-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(tmp, text);
  try {
    return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--check", tmp], { encoding: "utf8" }).status === 0;
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function plan(root = DEFAULT_ROOT, only = null) {
  const { rows } = buildMatrix(root);
  const targets = rows.filter((r) => r.violations.includes("wildcard-cors-non-browser") && (!only || only.includes(r.name))).map((r) => r.name);
  const callers = browserCallers(root, targets);
  const edits = [];
  const skipped = [];
  for (const name of targets) {
    if (callers.has(name)) { skipped.push({ name, reason: `browser caller: ${callers.get(name)} (migrate with withCors, not removal)` }); continue; }
    const file = path.join(root, "supabase", "functions", name, "index.ts");
    const res = stripCors(fs.readFileSync(file, "utf8"));
    if (res.error) { skipped.push({ name, reason: res.error }); continue; }
    // Only trust the syntax check when the ORIGINAL parses: otherwise a failure says nothing about the transform.
    if (!syntaxOk(fs.readFileSync(file, "utf8"), root)) { skipped.push({ name, reason: "the original file already fails the syntax check in this tree; fix that first, then re-run" }); continue; }
    if (!syntaxOk(res.text, root)) { skipped.push({ name, reason: "transformed file failed the syntax check (left untouched)" }); continue; }
    edits.push({ name, file, text: res.text });
  }
  return { edits, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.indexOf("--only");
  const only = onlyArg >= 0 ? args[onlyArg + 1].split(",") : null;
  const { edits, skipped } = plan(DEFAULT_ROOT, only);
  for (const e of edits) {
    if (args.includes("--write")) fs.writeFileSync(e.file, e.text);
    console.log(`${args.includes("--write") ? "WROTE  " : "WOULD  "}${e.name}`);
  }
  for (const s of skipped) console.log(`SKIP   ${s.name} — ${s.reason}`);
  console.log(`\n${edits.length} function(s) ${args.includes("--write") ? "updated" : "would be updated"}, ${skipped.length} skipped for manual review.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
