// scripts/compliance/collect-repo.mjs
//
// Evidence collectors that read ONLY the checked-out repository (no network,
// no credentials). Each function returns one evidence envelope.
//
// What this proves: the state of files at the commit that was checked out.
// What it does not prove: that the same configuration is live in production.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnvelope, sha256Hex, blockedEnvelope, errorEnvelope } from './lib.mjs';
import { loadRegistry, validateRegistry, registryHash } from './validate-controls.mjs';

const read = (root, p) => readFileSync(join(root, p), 'utf8');
const has = (root, p) => existsSync(join(root, p));

/** security.txt "Expires:" parser. Returns a Date or null. */
export function parseSecurityTxtExpiry(text) {
  const m = /^\s*Expires:\s*(.+?)\s*$/im.exec(text);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function collectSecurityTxt({ root, now = new Date(), ...rest }) {
  const path = 'public/.well-known/security.txt';
  if (!has(root, path)) {
    return makeEnvelope({ collector: 'repo.security_txt', result: 'collected', outcome: 'fail', summary: { present: false }, data: {}, collectedAt: now, ...rest });
  }
  const text = read(root, path);
  const expires = parseSecurityTxtExpiry(text);
  const daysLeft = expires ? Math.floor((expires.getTime() - now.getTime()) / 86_400_000) : null;
  const hasContact = /^\s*Contact:\s*\S+/im.test(text);
  const ok = Boolean(expires) && daysLeft > 30 && hasContact;
  return makeEnvelope({
    collector: 'repo.security_txt',
    result: 'collected',
    outcome: ok ? 'pass' : 'fail',
    summary: { present: true, hasContact, expires: expires?.toISOString() ?? null, daysUntilExpiry: daysLeft, renewalWindowDays: 30 },
    data: { sha256: sha256Hex(text) },
    collectedAt: now,
    ...rest,
  });
}

/** Required headers mirror .github/workflows/vercel-preview-smoke.yml. */
export const REQUIRED_HEADERS = ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'content-security-policy'];

export function collectHeaders({ root, now = new Date(), ...rest }) {
  if (!has(root, 'vercel.json')) {
    return makeEnvelope({ collector: 'repo.headers', result: 'collected', outcome: 'fail', summary: { present: false }, collectedAt: now, ...rest });
  }
  const raw = read(root, 'vercel.json');
  const cfg = JSON.parse(raw);
  const found = new Set();
  for (const rule of cfg.headers ?? []) {
    for (const h of rule.headers ?? []) found.add(String(h.key).toLowerCase());
  }
  const missing = REQUIRED_HEADERS.filter((h) => !found.has(h));
  return makeEnvelope({
    collector: 'repo.headers',
    result: 'collected',
    outcome: missing.length === 0 ? 'pass' : 'fail',
    summary: { required: REQUIRED_HEADERS.length, missing },
    data: { sha256: sha256Hex(raw), configured: [...found].sort() },
    collectedAt: now,
    ...rest,
  });
}

export function collectChangeConfig({ root, now = new Date(), ...rest }) {
  const codeowners = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((p) => has(root, p)) ?? null;
  const prTemplate =
    ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'docs/pull_request_template.md'].find((p) => has(root, p)) ??
    (has(root, '.github/PULL_REQUEST_TEMPLATE') ? '.github/PULL_REQUEST_TEMPLATE/' : null);
  const wfDir = '.github/workflows';
  const workflows = has(root, wfDir)
    ? readdirSync(join(root, wfDir))
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()
        .map((f) => ({ file: f, sha256: sha256Hex(read(root, `${wfDir}/${f}`)) }))
    : [];
  const dependabot = has(root, '.github/dependabot.yml') ? sha256Hex(read(root, '.github/dependabot.yml')) : null;
  const gitleaks = has(root, '.gitleaks.toml') ? sha256Hex(read(root, '.gitleaks.toml')) : null;
  const ok = Boolean(codeowners && prTemplate);
  return makeEnvelope({
    collector: 'repo.change_config',
    result: 'collected',
    outcome: ok ? 'pass' : 'fail',
    summary: { codeowners, prTemplate, workflowCount: workflows.length, dependabotConfigured: Boolean(dependabot), gitleaksConfigured: Boolean(gitleaks) },
    data: { workflows, dependabotSha256: dependabot, gitleaksSha256: gitleaks },
    collectedAt: now,
    ...rest,
  });
}

