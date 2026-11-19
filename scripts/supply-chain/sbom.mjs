#!/usr/bin/env node
// scripts/supply-chain/sbom.mjs
//
// Generates a CycloneDX 1.5 JSON SBOM from package-lock.json (lockfileVersion 2/3).
// Pure Node, no dependencies, offline, deterministic (same lockfile + same
// SOURCE_DATE_EPOCH => byte-identical output), so it runs in CI and in unit tests.
//
// Usage:
//   node scripts/supply-chain/sbom.mjs [--lock package-lock.json] [--out sbom/vireek.cdx.json]
//                                      [--omit-dev] [--check]
//                                      | --verify <bom.json>
//
//   --omit-dev  exclude packages the lockfile marks `dev: true`
//   --check     validate the lockfile and print a summary, write nothing
//
// Environment:
//   SOURCE_DATE_EPOCH  unix seconds used for metadata.timestamp (reproducible builds)
//   GITHUB_SHA         recorded as a property when present (provenance cross-reference)
//
// Exit codes: 0 ok, 1 lockfile unreadable/unsupported, 2 bad arguments.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOM_FORMAT = 'CycloneDX';
export const SPEC_VERSION = '1.5';
const TOOL = { type: 'application', name: 'vireek-sbom', version: '1.0.0' };

/** Last `node_modules/` segment => real package name (handles nesting and scopes). */
export function nameFromPath(path) {
  const i = path.lastIndexOf('node_modules/');
  return i === -1 ? null : path.slice(i + 'node_modules/'.length);
}

/** Percent-encode per the purl spec; the scope `@` becomes %40 and `/` stays. */
export function purl(name, version) {
  const enc = name.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `pkg:npm/${enc}@${encodeURIComponent(version)}`;
}

/** `sha512-<base64>` / `sha1-<base64>` (SRI) -> CycloneDX hash entry. */
export function sriToHashes(integrity) {
  if (typeof integrity !== 'string') return [];
  const algs = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
  const out = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!m) continue;
    out.push({ alg: algs[m[1]], content: Buffer.from(m[2], 'base64').toString('hex') });
  }
  return out;
}

/** Normalise the lockfile `license` field (string, SPDX expression, legacy object). */
function licenses(entry) {
  const raw = entry.license;
  const l = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.type : null;
  if (!l || typeof l !== 'string') return undefined;
  // SPDX expressions (contain operators/parentheses) must use `expression`.
  if (/[()\s]/.test(l)) return [{ expression: l }];
  return [{ license: { id: l } }];
}

function externalReferences(entry) {
  const refs = [];
  if (typeof entry.resolved === 'string' && /^https?:\/\//.test(entry.resolved)) {
    // Strip credentials a private registry URL could carry.
    let url = entry.resolved;
    try {
      const u = new URL(entry.resolved);
      u.username = '';
      u.password = '';
      url = u.toString();
    } catch {
      return undefined;
    }
    refs.push({ type: 'distribution', url });
  }
  return refs.length ? refs : undefined;
}

/**
 * Build the BOM object. Pure: all inputs explicit so tests need no filesystem.
 * @param {object} lock parsed package-lock.json
 * @param {{omitDev?: boolean, now?: Date, serialNumber?: string, commit?: string}} opts
 */
export function buildBom(lock, opts = {}) {
  if (!lock || typeof lock !== 'object' || typeof lock.packages !== 'object' || !lock.packages) {
    throw new Error('Unsupported lockfile: missing "packages" map (need lockfileVersion 2 or 3).');
  }
  const root = lock.packages[''] ?? {};
  const rootName = root.name ?? lock.name ?? 'unknown';
  const rootVersion = root.version ?? lock.version ?? '0.0.0';
  const rootRef = purl(rootName, rootVersion);

  const components = new Map(); // bom-ref -> component (dedupe by name@version)
  const refByPath = new Map();
  const skipped = { link: 0, dev: 0, noVersion: 0 };

  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    const name = nameFromPath(path);
    if (!name) continue; // workspace folder entries etc.
    if (entry.link) { skipped.link++; continue; }
    if (!entry.version) { skipped.noVersion++; continue; }
    if (opts.omitDev && entry.dev) { skipped.dev++; continue; }
    const realName = entry.name ?? name; // npm aliases keep the real name in `name`
    const ref = purl(realName, entry.version);
    refByPath.set(path, ref);
    if (components.has(ref)) continue;

    const props = [];
    if (entry.dev) props.push({ name: 'cdx:npm:package:development', value: 'true' });
    if (entry.optional) props.push({ name: 'cdx:npm:package:optional', value: 'true' });
    if (entry.peer) props.push({ name: 'cdx:npm:package:peer', value: 'true' });
    if (entry.hasInstallScript) props.push({ name: 'cdx:npm:package:has-install-script', value: 'true' });
    if (entry.inBundle) props.push({ name: 'cdx:npm:package:bundled', value: 'true' });
    if (typeof entry.resolved === 'string' && !/^https?:\/\//.test(entry.resolved)) {
      props.push({ name: 'cdx:npm:package:non-registry-source', value: 'true' });
    }

    const scoped = realName.startsWith('@');
    const component = {
      type: 'library',
      'bom-ref': ref,
      ...(scoped ? { group: realName.split('/')[0] } : {}),
      name: scoped ? realName.split('/').slice(1).join('/') : realName,
      version: entry.version,
      scope: entry.dev || entry.optional ? 'optional' : 'required',
      ...(sriToHashes(entry.integrity).length ? { hashes: sriToHashes(entry.integrity) } : {}),
      ...(licenses(entry) ? { licenses: licenses(entry) } : {}),
      purl: ref,
      ...(externalReferences(entry) ? { externalReferences: externalReferences(entry) } : {}),
      ...(props.length ? { properties: props } : {}),
    };
    components.set(ref, component);
  }

  // Dependency graph: resolve each dependency with Node's lookup (walk up node_modules).
  const resolveDep = (fromPath, depName) => {
    let base = fromPath;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${depName}`;
      if (lock.packages[candidate]) return candidate;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i === -1 ? '' : base.slice(0, i);
    }
  };
  const edges = new Map();
  const addEdges = (fromRef, fromPath, entry) => {
    const set = edges.get(fromRef) ?? new Set();
    const deps = { ...entry.dependencies, ...entry.optionalDependencies };
    if (fromPath === '') Object.assign(deps, root.devDependencies, root.peerDependencies);
    for (const dep of Object.keys(deps)) {
      const target = resolveDep(fromPath, dep);
      const ref = target && refByPath.get(target);
      if (ref) set.add(ref);
    }
    edges.set(fromRef, set);
  };
  addEdges(rootRef, '', root);
  for (const [path, ref] of refByPath) addEdges(ref, path, lock.packages[path]);

  const dependencies = [...edges.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ref, set]) => ({ ref, dependsOn: [...set].sort() }));

  const sorted = [...components.values()].sort((a, b) => (a['bom-ref'] < b['bom-ref'] ? -1 : 1));
  const props = [{ name: 'vireek:lockfileVersion', value: String(lock.lockfileVersion ?? 'unknown') }];
  if (opts.commit) props.push({ name: 'vireek:git-commit', value: opts.commit });
  if (opts.omitDev) props.push({ name: 'vireek:omit-dev', value: 'true' });

  const bom = {
    bomFormat: BOM_FORMAT,
    specVersion: SPEC_VERSION,
    serialNumber: opts.serialNumber ?? `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: (opts.now ?? new Date()).toISOString(),
      tools: [TOOL],
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: rootName,
        version: rootVersion,
        purl: rootRef,
      },
      properties: props,
    },
    components: sorted,
    dependencies,
  };
  return { bom, stats: { components: sorted.length, skipped } };
}

