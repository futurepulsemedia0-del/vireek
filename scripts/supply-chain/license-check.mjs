#!/usr/bin/env node
/**
 * OSS licence compliance gate (offline, dependency-free).
 *
 *   node scripts/supply-chain/license-check.mjs                 check (exit 1 on denied / unknown / unwaived review)
 *   node scripts/supply-chain/license-check.mjs --json          machine-readable report
 *   node scripts/supply-chain/license-check.mjs --write-notices regenerate THIRD_PARTY_NOTICES.md
 *   node scripts/supply-chain/license-check.mjs --check-notices fail if THIRD_PARTY_NOTICES.md is stale
 *   flags: --include-dev  --strict-verify  --lock <file>  --config <file>  --root <dir>  --notices <file>
 *
 * Scope (what "all production dependencies" means here):
 *   1. npm: every package in package-lock.json that is NOT dev-only (dev:true excluded; optional, peer and
 *      devOptional entries are INCLUDED, conservatively). Licence = lockfile `license`; if absent, falls back to
 *      node_modules/<pkg>/package.json when installed.
 *   2. Edge functions: every `npm:`, `jsr:` and https import in supabase/functions (non-test files). These are
 *      NOT in package-lock.json. Resolved from the lockfile when the same package is there, otherwise from
 *      `externalImports` in the policy file (entries marked verified:false are reported as [VERIFY]).
 * NOT covered (no offline source of truth): Gradle / CocoaPods native dependencies, fonts, images, vendored code.
 *
 * Exit codes: 0 pass · 1 policy failure · 2 usage / configuration error.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RANK = { allow: 0, review: 1, unknown: 2, deny: 3 };

// ---------------------------------------------------------------- SPDX ----
/** Minimal SPDX expression parser: ids, WITH, AND, OR, parentheses. Unparseable text becomes one opaque id. */
export function parseSpdx(input) {
  const src = String(input ?? '')
    .replace(/SEE LICENSE IN\s+\S+/gi, 'LicenseRef-See-License-File')
    .trim();
  if (!src) return { type: 'id', id: '' };
  const tokens = src.match(/\(|\)|[^\s()]+/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  const upper = (t) => (t || '').toUpperCase();
  function parseOr() {
    let left = parseAnd();
    while (upper(peek()) === 'OR') { i++; left = { type: 'or', l: left, r: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseAtom();
    while (upper(peek()) === 'AND') { i++; left = { type: 'and', l: left, r: parseAtom() }; }
    return left;
  }
  function parseAtom() {
    const t = peek();
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      i++;
      const e = parseOr();
      if (peek() !== ')') throw new Error('missing )');
      i++;
      return e;
    }
    if (t === ')' || ['AND', 'OR', 'WITH'].includes(upper(t))) throw new Error('unexpected ' + t);
    i++;
    let node = { type: 'id', id: t };
    if (upper(peek()) === 'WITH') { i++; const ex = peek(); if (ex === undefined) throw new Error('WITH needs exception'); i++; node = { type: 'id', id: t, exception: ex }; }
    return node;
  }
  try {
    const ast = parseOr();
    if (i !== tokens.length) throw new Error('trailing tokens');
    return ast;
  } catch {
    return { type: 'id', id: src }; // opaque -> will classify as unknown
  }
}

const globToRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

export function makeClassifier(policy) {
  const aliases = new Map(Object.entries(policy.aliases || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const lists = ['allow', 'review', 'deny'].map((k) => [k, (policy[k] || []).map(globToRe)]);
  return function classifyId(raw) {
    let id = String(raw).trim();
    id = aliases.get(id.toLowerCase()) ?? id;
    for (const [status, res] of lists) if (res.some((re) => re.test(id))) return { status, id };
    return { status: 'unknown', id };
  };
}

/** OR => best alternative wins; AND => worst component wins. WITH never improves a status. */
export function evaluate(ast, classifyId) {
  if (ast.type === 'id') {
    const c = classifyId(ast.id);
    return { status: c.status, elected: ast.exception ? `${c.id} WITH ${ast.exception}` : c.id };
  }
  const l = evaluate(ast.l, classifyId);
  const r = evaluate(ast.r, classifyId);
  if (ast.type === 'or') return RANK[l.status] <= RANK[r.status] ? l : r;
  return { status: RANK[l.status] >= RANK[r.status] ? l.status : r.status, elected: `${l.elected} AND ${r.elected}` };
}

// -------------------------------------------------------------- policy ----
export function validatePolicy(p) {
  const errs = [];
  for (const k of ['allow', 'review', 'deny']) if (!Array.isArray(p[k])) errs.push(`policy.${k} must be an array`);
  if (errs.length) return errs;
  const lc = (a) => a.map((s) => s.toLowerCase());
  for (const a of lc(p.allow)) {
    if (lc(p.deny).includes(a) || lc(p.review).includes(a)) errs.push(`"${a}" appears in more than one of allow/review/deny`);
  }
  for (const w of p.waivers || []) {
    for (const f of ['name', 'reason', 'approvedBy', 'expires']) if (!w[f]) errs.push(`waiver ${w.name || '?'} missing "${f}"`);
    if (w.expires && Number.isNaN(Date.parse(w.expires))) errs.push(`waiver ${w.name} has an invalid expires date`);
  }
  return errs;
}

// ---------------------------------------------------------- collection ----
const nameFromKey = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

function normLicense(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && v.type) return String(v.type).trim();
  if (Array.isArray(v) && v.length) return '(' + v.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ') + ')';
  return '';
}

export function collectNpm(lock, { includeDev = false, root = null } = {}) {
  const out = new Map();
  for (const [key, e] of Object.entries(lock.packages || {})) {
    if (!key || e.link) continue;
    if (e.dev === true && !includeDev) continue;
    const name = e.name || nameFromKey(key);
    let license = normLicense(e.license ?? e.licenses);
    let source = 'package-lock.json';
    if (!license && root) {
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(root, key, 'package.json'), 'utf8'));
        license = normLicense(pj.license ?? pj.licenses);
        if (license) source = 'node_modules';
      } catch { /* not installed */ }
    }
    const id = `${name}@${e.version}`;
    if (!out.has(id)) {
      out.set(id, { name, version: e.version, license, source, origin: 'npm', optional: !!e.optional, dev: e.dev === true, resolved: e.resolved || '' });
    }
  }
  return [...out.values()];
}

