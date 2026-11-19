#!/usr/bin/env node
// scripts/security/cron-auth-codemod.mjs
//
// Scheduled / internal edge functions must authenticate IN CODE. `verify_jwt = true` alone is not authentication:
// the public anon key passes the gateway. This codemod:
//   A) adds fail-closed auth (requireCronAuth: x-cron-secret / CRON_SECRET, or the service-role key as Bearer, which is
//      what the existing pg_net schedules send) + removes wildcard CORS from the listed functions that have NO auth;
//   B) replaces the timing-unsafe `Authorization !== \`Bearer ${key}\`` checks with the same constant-time helper.
//
//   node scripts/security/cron-auth-codemod.mjs            dry run
//   node scripts/security/cron-auth-codemod.mjs --write    apply
// A function is only changed when the result still parses and no CORS/identifier leftovers remain; otherwise it is skipped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROOT } from "./function-matrix.mjs";
import { stripCors, syntaxOk } from "./cors-codemod.mjs";

/** A) verified (by reading each handler) to have NO caller authentication and to run platform-wide with the service role. */
export const ADD_AUTH = [
  "check-contract-renewals", "check-credential-expirations", "check-warranty-alerts", "dr-backup-run", "dr-restore-drill",
];
/** B) already authenticated, but with a non-constant-time string comparison. */
export const HARDEN_AUTH = ["check-cost-guardrails", "economics-routing-eval", "economics-sweep", "learning-policy-monitor"];

const IMPORT_LINE = 'import { requireCronAuth } from "../_shared/http/cronAuth.ts";';
const AUTH_BLOCK = (ind) =>
  `${ind}const auth = requireCronAuth(req, { allowBearer: true, extraEnvNames: ["SUPABASE_SERVICE_ROLE_KEY"] });\n${ind}if (!auth.ok) return auth.response;\n`;

function addImport(text) {
  if (/_shared\/http\/cronAuth(?:\.ts)?["']/.test(text)) return text;
  const imports = [...text.matchAll(/^import\b[^;]*;[ \t]*$/gm)];
  if (!imports.length) return null;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return `${text.slice(0, at)}\n${IMPORT_LINE}${text.slice(at)}`;
}

/** A) */
export function addCronAuth(source) {
  if (/requireCronAuth\(/.test(source)) return { error: "already uses requireCronAuth" };
  const cors = stripCors(source);
  if (cors.error) return { error: `cors: ${cors.error}` };
  let text = cors.text;
  const serve = text.match(/^([ \t]*)Deno\.serve\(\s*async\s*\(\s*(\w+)\s*(?::\s*Request)?\s*\)\s*=>\s*\{[ \t]*\n/m);
  if (!serve || serve[2] !== "req") return { error: "handler is not `Deno.serve(async (req: Request) => {`" };
  if ((text.match(/\bDeno\.serve\(/g) ?? []).length !== 1) return { error: "expected exactly one Deno.serve call" };
  const at = serve.index + serve[0].length;
  text = `${text.slice(0, at)}${AUTH_BLOCK(`${serve[1]}  `)}${text.slice(at)}`;
  text = addImport(text);
  if (text === null) return { error: "no import statement to anchor the helper import" };
  return { text };
}

/** B) */
export function hardenBearer(source) {
  const A = /^([ \t]*)if \(!(\w+) \|\| req\.headers\.get\("Authorization"\) !== `Bearer \$\{\2\}`\) return json\(\{ error: "Unauthorized" \}, 401\);[ \t]*$/m;
  const B = /^([ \t]*)const bearer = \(req\.headers\.get\("Authorization"\) \?\? ""\)\.replace\(\/\^Bearer\\s\+\/i, ""\);\n[ \t]*if \(!key \|\| bearer !== key\) return json\(\{ error: "Unauthorized" \}, 401\);[ \t]*$/m;
  let text = source;
  if (A.test(text)) text = text.replace(A, (_m, ind) => AUTH_BLOCK(ind).trimEnd());
  else if (B.test(text)) text = text.replace(B, (_m, ind) => AUTH_BLOCK(ind).trimEnd());
  else return { error: "bearer comparison pattern not found" };
  text = addImport(text);
  if (text === null) return { error: "no import statement to anchor the helper import" };
  return { text };
}

export function plan(root = DEFAULT_ROOT) {
  const edits = [];
  const skipped = [];
  const jobs = [...ADD_AUTH.map((n) => [n, addCronAuth]), ...HARDEN_AUTH.map((n) => [n, hardenBearer])];
  for (const [name, fn] of jobs) {
    const file = path.join(root, "supabase", "functions", name, "index.ts");
    if (!fs.existsSync(file)) { skipped.push({ name, reason: "function not found in this tree" }); continue; }
    const original = fs.readFileSync(file, "utf8");
    const res = fn(original);
    if (res.error) { skipped.push({ name, reason: res.error }); continue; }
    if (!syntaxOk(original, root)) { skipped.push({ name, reason: "the original already fails the syntax check in this tree" }); continue; }
    if (!syntaxOk(res.text, root)) { skipped.push({ name, reason: "transformed file failed the syntax check (left untouched)" }); continue; }
    edits.push({ name, file, text: res.text });
  }
  return { edits, skipped };
}

function main() {
  const write = process.argv.includes("--write");
  const { edits, skipped } = plan();
  for (const e of edits) { if (write) fs.writeFileSync(e.file, e.text); console.log(`${write ? "WROTE  " : "WOULD  "}${e.name}`); }
  for (const s of skipped) console.log(`SKIP   ${s.name} — ${s.reason}`);
  console.log(`\n${edits.length} updated, ${skipped.length} skipped.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