/** Deterministic serial: UUID derived from the lockfile bytes + flags (not random). */
export function deterministicSerial(lockText, flags = '') {
  const h = createHash('sha256').update(lockText).update('\0').update(flags).digest('hex');
  const v = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return `urn:uuid:${v}`;
}

/** Structural self-check of a generated BOM. Returns a list of problems (empty = ok). */
export function verifyBom(bom) {
  const errs = [];
  if (!bom || typeof bom !== 'object') return ['not an object'];
  if (bom.bomFormat !== BOM_FORMAT) errs.push('bomFormat');
  if (bom.specVersion !== SPEC_VERSION) errs.push('specVersion');
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(bom.serialNumber ?? '')) errs.push('serialNumber');
  if (!Array.isArray(bom.components) || bom.components.length === 0) errs.push('components empty');
  const refs = new Set();
  for (const c of bom.components ?? []) {
    if (!c['bom-ref'] || !c.name || !c.version) errs.push(`component incomplete: ${c.name}`);
    if (refs.has(c['bom-ref'])) errs.push(`duplicate bom-ref ${c['bom-ref']}`);
    refs.add(c['bom-ref']);
  }
  if (bom.metadata?.component?.['bom-ref']) refs.add(bom.metadata.component['bom-ref']);
  else errs.push('metadata.component');
  for (const d of bom.dependencies ?? []) {
    if (!refs.has(d.ref)) errs.push(`dangling ref ${d.ref}`);
    for (const x of d.dependsOn ?? []) if (!refs.has(x)) errs.push(`dangling dependsOn ${x}`);
  }
  return errs;
}

function parseArgs(argv) {
  const a = { lock: 'package-lock.json', out: 'sbom/vireek.cdx.json', omitDev: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--verify' && argv[i + 1]) a.verify = argv[++i];
    else if (k === '--omit-dev') a.omitDev = true;
    else if (k === '--check') a.check = true;
    else if (k === '--lock' && argv[i + 1]) a.lock = argv[++i];
    else if (k === '--out' && argv[i + 1]) a.out = argv[++i];
    else return null;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('Usage: sbom.mjs [--lock <file>] [--out <file>] [--omit-dev] [--check] | --verify <bom.json>');
    process.exit(2);
  }
  if (args.verify) {
    let errs;
    try { errs = verifyBom(JSON.parse(readFileSync(resolve(args.verify), 'utf8'))); }
    catch (e) { errs = [`cannot read ${args.verify}: ${e.message}`]; }
    if (errs.length) { console.error(`sbom: INVALID\n${errs.slice(0, 20).join('\n')}`); process.exit(1); }
    console.log('sbom: structure OK');
    return;
  }
  let text;
  let lock;
  try {
    text = readFileSync(resolve(args.lock), 'utf8');
    lock = JSON.parse(text);
  } catch (e) {
    console.error(`sbom: cannot read/parse ${args.lock}: ${e.message}`);
    process.exit(1);
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const now = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
  let result;
  try {
    result = buildBom(lock, {
      omitDev: args.omitDev,
      now,
      serialNumber: deterministicSerial(text, args.omitDev ? 'omit-dev' : ''),
      commit: process.env.GITHUB_SHA,
    });
  } catch (e) {
    console.error(`sbom: ${e.message}`);
    process.exit(1);
  }
  const { bom, stats } = result;
  const s = stats.skipped;
  console.log(`sbom: ${stats.components} components (skipped: ${s.link} links, ${s.dev} dev, ${s.noVersion} without version)`);
  if (args.check) return;
  const out = resolve(args.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
  const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
  console.log(`sbom: wrote ${args.out}\nsbom: sha256 ${sha}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