/** Reads the "Status:" line of each policy draft. Approval is a human act; this only reports what the file says. */
export function collectDocs({ root, now = new Date(), ...rest }) {
  const dir = 'docs/compliance/soc2/policies';
  const policies = has(root, dir)
    ? readdirSync(join(root, dir))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => {
          const text = read(root, `${dir}/${f}`);
          const status = /^\|\s*Status\s*\|\s*([^|]+?)\s*\|/im.exec(text)?.[1] ?? 'unknown';
          const approvedBy = /^\|\s*Approved by\s*\|\s*([^|]+?)\s*\|/im.exec(text)?.[1] ?? 'unknown';
          return { file: f, status, approvedBy, sha256: sha256Hex(text) };
        })
    : [];
  const docs = ['RUNBOOK.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'docs/compliance/SOC2_READINESS.md', 'docs/compliance/soc2/CONTROL_MAP.md'].map((p) => ({
    path: p,
    present: has(root, p),
    sha256: has(root, p) ? sha256Hex(read(root, p)) : null,
  }));
  const approved = policies.filter((p) => /^approved$/i.test(p.status)).length;
  return makeEnvelope({
    collector: 'repo.docs',
    result: 'collected',
    outcome: 'info',
    summary: { policyCount: policies.length, approved, draft: policies.length - approved },
    data: { policies, docs },
    collectedAt: now,
    ...rest,
  });
}

export function collectRegistry({ root, now = new Date(), ...rest }) {
  const reg = loadRegistry(root);
  const { errors, warnings } = validateRegistry(reg, { exists: (p) => has(root, p) });
  const counts = { met: 0, partial: 0, missing: 0 };
  for (const c of reg.controls) counts[c.status]++;
  return makeEnvelope({
    collector: 'repo.registry',
    result: 'collected',
    outcome: errors.length === 0 ? 'pass' : 'fail',
    summary: { registryVersion: reg.registryVersion, controls: reg.controls.length, ...counts, errors: errors.length, warnings: warnings.length },
    data: { registrySha256: registryHash(reg), errors, warnings },
    collectedAt: now,
    ...rest,
  });
}

export function collectMigrations({ root, now = new Date(), ...rest }) {
  const dir = 'supabase/migrations';
  if (!has(root, dir)) return blockedEnvelope('repo.migrations', 'supabase/migrations not found', { collectedAt: now, ...rest });
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.sql')).sort();
  const versions = new Map();
  for (const f of files) {
    const v = f.split('_')[0];
    versions.set(v, (versions.get(v) ?? 0) + 1);
  }
  const duplicates = [...versions].filter(([, n]) => n > 1).map(([v, n]) => ({ version: v, count: n }));
  return makeEnvelope({
    collector: 'repo.migrations',
    result: 'collected',
    outcome: 'info',
    summary: { migrations: files.length, duplicateVersions: duplicates.length, latest: files.at(-1) ?? null },
    data: { duplicates },
    collectedAt: now,
    ...rest,
  });
}

export const REPO_COLLECTORS = {
  'repo.docs': collectDocs,
  'repo.security_txt': collectSecurityTxt,
  'repo.change_config': collectChangeConfig,
  'repo.headers': collectHeaders,
  'repo.registry': collectRegistry,
  'repo.migrations': collectMigrations,
};

/** Runs every repo collector; one failure becomes an `error` envelope, never aborts the others. */
export function collectRepo(opts) {
  return Object.entries(REPO_COLLECTORS).map(([id, fn]) => {
    try {
      return fn(opts);
    } catch (e) {
      return errorEnvelope(id, e, { collectedAt: opts.now, runRef: opts.runRef });
    }
  });
}
