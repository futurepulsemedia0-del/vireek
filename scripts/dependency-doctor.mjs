#!/usr/bin/env node
// scripts/dependency-doctor.mjs
//
// Detects dependency drift between what the code imports, what package.json declares,
// what package-lock.json locks, and what the Cloudflare build installs outside the lockfile.
//
// Finding kinds
//   invalid-json          package.json or package-lock.json cannot be parsed (npm ci cannot run)
//   undeclared            a bare package specifier is imported by code but not declared in package.json
//   lock-root-drift       package.json and the lockfile root disagree (missing on either side, or different range)
//   lock-missing          a declared (non-optional) dependency has no node_modules/<name> entry in the lockfile
//   unlocked-install      cf-build.sh installs a package with --no-save that package.json does not declare
//
// Baseline (ratchet), scripts/governance/baselines/dependency-doctor.json:
//   default / --check     a NEW finding fails; a baselined finding that is now fixed also fails
//                         ("remove it from the baseline"), so the list can only shrink.
//   --strict (no flag)    baseline ignored, every finding fails.
//   --write-baseline      regenerates the baseline from the current findings (keeps existing notes).
//
// Zero dependencies (Node built-ins only), offline, no `npm ci` needed.
//
// Usage:
//   node scripts/dependency-doctor.mjs                  # strict: any finding -> exit 1
//   node scripts/dependency-doctor.mjs --check          # CI: honour the baseline
//   node scripts/dependency-doctor.mjs --write-baseline
//   node scripts/dependency-doctor.mjs --json           # machine readable output
//   node scripts/dependency-doctor.mjs --root <dir>     # check another checkout (used by tests)
//
// Known limits (deliberate, to avoid false positives): imports are found with anchored regexes, not
// a parser, so exotic syntax can be missed; Deno edge functions (supabase/functions) and the
// self-contained packages/* workspaces are not scanned; version-range satisfaction is not evaluated
// (that needs semver and a real install, which `npm ci` already does).

import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_FILE = 'scripts/governance/baselines/dependency-doctor.json';

const SCAN_DIRS = ['src', 'api', 'worker', 'e2e', 'scripts', '.storybook'];
const RUNTIME_DIRS = new Set(['src', 'api', 'worker']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.next', '.turbo']);
const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec|stories)\.[^/]+$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// ---------------------------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------------------------

