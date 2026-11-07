#!/usr/bin/env node
// scripts/compliance/validate-controls.mjs
//
// Validates docs/compliance/soc2/controls.json and (re)generates
// docs/compliance/soc2/CONTROL_MAP.md from it, so the human-readable map can
// never drift from the machine-readable registry.
//
//   node scripts/compliance/validate-controls.mjs            validate only
//   node scripts/compliance/validate-controls.mjs --write    validate + regenerate CONTROL_MAP.md
//   node scripts/compliance/validate-controls.mjs --check    fail if CONTROL_MAP.md is stale
//
// What "validate" proves: every implementation path in the registry exists in
// this checkout, every collector is known, and no control is labelled "met"
// without both an implementation and an automated evidence collector.
// What it does NOT prove: that the control operates effectively. Only
// collected evidence and an independent auditor can do that.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTORS, isKnownCollector, sha256Hex, stableStringify } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const REGISTRY_PATH = 'docs/compliance/soc2/controls.json';
export const CONTROL_MAP_PATH = 'docs/compliance/soc2/CONTROL_MAP.md';

const ID_RE = /^[A-Z]{3}-\d{2}$/;
const CRITERION_RE = /^(CC\d\.\d|A1\.\d|C1\.\d)$/;
const CATEGORIES = ['security', 'availability', 'confidentiality'];
const STATUSES = ['met', 'partial', 'missing'];
const CLAIM_RE = /^[a-z][a-z0-9_]{2,60}$/;

/** Criteria in first-phase scope (Security CC1-CC9, Availability A1, Confidentiality C1). */
export const IN_SCOPE_CRITERIA = [
  'CC1.1', 'CC1.2', 'CC1.3', 'CC1.4', 'CC1.5',
  'CC2.1', 'CC2.2', 'CC2.3',
  'CC3.1', 'CC3.2', 'CC3.3', 'CC3.4',
  'CC4.1', 'CC4.2',
  'CC5.1', 'CC5.2', 'CC5.3',
  'CC6.1', 'CC6.2', 'CC6.3', 'CC6.4', 'CC6.5', 'CC6.6', 'CC6.7', 'CC6.8',
  'CC7.1', 'CC7.2', 'CC7.3', 'CC7.4', 'CC7.5',
  'CC8.1',
  'CC9.1', 'CC9.2',
  'A1.1', 'A1.2', 'A1.3',
  'C1.1', 'C1.2',
];

export function loadRegistry(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, REGISTRY_PATH), 'utf8'));
}