const SKIP_DIRS = new Set(['node_modules', '.git']);
function* walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(d.name)) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Distinct external specifiers imported by edge-function source (tests excluded). */
export function scanDenoImports(root) {
  const base = path.join(root, 'supabase', 'functions');
  const found = new Map();
  if (!fs.existsSync(base)) return [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["'](npm:[^"']+|jsr:[^"']+|https:\/\/[^"']+)["']/g;
  for (const f of walk(base)) {
    if (!/\.(ts|tsx|js|mjs)$/.test(f) || /(\.test\.|_test\.|\/tests?\/)/.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      let key; let version = '';
      let mm;
      if ((mm = spec.match(/^npm:(@?[^@/]+(?:\/[^@/]+)?)(?:@([^/]+))?/))) { key = `npm:${mm[1]}`; version = mm[2] || ''; }
      else if ((mm = spec.match(/^jsr:(@[^@/]+\/[^@/]+)(?:@([^/]+))?/))) { key = `jsr:${mm[1]}`; version = mm[2] || ''; }
      else if ((mm = spec.match(/^https:\/\/deno\.land\/std(?:@([^/]+))?/))) { key = 'https://deno.land/std'; version = mm[1] || ''; }
      else if ((mm = spec.match(/^https:\/\/esm\.sh\/(@?[^@/]+(?:\/[^@/]+)?)(?:@([^/]+))?/))) { key = `https://esm.sh/${mm[1]}`; version = mm[2] || ''; }
      else { key = spec.split('?')[0]; }
      const cur = found.get(key) || { key, versions: new Set(), files: 0 };
      if (version) cur.versions.add(version);
      cur.files++;
      found.set(key, cur);
    }
  }
  return [...found.values()].map((v) => ({ key: v.key, versions: [...v.versions].sort(), files: v.files })).sort((a, b) => a.key.localeCompare(b.key));
}

export function resolveDeno(imports, npmPkgs, policy) {
  const ext = policy.externalImports || {};
  return imports.map((imp) => {
    const version = imp.versions.join(', ') || '(unpinned)';
    const manual = ext[imp.key];
    const name = imp.key.replace(/^(npm:|jsr:)/, '');
    if (manual) {
      return { name: imp.key, version, license: manual.license, source: `policy.externalImports (${manual.verified ? 'verified' : 'UNVERIFIED'})`, origin: 'deno', verified: !!manual.verified, files: imp.files };
    }
    const inLock = imp.key.startsWith('npm:') ? npmPkgs.filter((p) => p.name === name) : [];
    if (inLock.length) {
      return { name: imp.key, version, license: inLock[0].license, source: `package-lock.json (lock has ${inLock.map((p) => p.version).join(', ')})`, origin: 'deno', verified: true, files: imp.files };
    }
    return { name: imp.key, version, license: '', source: 'unresolved', origin: 'deno', verified: false, files: imp.files };
  });
}

// ---------------------------------------------------------------- check ----
export function check(pkgs, policy, now = new Date()) {
  const classify = makeClassifier(policy);
  const results = [];
  for (const p of pkgs) {
    let status; let elected;
    if (!p.license) { status = 'unknown'; elected = '(none declared)'; }
    else { ({ status, elected } = evaluate(parseSpdx(p.license), classify)); }
    const r = { ...p, status, elected, waiver: null, issue: null };
    if (status === 'deny') r.issue = `denied licence ${elected}`;
    else if (status === 'unknown') r.issue = p.license ? `unrecognised licence "${p.license}"` : 'no licence declared';
    else if (status === 'review') r.issue = `licence ${elected} requires review`;
    if (r.issue && status !== 'deny') {
      const w = (policy.waivers || []).find((x) => x.name === p.name && (!x.version || x.version === '*' || x.version === p.version));
      if (w) {
        if (new Date(w.expires + (w.expires.length === 10 ? 'T23:59:59Z' : '')) < now) {
          r.issue = `waiver expired on ${w.expires} (${r.issue})`;
          r.status = 'expired-waiver';
        } else { r.waiver = w; r.status = 'waived'; r.issue = null; }
      }
    }
    if (p.origin === 'deno' && !p.verified && !r.issue) r.unverified = true;
    results.push(r);
  }
  return results;
}

// --------------------------------------------------------------- notices ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function renderNotices(results, { lockSha, policySha, includeDev }) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const npm = results.filter((r) => r.origin === 'npm').sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  const deno = results.filter((r) => r.origin === 'deno').sort((a, b) => a.name.localeCompare(b.name));
  const byLic = new Map();
  for (const r of results) byLic.set(r.elected, (byLic.get(r.elected) || 0) + 1);
  const L = [];
  L.push('# Third-party notices', '');
  L.push('<!-- GENERATED by scripts/supply-chain/license-check.mjs --write-notices. Do not edit by hand. -->', '');
  L.push('This file lists the open-source components Vireek ships or runs in production and the licence under which each is used.');
  L.push('It is an **inventory generated from `package-lock.json` and the edge-function imports**; it is not legal advice and not a substitute for the licence texts.');
  L.push('The full licence text and copyright notice of each npm package is distributed inside the package itself (`node_modules/<name>/LICENSE*`) and must be preserved wherever that package is redistributed. **[COUNSEL]** confirm that the shipped web bundle and mobile apps satisfy attribution obligations (see `docs/compliance/oss-license-policy.md` §6).', '');
  L.push(`- Source lockfile SHA-256: \`${lockSha}\``);
  L.push(`- Policy file SHA-256: \`${policySha}\``);
  L.push(`- Scope: ${includeDev ? 'production **and development**' : 'production'} npm dependencies + edge-function imports`);
  L.push(`- npm packages: ${npm.length} · edge-function imports: ${deno.length}`, '');
  L.push('## Licence summary', '', '| Licence (as elected) | Count |', '|---|---:|');
  for (const [k, v] of [...byLic.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) L.push(`| ${esc(k)} | ${v} |`);
  const waived = results.filter((r) => r.waiver);
  if (waived.length) {
    L.push('', '## Waived items (time-boxed exceptions)', '', '| Package | Version | Licence | Approved by | Expires | Reason |', '|---|---|---|---|---|---|');
    for (const r of waived) L.push(`| ${esc(r.name)} | ${esc(r.version)} | ${esc(r.license || '(none)')} | ${esc(r.waiver.approvedBy)} | ${r.waiver.expires} | ${esc(r.waiver.reason)} |`);
  }
  L.push('', '## npm packages', '', '| Package | Version | Licence | Registry |', '|---|---|---|---|');
  for (const r of npm) L.push(`| ${esc(r.name)} | ${esc(r.version)} | ${esc(r.license || '(none declared)')} | https://www.npmjs.com/package/${r.name}/v/${r.version} |`);
  L.push('', '## Edge-function imports (not in package-lock.json)', '', '| Import | Version | Licence | Source of licence data |', '|---|---|---|---|');
  for (const r of deno) L.push(`| ${esc(r.name)} | ${esc(r.version)} | ${esc(r.license || '(unresolved)')} | ${esc(r.source)}${r.unverified ? ' **[VERIFY]**' : ''} |`);
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ main ----
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (['--json', '--include-dev', '--strict-verify', '--write-notices', '--check-notices', '--help'].includes(t)) a[t.slice(2)] = true;
    else if (['--lock', '--config', '--root', '--notices'].includes(t)) {
      if (argv[i + 1] === undefined) throw new Error(`${t} needs a value`);
      a[t.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${t}`);
  }
  return a;
}

export function run(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), now = new Date() } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { stderr(`license-check: ${e.message}\n`); return 2; }
  if (args.help) { stdout('See the header of scripts/supply-chain/license-check.mjs\n'); return 0; }
  const root = path.resolve(args.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const lockPath = path.resolve(root, args.lock || 'package-lock.json');
  const cfgPath = path.resolve(root, args.config || 'config/license-policy.json');
  const noticesPath = path.resolve(root, args.notices || 'THIRD_PARTY_NOTICES.md');
  let lockRaw; let cfgRaw; let lock; let policy;
  try { lockRaw = fs.readFileSync(lockPath, 'utf8'); lock = JSON.parse(lockRaw); }
  catch (e) { stderr(`license-check: cannot read lockfile ${lockPath}: ${e.message}\n`); return 2; }
  try { cfgRaw = fs.readFileSync(cfgPath, 'utf8'); policy = JSON.parse(cfgRaw); }
  catch (e) { stderr(`license-check: cannot read policy ${cfgPath}: ${e.message}\n`); return 2; }
  if (!lock.packages || ![2, 3].includes(lock.lockfileVersion)) { stderr('license-check: lockfileVersion 2 or 3 with a "packages" map is required\n'); return 2; }
  const perr = validatePolicy(policy);
  if (perr.length) { stderr('license-check: invalid policy:\n  ' + perr.join('\n  ') + '\n'); return 2; }

  const npmPkgs = collectNpm(lock, { includeDev: !!args['include-dev'], root });
  const denoPkgs = resolveDeno(scanDenoImports(root), npmPkgs, policy);
  const results = check([...npmPkgs, ...denoPkgs], policy, now);

  const problems = results.filter((r) => r.issue);
  const unverified = results.filter((r) => r.unverified);
  const waived = results.filter((r) => r.waiver);
  const strictFail = args['strict-verify'] && unverified.length > 0;

  const lockSha = sha256(lockRaw);
  const policySha = sha256(cfgRaw);
  const notices = renderNotices(results, { lockSha, policySha, includeDev: !!args['include-dev'] });

  if (args['write-notices']) {
    fs.writeFileSync(noticesPath, notices);
    stdout(`license-check: wrote ${path.relative(root, noticesPath)} (${results.length} entries)\n`);
  }
  let noticesStale = false;
  if (args['check-notices']) {
    let cur = null;
    try { cur = fs.readFileSync(noticesPath, 'utf8'); } catch { /* missing */ }
    noticesStale = cur !== notices;
  }

  const failed = problems.length > 0 || strictFail || noticesStale;
  if (args.json) {
    stdout(JSON.stringify({
      ok: !failed,
      counts: { total: results.length, npm: npmPkgs.length, edgeImports: denoPkgs.length, problems: problems.length, waived: waived.length, unverified: unverified.length },
      problems: problems.map((r) => ({ name: r.name, version: r.version, license: r.license, issue: r.issue })),
      waived: waived.map((r) => ({ name: r.name, version: r.version, expires: r.waiver.expires, approvedBy: r.waiver.approvedBy })),
      unverified: unverified.map((r) => ({ name: r.name, version: r.version, license: r.license })),
      noticesStale,
    }, null, 2) + '\n');
  } else {
    stdout(`Licence check: ${results.length} components (${npmPkgs.length} npm${args['include-dev'] ? ' incl. dev' : ' production'}, ${denoPkgs.length} edge-function imports)\n`);
    const tally = new Map();
    for (const r of results) tally.set(r.elected, (tally.get(r.elected) || 0) + 1);
    stdout('  ' + [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ') + '\n');
    for (const r of waived) stderr(`  WAIVED   ${r.name}@${r.version} — ${r.license || 'no licence'} — until ${r.waiver.expires} (approvedBy: ${r.waiver.approvedBy})\n`);
    for (const r of unverified) stderr(`  [VERIFY] ${r.name}@${r.version} — ${r.license || 'unresolved'} — ${r.source}\n`);
    for (const r of problems) stderr(`  FAIL     ${r.name}@${r.version} — ${r.issue}\n`);
    if (strictFail) stderr('  FAIL     --strict-verify: unverified licence entries remain\n');
    if (noticesStale) stderr(`  FAIL     ${path.relative(root, noticesPath)} is missing or stale — run: npm run licenses:notices\n`);
    stdout(failed ? 'RESULT: FAILED\n' : `RESULT: PASSED${waived.length || unverified.length ? ` (with ${waived.length} waiver(s), ${unverified.length} unverified entr${unverified.length === 1 ? 'y' : 'ies'})` : ''}\n`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
