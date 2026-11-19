#!/usr/bin/env node
// Constant-time secret comparison: CI rule + codemod for supabase/functions.
//
//   node scripts/security/secret-compare.mjs --check   CI gate: exit 1 if any ===/!== secret/token comparison is found
//   node scripts/security/secret-compare.mjs --write   rewrite the mechanical cases to checkSharedSecret()
//   node scripts/security/secret-compare.mjs           dry run (lists what --write would change)
//
// The shared helper is checkSharedSecret(expected, provided) in supabase/functions/_shared/http/core.ts
// (constant-time, fail-closed on an empty expected secret). This rule has NO baseline: once the legacy sites are
// migrated, every new violation fails CI. Escape hatch for a genuine non-secret comparison: end the line with
// `// timing-safe-ok: <reason>`.
//
// What it flags (comments are ignored):
//   1. <req.headers.get|searchParams.get|url.searchParams.get>("...secret|token|key...") ===|!== <ident named *secret|*token|*key>
//      and the reversed operand order            -> auto-fixable
//   2. <ident named *secret|*token> ===|!== Deno.env.get("...") (either order)   -> auto-fixable
//   3. <expected*|computed*> ===|!== <signature|sig|digest|mac|hmac>             -> report only (fix by hand)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FUNCTIONS = path.join(ROOT, "supabase", "functions");
const CORE = path.join(FUNCTIONS, "_shared", "http", "core.ts");
export const HELPER = "checkSharedSecret";

const GET = String.raw`(?:(?:req|request|c\.req|url)\.(?:headers|searchParams)\.get|headers\.get|searchParams\.get)\(\s*(?<q>["'])[^"']*(?:secret|token|key)[^"']*\k<q>\s*\)`;
const IDENT = String.raw`(?:[A-Za-z_$][\w$]*)?(?:Secret|SECRET|Token|TOKEN|Key|KEY|secret|token|key)[\w$]*`;
const ENVGET = String.raw`Deno\.env\.get\(\s*(?:"[^"]*"|'[^']*')\s*\)`;
const OP = String.raw`(!==|===|!=|==)`;

// Group layout is fixed so rewrite() can reuse it: 1 = lhs, 2 = op, 3 = rhs. Quote back-references are made unique per regex.
const FIXABLE = [
  new RegExp(String.raw`(${GET})\s*${OP}\s*(${IDENT})(?![\w$.(\[])`, "gi"),
  new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*${OP}\s*(${GET})`, "gi"),
  new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*${OP}\s*(${ENVGET})`, "g"),
  new RegExp(String.raw`(${ENVGET})\s*${OP}\s*(${IDENT})(?![\w$.(\[])`, "g"),
];
const REPORT_ONLY = [
  new RegExp(String.raw`(?<![\w$.])((?:expected|computed)\w*)\s*${OP}\s*(signature|sig|digest|mac|hmac|\w+\[\d\])(?![\w$])`, "g"),
  new RegExp(String.raw`(?<![\w$.])(signature|sig|digest|mac|hmac)\s*${OP}\s*((?:expected|computed)\w*)(?![\w$])`, "g"),
];
const NEVER_SECRET_RHS = /^(?:null|undefined|true|false)$/;

/** Blanks out comments and string-literal-free regions are NOT needed for line rules, only comments are. */
export function stripLineComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

const isAllowed = (line) => /\/\/\s*timing-safe-ok\b/.test(line) || line.includes(HELPER) || /timingSafeEqual|constantTimeEqual|secretEquals/.test(line);

/** Returns [{ line, text, fixable }] for one file's source. Block comments are skipped by tracking `/* ... *\/`. */
export function findViolations(source) {
  const out = [];
  let inBlock = false;
  source.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlock) { const end = line.indexOf("*/"); if (end < 0) return; line = line.slice(end + 2); inBlock = false; }
    for (let s = line.indexOf("/*"); s >= 0; s = line.indexOf("/*")) {
      const e = line.indexOf("*/", s + 2);
      if (e < 0) { line = line.slice(0, s); inBlock = true; break; }
      line = line.slice(0, s) + " ".repeat(e + 2 - s) + line.slice(e + 2);
    }
    const code = stripLineComment(line);
    if (!code.trim() || isAllowed(raw)) return;
    const hitFix = FIXABLE.some((re) => { re.lastIndex = 0; return re.test(code); });
    const hitReport = REPORT_ONLY.some((re) => { re.lastIndex = 0; return re.test(code); });
    if (hitFix || hitReport) out.push({ line: i + 1, text: raw.trim().slice(0, 160), fixable: hitFix });
  });
  return out;
}