const STATIC_RE =
  /(?:^|[;{}\n])[ \t]*(?:import|export)\s+(?:type\s+)?(?:[\w*${},\s]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
const DYNAMIC_RE = /(?<![\w.$])(?:import|require)\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** Package name of a bare specifier, or null when it is not an npm package reference. */
export function packageNameOf(specifier) {
  if (!specifier || /^[./#~]/.test(specifier) || specifier.startsWith('@/')) return null;
  if (/^(?:npm|jsr|node|data|https?|virtual):/.test(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!NPM_NAME.test(name) || BUILTINS.has(name)) return null;
  return name;
}

/** @returns {Set<string>} package names imported by one source text */
export function extractImports(source) {
  const found = new Set();
  for (const re of [STATIC_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const name = packageNameOf(m[1]);
      if (name) found.add(name);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// File walking and manifest reading
// ---------------------------------------------------------------------------------------------

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('dist-')) yield* walk(path.join(dir, e.name));
    } else if (e.isFile() && CODE_EXT.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function internalNames(root) {
  const names = new Set();
  const pkgDir = path.join(root, 'packages');
  if (!existsSync(pkgDir)) return names;
  for (const e of readdirSync(pkgDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const j = readJson(path.join(pkgDir, e.name, 'package.json'));
    if (j.value?.name) names.add(j.value.name);
  }
  return names;
}

/** Packages installed with --no-save in a shell build script (backslash continuations honoured). */
export function parseNoSaveInstalls(script) {
  const joined = script.replace(/\\\r?\n/g, ' ');
  const names = new Set();
  for (const line of joined.split(/\r?\n/)) {
    if (!/\bnpm\s+(?:install|i)\b/.test(line) || !/--no-save\b/.test(line)) continue;
    const after = line.split(/\bnpm\s+(?:install|i)\b/)[1] ?? '';
    for (const tok of after.split(/\s+/)) {
      if (!tok || tok.startsWith('-')) continue;
      const at = tok.lastIndexOf('@');
      const name = at > 0 ? tok.slice(0, at) : tok;
      if (NPM_NAME.test(name)) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ key: string, kind: string, name: string, detail: string }} Finding
 * @param {string} root
 * @returns {Finding[]}
 */
export function analyze(root) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (kind, name, detail) => findings.push({ key: `${kind}:${name}`, kind, name, detail });

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg.error) {
    add('invalid-json', 'package.json', pkg.error);
    return findings;
  }
  const manifest = pkg.value;
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const declared = new Set(sections.flatMap((s) => Object.keys(manifest[s] ?? {})));
  const internal = internalNames(root);
  if (manifest.name) internal.add(manifest.name);

  // 1. imports vs package.json
  /** @type {Map<string, Set<string>>} */
  const usage = new Map();
  const files = [];
  for (const d of SCAN_DIRS) files.push(...walk(path.join(root, d)));
  for (const e of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (e.isFile() && CODE_EXT.test(e.name)) files.push(path.join(root, e.name));
  }
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const top = rel.split('/')[0];
    const scope = RUNTIME_DIRS.has(top) && !TEST_FILE.test(rel) ? 'runtime' : 'dev';
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of extractImports(text)) {
      if (!usage.has(name)) usage.set(name, new Set());
      usage.get(name).add(`${scope}:${rel}`);
    }
  }
  for (const [name, where] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
    if (declared.has(name) || internal.has(name)) continue;
    const list = [...where].sort();
    const scope = list.some((w) => w.startsWith('runtime:')) ? 'runtime' : 'dev';
    add('undeclared', name, `${scope} import, e.g. ${list[0].replace(/^[a-z]+:/, '')} (${list.length} file${list.length === 1 ? '' : 's'})`);
  }

  // 2. package.json vs lockfile
  const lockPath = path.join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath);
    if (lock.error) {
      add('invalid-json', 'package-lock.json', lock.error);
    } else {
      const lp = lock.value.packages ?? {};
      const rootEntry = lp[''] ?? {};
      const want = { ...(manifest.devDependencies ?? {}), ...(manifest.dependencies ?? {}) };
      const have = { ...(rootEntry.devDependencies ?? {}), ...(rootEntry.dependencies ?? {}) };
      for (const name of [...new Set([...Object.keys(want), ...Object.keys(have)])].sort()) {
        if (want[name] === have[name]) continue;
        const w = want[name] ?? 'absent';
        const h = have[name] ?? 'absent';
        add('lock-root-drift', name, `package.json: ${w} | lockfile root: ${h}`);
      }
      const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
      for (const name of Object.keys(want).sort()) {
        if (optional.has(name)) continue;
        if (!lp[`node_modules/${name}`]) add('lock-missing', name, 'no node_modules entry in package-lock.json');
      }
    }
  }

  // 3. cf-build.sh installs outside the lockfile
  const cf = path.join(root, 'cf-build.sh');
  if (existsSync(cf)) {
    for (const name of [...parseNoSaveInstalls(readFileSync(cf, 'utf8'))].sort()) {
      if (!declared.has(name)) add('unlocked-install', name, 'installed with --no-save in cf-build.sh, not declared in package.json');
    }
  }

  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------
// Baseline ratchet
// ---------------------------------------------------------------------------------------------

export function readBaseline(root) {
  const file = path.join(root, BASELINE_FILE);
  if (!existsSync(file)) return { entries: [] };
  const j = readJson(file);
  if (j.error) throw new Error(`${BASELINE_FILE}: ${j.error}`);
  return { entries: Array.isArray(j.value.entries) ? j.value.entries : [] };
}

/** @returns {{ added: Finding[], fixed: {key: string}[], known: Finding[] }} */
export function compare(findings, baseline) {
  const base = new Map(baseline.entries.map((e) => [e.key, e]));
  const now = new Set(findings.map((f) => f.key));
  return {
    added: findings.filter((f) => !base.has(f.key)),
    known: findings.filter((f) => base.has(f.key)),
    fixed: baseline.entries.filter((e) => !now.has(e.key)),
  };
}

export function writeBaseline(root, findings) {
  const prev = new Map(readBaseline(root).entries.map((e) => [e.key, e]));
  const entries = findings.map((f) => ({
    key: f.key,
    kind: f.kind,
    name: f.name,
    note: prev.get(f.key)?.note ?? '[TRIAGE] declare + lock the package, or remove the import.',
  }));
  const file = path.join(root, BASELINE_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    $comment:
      'Known dependency drift (ratchet). Only ever shrink this list: fix the drift, then remove the entry. Checked by scripts/dependency-doctor.mjs --check.',
    entries,
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return entries.length;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { check: false, writeBaseline: false, json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--write-baseline') o.writeBaseline = true;
    else if (a === '--json') o.json = true;
    else if (a === '--root') o.root = path.resolve(argv[++i] ?? '');
    else {
      console.error(`dependency-doctor: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const findings = analyze(opts.root);

  if (opts.writeBaseline) {
    if (findings.some((f) => f.kind === 'invalid-json')) {
      console.error('dependency-doctor: refusing to write a baseline while a manifest is invalid JSON.');
      for (const f of findings.filter((x) => x.kind === 'invalid-json')) console.error(`  ${f.name}: ${f.detail}`);
      return 1;
    }
    const n = writeBaseline(opts.root, findings);
    console.log(`dependency-doctor: wrote ${BASELINE_FILE} (${n} entr${n === 1 ? 'y' : 'ies'}).`);
    return 0;
  }

  let failures = findings;
  let stale = [];
  if (opts.check) {
    const diff = compare(findings, readBaseline(opts.root));
    failures = diff.added;
    stale = diff.fixed;
  }

  if (opts.json) {
    console.log(JSON.stringify({ mode: opts.check ? 'check' : 'strict', findings, failures, stale }, null, 2));
  } else {
    for (const f of failures) console.error(`${f.kind.padEnd(17)} ${f.name}  ${f.detail}`);
    for (const e of stale) console.error(`stale-baseline    ${e.key}  now fixed: remove it from ${BASELINE_FILE}`);
    const mode = opts.check ? 'check' : 'strict';
    console.log(
      `dependency-doctor (${mode}): ${findings.length} finding(s), ${failures.length} failing, ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}.`,
    );
  }
  return failures.length || stale.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