/**
 * @param {any} reg parsed controls.json
 * @param {{ exists?: (relPath: string) => boolean }} [opts]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateRegistry(reg, { exists = (p) => existsSync(join(REPO_ROOT, p)) } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (!reg || typeof reg !== 'object') return { errors: ['registry is not an object'], warnings };
  if (typeof reg.registryVersion !== 'string' || !reg.registryVersion) err('registryVersion must be a non-empty string');
  if (!Array.isArray(reg.controls) || reg.controls.length === 0) return { errors: [...errors, 'controls must be a non-empty array'], warnings };

  const ids = new Set();
  for (const c of reg.controls) {
    const where = `control ${c?.id ?? '(no id)'}`;
    if (typeof c?.id !== 'string' || !ID_RE.test(c.id)) { err(`${where}: id must match ${ID_RE}`); continue; }
    if (ids.has(c.id)) err(`${where}: duplicate id`);
    ids.add(c.id);
    if (typeof c.title !== 'string' || c.title.trim().length < 8) err(`${where}: title too short`);
    if (!CATEGORIES.includes(c.category)) err(`${where}: category must be one of ${CATEGORIES.join(', ')}`);
    if (!STATUSES.includes(c.status)) err(`${where}: status must be one of ${STATUSES.join(', ')}`);
    if (!Array.isArray(c.criteria) || c.criteria.length === 0 || !c.criteria.every((x) => CRITERION_RE.test(x))) {
      err(`${where}: criteria must be a non-empty list of CCx.y / A1.y / C1.y`);
    }
    if (!Number.isInteger(c.frequencyDays) || c.frequencyDays < 1 || c.frequencyDays > 400) err(`${where}: frequencyDays must be an integer 1..400`);
    if (typeof c.ownerRole !== 'string' || !c.ownerRole.trim()) err(`${where}: ownerRole is required (a proposed role, not a person)`);
    if (c.owner !== undefined && c.owner !== null && (typeof c.owner !== 'string' || !c.owner.trim())) err(`${where}: owner must be null or a non-empty name`);
    if (typeof c.gap !== 'string' || c.gap.trim().length < 5) err(`${where}: gap is required (state what is missing or unverified)`);

    const impl = Array.isArray(c.implementation) ? c.implementation : null;
    if (!impl) err(`${where}: implementation must be an array`);
    for (const p of impl ?? []) {
      if (typeof p !== 'string' || p.startsWith('/') || p.includes('..')) err(`${where}: invalid path "${p}"`);
      else if (!exists(p)) err(`${where}: referenced file does not exist: ${p}`);
    }

    const collectors = Array.isArray(c.collectors) ? c.collectors : null;
    if (!collectors) err(`${where}: collectors must be an array (may be empty)`);
    for (const k of collectors ?? []) if (!isKnownCollector(k)) err(`${where}: unknown collector "${k}"`);

    if (c.status === 'met') {
      if (!impl || impl.length === 0) err(`${where}: "met" requires at least one implementation path`);
      const automated = (collectors ?? []).filter((k) => COLLECTORS[k]?.runsIn !== 'manual');
      if (automated.length === 0) err(`${where}: "met" requires at least one automated (non-manual) evidence collector`);
    }
    if (collectors && collectors.length === 0) warnings.push(`${where}: no evidence collector — evidence state will be "not applicable"; verify manually outside the repo`);
  }

  const claimKeys = new Set();
  for (const cl of reg.claims ?? []) {
    if (typeof cl?.key !== 'string' || !CLAIM_RE.test(cl.key)) { err(`claim ${cl?.key}: invalid key`); continue; }
    if (claimKeys.has(cl.key)) err(`claim ${cl.key}: duplicate key`);
    claimKeys.add(cl.key);
    if (!Array.isArray(cl.controlIds) || cl.controlIds.length === 0) err(`claim ${cl.key}: controlIds must be non-empty`);
    for (const id of cl.controlIds ?? []) if (!ids.has(id)) err(`claim ${cl.key}: unknown control ${id}`);
  }
  return { errors, warnings };
}

export const registryHash = (reg) => sha256Hex(stableStringify(reg));

const STATUS_LABEL = { met: '🟢 Met', partial: '🟡 Partial', missing: '🔴 Missing' };
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Deterministic Markdown (no timestamps) so `--check` can diff it. */
export function renderControlMap(reg) {
  const L = [];
  const counts = { met: 0, partial: 0, missing: 0 };
  for (const c of reg.controls) counts[c.status]++;

  L.push('# Vireek — SOC 2 Control Map (generated)');
  L.push('');
  L.push('> **DRAFT — generated from `docs/compliance/soc2/controls.json`. Do not edit by hand.**  ');
  L.push('> Regenerate with `node scripts/compliance/validate-controls.mjs --write`.  ');
  L.push('> **This is not a statement of compliance.** Vireek holds no SOC 2 report. "Met" means "implemented in the repository and an automated evidence collector exists" — it does not mean audited or operating effectively.');
  L.push('');
  L.push(`Registry version: \`${reg.registryVersion}\` · Basis date: \`${reg.basisDate ?? 'n/a'}\``);
  L.push('');
  L.push(`**Summary:** ${counts.met} Met · ${counts.partial} Partial · ${counts.missing} Missing · ${reg.controls.length} controls`);
  L.push('');
  L.push('Owners are **proposed roles**. No person has been assigned; management must name owners before an auditor engagement.');
  L.push('');

  for (const cat of CATEGORIES) {
    const rows = reg.controls.filter((c) => c.category === cat);
    if (rows.length === 0) continue;
    L.push(`## ${cat[0].toUpperCase()}${cat.slice(1)}`);
    L.push('');
    L.push('| ID | Criteria | Control | Status | Proposed owner | Repo evidence of implementation | Evidence collectors | Gap / unverified |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const c of rows) {
      const impl = c.implementation.length ? c.implementation.map((p) => `\`${p}\``).join('<br>') : '—';
      const col = c.collectors.length ? c.collectors.map((k) => `\`${k}\``).join('<br>') : '— (verify outside repo)';
      L.push(`| ${c.id} | ${c.criteria.join(', ')} | ${esc(c.title)} | ${STATUS_LABEL[c.status]} | ${esc(c.ownerRole)} | ${impl} | ${col} | ${esc(c.gap)} |`);
    }
    L.push('');
  }

  const covered = new Set(reg.controls.flatMap((c) => c.criteria));
  const unmapped = IN_SCOPE_CRITERIA.filter((x) => !covered.has(x));
  L.push('## Criteria with no mapped control yet');
  L.push('');
  L.push(unmapped.length ? unmapped.map((x) => `\`${x}\``).join(', ') : 'None.');
  L.push('');
  L.push('These are real gaps in this map, not omissions to hide: each needs a control, a policy decision, or a documented inherited-control statement.');
  L.push('');

  L.push('## Public claims and the controls that gate them');
  L.push('');
  L.push('A claim is shown as **evidenced** on the Trust Center only when *every* control below is `Met` **and** its latest evidence is fresh and not failing. Otherwise it stays **In progress**.');
  L.push('');
  L.push('| Claim key | Gating controls |');
  L.push('|---|---|');
  for (const cl of reg.claims ?? []) L.push(`| \`${cl.key}\` | ${cl.controlIds.map((i) => `\`${i}\``).join(', ')} |`);
  L.push('');
  return L.join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const reg = loadRegistry();
  const { errors, warnings } = validateRegistry(reg);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n✘ Control registry invalid (${errors.length} error(s)).`);
    process.exit(1);
  }
  const rendered = renderControlMap(reg) + '\n';
  const target = join(REPO_ROOT, CONTROL_MAP_PATH);
  if (args.has('--write')) {
    writeFileSync(target, rendered);
    console.log(`✔ wrote ${CONTROL_MAP_PATH}`);
  } else if (args.has('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== rendered) {
      console.error(`✘ ${CONTROL_MAP_PATH} is stale. Run: node scripts/compliance/validate-controls.mjs --write`);
      process.exit(1);
    }
  }
  console.log(`✔ Control registry valid — ${reg.controls.length} controls, ${(reg.claims ?? []).length} claims, ${warnings.length} warning(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