/** Rewrites the fixable shapes on one line. `X !== S` -> `!checkSharedSecret(S, X)`; `X === S` -> `checkSharedSecret(S, X)`. */
export function rewriteLine(raw) {
  const commentAt = raw.length - stripLineComment(raw).length;
  let code = raw.slice(0, raw.length - commentAt);
  const tail = raw.slice(raw.length - commentAt);
  if (isAllowed(raw)) return raw;
  const apply = (re, lhsIsSecret) => {
    code = code.replace(re, (m, lhs, ...rest) => {
      // capture groups differ per regex (GET has a quote group): take the string groups before the offset and pick the operator + its right-hand neighbour.
      const firstNumber = rest.findIndex((g) => typeof g === "number");
      const nums = rest.slice(0, firstNumber < 0 ? rest.length : firstNumber).filter((g) => typeof g === "string");
      const op = nums.find((g) => /^(?:!==|===|!=|==)$/.test(g));
      const rhs = nums[nums.indexOf(op) + 1];
      if (!op || rhs === undefined || NEVER_SECRET_RHS.test(rhs)) return m;
      const [expected, provided] = lhsIsSecret ? [lhs, rhs] : [rhs, lhs];
      const call = `${HELPER}(${expected}, ${provided})`;
      return op.startsWith("!") ? `!${call}` : call;
    });
  };
  apply(FIXABLE[0], false); // GET op IDENT   -> expected = IDENT (rhs), provided = GET (lhs)
  apply(FIXABLE[1], true);  // IDENT op GET   -> expected = IDENT (lhs), provided = GET (rhs)
  apply(FIXABLE[2], false); // IDENT op ENV   -> expected = ENV (rhs), provided = IDENT (lhs)
  apply(FIXABLE[3], true);  // ENV op IDENT   -> expected = ENV (lhs), provided = IDENT (rhs)
  return code + tail;
}

const relImport = (file) => {
  let rel = path.relative(path.dirname(file), CORE).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
};

/** Adds `checkSharedSecret` to the file's imports (merging into an existing core.ts import when present). */
export function ensureImport(source, file) {
  const spec = relImport(file);
  if (new RegExp(String.raw`import\s*\{[^}]*\b${HELPER}\b[^}]*\}\s*from\s*["'][^"']*http/core\.ts["']`).test(source)) return source;
  const existing = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*(["'])([^"']*http/core\.ts)\2`);
  const m = existing.exec(source);
  if (m) {
    const names = m[1].trim().replace(/,\s*$/, "");
    return source.replace(existing, `import { ${names ? names + ", " : ""}${HELPER} } from ${m[2]}${m[3]}${m[2]}`);
  }
  const line = `import { ${HELPER} } from "${spec}";`;
  const lines = source.split("\n");
  const firstImport = lines.findIndex((l) => /^import\s/.test(l));
  if (firstImport >= 0) { lines.splice(firstImport, 0, line); return lines.join("\n"); }
  let i = 0;
  while (i < lines.length && (/^\s*\/\//.test(lines[i]) || lines[i].trim() === "")) i++;
  lines.splice(i, 0, line, "");
  return lines.join("\n");
}

export function rewriteSource(source, file) {
  const violations = findViolations(source).filter((v) => v.fixable);
  if (!violations.length) return { source, changed: 0 };
  const lines = source.split("\n");
  let changed = 0;
  for (const v of violations) {
    const next = rewriteLine(lines[v.line - 1]);
    if (next !== lines[v.line - 1]) { lines[v.line - 1] = next; changed++; }
  }
  return { source: changed ? ensureImport(lines.join("\n"), file) : source, changed };
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") yield* walk(p); }
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.[tj]sx?$/.test(e.name)) yield p;
  }
}

export function scan(root = FUNCTIONS) {
  const results = [];
  for (const file of walk(root)) {
    const v = findViolations(fs.readFileSync(file, "utf8"));
    if (v.length) results.push({ file, violations: v });
  }
  return results;
}

function main() {
  const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--write") ? "write" : "dry";
  const results = scan();
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
  if (mode === "write" || mode === "dry") {
    let files = 0, lines = 0;
    for (const { file } of results) {
      const src = fs.readFileSync(file, "utf8");
      const r = rewriteSource(src, file);
      if (!r.changed) continue;
      files++; lines += r.changed;
      if (mode === "write") fs.writeFileSync(file, r.source);
      else console.log(`would fix ${rel(file)} (${r.changed} line${r.changed > 1 ? "s" : ""})`);
    }
    console.log(`${mode === "write" ? "fixed" : "fixable"}: ${lines} line(s) in ${files} file(s)`);
  }
  const remaining = mode === "write" ? scan() : results;
  const leftovers = mode === "dry" ? [] : remaining;
  if (mode === "check" || mode === "write") {
    for (const { file, violations } of leftovers) for (const v of violations) console.error(`${rel(file)}:${v.line}: ${v.fixable ? "plain secret comparison" : "plain signature comparison (fix by hand)"} — use ${HELPER}() from _shared/http/core.ts: ${v.text}`);
    if (leftovers.length) { console.error(`\n${leftovers.reduce((n, r) => n + r.violations.length, 0)} violation(s) in ${leftovers.length} file(s). ${mode === "check" ? "Run: node scripts/security/secret-compare.mjs --write" : "Fix the remaining ones by hand."}`); process.exit(1); }
    console.log("secret-compare: OK — no ===/!== secret comparisons.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
