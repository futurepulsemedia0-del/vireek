#!/usr/bin/env node
// scripts/security/migrate-fail-open-secrets.mjs
//
// One-shot codemod for the `fail-open-secret` rule of docs/security/function-matrix.md.
//   node scripts/security/migrate-fail-open-secrets.mjs            dry run
//   node scripts/security/migrate-fail-open-secrets.mjs --write    apply
// Targets come from the matrix itself. Non-standard shapes are NOT touched (reported as "manual").

import fs from "node:fs";
import path from "node:path";
import { buildMatrix, DEFAULT_ROOT } from "./function-matrix.mjs";

const WRITE = process.argv.includes("--write");
const IMPORT_LINE = 'import { requireCronAuth } from "../_shared/http/cronAuth.ts";';

const LEGACY = new RegExp(
  String.raw`^([ \t]*)const cronSecret = Deno\.env\.get\("([A-Z0-9_]+)"\);[ \t]*\r?\n` +
    String.raw`\1if \(cronSecret && req\.headers\.get\("[Xx]-[Cc]ron-[Ss]ecret"\) !== cronSecret\) ` +
    String.raw`(?:\{[ \t]*\r?\n[\s\S]*?\r?\n\1\}|return [^\n]*;)`,
  "m",
);

export function addImport(src) {
  if (src.includes("_shared/http/cronAuth.ts")) return src;
  const re = /^import\b[\s\S]*?\bfrom\s*["'][^"']+["'];?[ \t]*$/gm;
  let last = null;
  for (let m; (m = re.exec(src)); ) last = m;
  if (!last) return `${IMPORT_LINE}\n${src}`;
  const end = last.index + last[0].length;
  return `${src.slice(0, end)}\n${IMPORT_LINE}${src.slice(end)}`;
}

export function migrate(src, fn) {
  const m = LEGACY.exec(src);
  if (!m) return null;
  const [block, indent, envName] = m;
  // A fallback path (e.g. "or any Authorization header") is business logic: never auto-rewrite it.
  if (/authorization/i.test(block)) return null;
  const hasCors = /^const corsHeaders\b/m.test(src);
  const hasJsonHeaders = /^const JSON_HEADERS\b/m.test(src);
  const headersOpt = hasCors ? ", responseHeaders: corsHeaders" : hasJsonHeaders ? ", responseHeaders: JSON_HEADERS" : "";
  const replacement =
    `${indent}const cronAuth = requireCronAuth(req, { envName: "${envName}", fn: "${fn}"${headersOpt} });\n` +
    `${indent}if (!cronAuth.ok) return cronAuth.response;`;
  return addImport(src.replace(block, replacement));
}

function main() {
  const root = DEFAULT_ROOT;
  const { rows } = buildMatrix(root);
  const targets = rows.filter((r) => r.violations.includes("fail-open-secret")).map((r) => r.name);
  const done = [];
  const manual = [];
  for (const name of targets) {
    const file = path.join(root, "supabase", "functions", name, "index.ts");
    const src = fs.readFileSync(file, "utf8");
    const next = migrate(src, name);
    if (next === null || next === src) { manual.push(name); continue; }
    if (WRITE) fs.writeFileSync(file, next);
    done.push(name);
  }
  console.log(`${WRITE ? "migrated" : "would migrate"} ${done.length}/${targets.length}:`);
  for (const n of done) console.log(`  ✔ ${n}`);
  if (manual.length) {
    console.log(`\nmanual (non-standard shape, edit by hand): ${manual.length}`);
    for (const n of manual) console.log(`  ✘ ${n}`);
  }
  if (!WRITE) console.log("\n(dry run — re-run with --write to apply)");
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
