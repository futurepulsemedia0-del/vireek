// Shared logic for code ownership: loads docs/governance/ownership-map.json (the single source of truth) and renders
// .github/CODEOWNERS and docs/governance/service-ownership.md from it. No dependencies; pure functions where possible.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

export const MAP_FILE = 'docs/governance/ownership-map.json';
export const CODEOWNERS_FILE = '.github/CODEOWNERS';
export const DOC_FILE = 'docs/governance/service-ownership.md';

const PLACEHOLDER = /^@(OWNER|BACKUP)_[A-Z0-9_]+$/;
const USER_OR_TEAM = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isPlaceholder = (owner) => PLACEHOLDER.test(owner);
export const isValidOwner = (owner) => USER_OR_TEAM.test(owner) || EMAIL.test(owner);

export function loadMap(file = MAP_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Structural validation. Returns a list of human-readable problems (empty = valid). */
export function validateMap(map) {
  const problems = [];
  if (!map || typeof map !== 'object') return ['ownership map is not an object'];
  const roles = map.roles && typeof map.roles === 'object' ? map.roles : {};
  if (!Object.keys(roles).length) problems.push('ownership map has no roles');
  for (const [name, r] of Object.entries(roles)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) problems.push(`role "${name}": name must be UPPER_SNAKE_CASE`);
    for (const k of ['title', 'primary', 'backup']) {
      if (typeof r?.[k] !== 'string' || !r[k].trim()) problems.push(`role "${name}": missing "${k}"`);
    }
    for (const k of ['primary', 'backup']) {
      const v = r?.[k];
      if (typeof v === 'string' && v.trim() && !isPlaceholder(v) && !isValidOwner(v)) {
        problems.push(`role "${name}": ${k} "${v}" is not a valid GitHub @user, @org/team or e-mail`);
      }
    }
  }
  const ids = new Set();
  const domains = Array.isArray(map.domains) ? map.domains : [];
  if (!domains.length) problems.push('ownership map has no domains');
  domains.forEach((d, i) => {
    const where = `domain #${i + 1} (${d?.id ?? '?'})`;
    if (!d?.id || !/^[a-z0-9-]+$/.test(d.id)) problems.push(`${where}: id must be lowercase kebab-case`);
    else if (ids.has(d.id)) problems.push(`${where}: duplicate id`);
    else ids.add(d.id);
    if (!d?.title || !d?.area) problems.push(`${where}: "title" and "area" are required`);
    if (!roles[d?.role]) problems.push(`${where}: unknown role "${d?.role}"`);
    if (!Array.isArray(d?.paths) || !d.paths.length) problems.push(`${where}: "paths" must be a non-empty array`);
    for (const p of d?.paths ?? []) {
      if (p !== '*' && !(typeof p === 'string' && p.startsWith('/') && !/\s/.test(p) && !p.includes('#'))) {
        problems.push(`${where}: pattern "${p}" must be "*" or start with "/" (no spaces, no "#")`);
      }
    }
  });
  if (domains.length && !domains.some((d) => d.paths?.includes('*'))) problems.push('no fallback domain with pattern "*"');
  return problems;
}

/** Subset of gitignore matching that CODEOWNERS uses: anchored paths, "*", "**", "?", trailing "/". */
export function patternToRegExp(pattern) {
  if (pattern === '*') return /^.*$/s;
  const body = pattern.replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** Flatten the map into ordered CODEOWNERS rules (order = precedence; the last match wins, as on GitHub). */
export function buildRules(map) {
  const rules = [];
  for (const d of map.domains) {
    const role = map.roles[d.role];
    const owners = [...new Set([role.primary, role.backup])];
    for (const pattern of d.paths) rules.push({ pattern, owners, domain: d.id, role: d.role, re: patternToRegExp(pattern) });
  }
  return rules;
}

/** Resolve the rule that owns a repo-relative POSIX path ("src/App.tsx"). */
export function resolveOwner(rules, relPath) {
  const p = `/${relPath.replace(/^\/+/, '')}`;
  let hit = null;
  for (const r of rules) if (r.re.test(p)) hit = r;
  return hit;
}

export function renderCodeowners(map) {
  const rules = buildRules(map);
  const width = Math.min(60, Math.max(...rules.map((r) => r.pattern.length)) + 2);
  const out = [
    '# CODEOWNERS - GENERATED FILE. Do not edit by hand.',
    '#',
    '# Source of truth: docs/governance/ownership-map.json   Overview: docs/governance/service-ownership.md',
    '# Regenerate with:  npm run owners:generate      Verify with:  npm run owners:check',
    '#',
    '# Last matching rule wins; one path pattern per line; every owner on a line is listed (primary first, then backup).',
    '# GitHub silently ignores owners that are invalid or lack write access, so a placeholder owner protects nothing.',
    '',
  ];
  let area = null;
  const domains = new Map(map.domains.map((d) => [d.id, d]));
  for (const r of rules) {
    const d = domains.get(r.domain);
    if (d.area !== area) { area = d.area; out.push(`# ${area}`); }
    out.push(`${r.pattern.padEnd(width)}${r.owners.join(' ')}`);
  }
  return `${out.join('\n')}\n`;
}

export function renderDoc(map) {
  const L = [];
  L.push('# Service ownership', '');
  L.push('> Generated from `docs/governance/ownership-map.json` by `npm run owners:generate`. Do not edit by hand.', '');
  L.push('Every area of the repository has a **primary** and a **backup** owner. `.github/CODEOWNERS` is generated from the same map,');
  L.push('so this document and the review rules cannot drift apart. Person-level accountability for operational areas (security, voice,');
  L.push('billing, integrations, support, compliance) lives in `docs/OWNERS.md`; keep the two consistent.', '');
  L.push('## How to fill in the owners', '');
  L.push('1. Edit the `primary` and `backup` values under `roles` in `docs/governance/ownership-map.json`. Use a GitHub user (`@alice`), a team (`@your-org/security`) or an e-mail address of a GitHub user.');
  L.push('   Every owner needs **write** access to the repository, otherwise GitHub ignores it. [VERIFY in your GitHub organization]');
  L.push('2. Run `npm run owners:generate` and commit the regenerated `.github/CODEOWNERS` and this file.');
  L.push('3. Run `npm run owners:check`. When no placeholder is left, set `"enforcePlaceholders": true` in the map so CI fails if one ever comes back.');
  L.push('4. Enable "Require review from Code Owners" in branch protection. [VERIFY in repository settings]', '');
  L.push('A role may use the same person as primary and backup only when `"allowSamePrimaryBackup": true` is set on that role (a deliberate, reviewed exception).', '');
  L.push('## Roles', '', '| Role | Responsibility | Primary | Backup |', '|---|---|---|---|');
  for (const [name, r] of Object.entries(map.roles)) L.push(`| \`${name}\` | ${r.title} | \`${r.primary}\` | \`${r.backup}\` |`);
  L.push('', '## Domains', '', '| Area | Domain | Role | Primary | Backup |', '|---|---|---|---|---|');
  for (const d of map.domains) {
    const r = map.roles[d.role];
    L.push(`| ${d.area} | ${d.title} | \`${d.role}\` | \`${r.primary}\` | \`${r.backup}\` |`);
  }
  L.push('', '## Path patterns per domain', '', 'Patterns follow CODEOWNERS rules: the **last** matching pattern wins, so later domains override earlier, broader ones.', '');
  for (const d of map.domains) {
    L.push(`### ${d.title}`, '', `Area: ${d.area} - role \`${d.role}\``, '');
    for (const p of d.paths) L.push(`- \`${p}\``);
    L.push('');
  }
  L.push('## Notes', '');
  L.push('- Migrations have one owner on purpose: every schema change gets the database owners\' review. Adding a feature team as a second owner on the same rule would let either approve alone, which weakens that gate.');
  L.push('- A new edge function that matches no group below falls into the core edge-function group (`/supabase/functions/`). `npm run owners:check` lists such functions so they can be classified.');
  L.push('- Where several owners are listed on one line, a review from any one of them satisfies Code Owners review. [VERIFY against GitHub documentation for your plan]');
  return `${L.join('\n')}\n`;
}

/** Walk the repo (relative POSIX paths), skipping heavy or generated directories. */
export function walk(root = '.', skip = new Set(['node_modules', '.git', 'dist', 'dist-home', 'coverage', 'playwright-report'])) {
  const files = [];
  const rec = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (skip.has(name)) continue;
      const rel = dir ? posix.join(dir.split(sep).join('/'), name) : name;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) rec(rel); else files.push(rel);
    }
  };
  rec('');
  return files;
}
