#!/usr/bin/env node
// scripts/governance/add-runbook-frontmatter.mjs
//
// One-shot, idempotent codemod: adds the ownership frontmatter to docs/runbooks/*.md and docs/security/*.md.
//
//   node scripts/governance/add-runbook-frontmatter.mjs            dry run (prints what would change)
//   node scripts/governance/add-runbook-frontmatter.mjs --write    apply
//
// Rules it follows on purpose:
//   - owner is ALWAYS "TBD": nobody has been assigned. A person must fill it in.
//   - testable kinds get last_tested: never and next_test: TBD. It never writes a test date.
//   - kind and area come from the table below. They are a first classification made from file names and titles;
//     the owner should confirm them. `area` maps to the rows of docs/OWNERS.md.
//   - files that already start with frontmatter are left untouched; generated files are skipped.
//   - the body is not modified, only the block is prepended.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED, REPO_ROOT, parseFrontmatter } from './check-runbooks.mjs';

/** file -> [kind, area]. kind: runbook | playbook | reference | template | log */
export const CLASSIFICATION = Object.freeze({
  'docs/runbooks/agent-runtime.md': ['runbook', 'unassigned'],
  'docs/runbooks/database-outage.md': ['runbook', 'unassigned'],
  'docs/runbooks/demo-account-audit.md': ['runbook', 'security'],
  'docs/runbooks/incident-response.md': ['runbook', 'support'],
  'docs/runbooks/migration-version-repair.md': ['runbook', 'unassigned'],
  'docs/runbooks/migration-versioning.md': ['runbook', 'unassigned'],
  'docs/runbooks/model-change.md': ['runbook', 'unassigned'],
  'docs/runbooks/post-incident-template.md': ['template', 'support'],
  'docs/runbooks/provider-credentials-migration.md': ['runbook', 'security'],
  'docs/runbooks/restore-drill-log.md': ['log', 'unassigned'],
  'docs/runbooks/secret-rotation.md': ['runbook', 'security'],
  'docs/runbooks/synthetic-monitoring.md': ['runbook', 'voice'],
  'docs/runbooks/vireek-insights-privacy-review.md': ['runbook', 'compliance'],
  'docs/runbooks/voice-first-staging-drill.md': ['runbook', 'voice'],
  'docs/runbooks/voice-fmea.md': ['reference', 'voice'],
  'docs/runbooks/voice-observability.md': ['reference', 'voice'],
  'docs/runbooks/voice-provider-outage.md': ['runbook', 'voice'],
  'docs/runbooks/voice-resilience.md': ['runbook', 'voice'],
  'docs/security/FRAUD_ABUSE_PREVENTION.md': ['reference', 'security'],
  'docs/security/RLS_EXCEPTIONS.md': ['reference', 'security'],
  'docs/security/THREAT_MODEL.md': ['reference', 'security'],
  'docs/security/identity-authz-audit.md': ['reference', 'security'],
  'docs/security/maker-checker.md': ['reference', 'security'],
  'docs/security/partner-security-questionnaire.md': ['reference', 'security'],
  'docs/security/permissive-policies.md': ['reference', 'security'],
  'docs/security/public-endpoints.md': ['reference', 'security'],
  'docs/security/rls-initplan-wrap.md': ['reference', 'security'],
  'docs/security/staff-impersonate-grant-gate.md': ['reference', 'security'],
  'docs/security/staff-impersonation-limits.md': ['reference', 'security'],
  'docs/security/supply-chain.md': ['reference', 'security'],
  'docs/security/voice-incident-response.md': ['runbook', 'voice'],
  'docs/security/voice-redteam-playbook.md': ['playbook', 'voice'],
  'docs/security/voice-redteam-quarterly-template.md': ['template', 'voice'],
  'docs/security/voice-security-report.md': ['reference', 'voice'],
  'docs/security/voice-threat-model.md': ['reference', 'voice'],
});

export function buildBlock(kind, area) {
  const testable = kind === 'runbook' || kind === 'playbook';
  return [
    '---',
    'owner: TBD',
    `kind: ${kind}`,
    `area: ${area}`,
    `last_tested: ${testable ? 'never' : 'n/a'}`,
    `next_test: ${testable ? 'TBD' : 'n/a'}`,
    '---',
    '',
  ].join('\n');
}

function main() {
  const write = process.argv.includes('--write');
  let changed = 0, skipped = 0, missing = 0;
  for (const [file, [kind, area]] of Object.entries(CLASSIFICATION)) {
    if (GENERATED.includes(file)) continue;
    const abs = join(REPO_ROOT, file);
    if (!existsSync(abs)) { console.log(`MISSING  ${file} (not in this checkout; skipped)`); missing++; continue; }
    const text = readFileSync(abs, 'utf8');
    if (parseFrontmatter(text).data !== null || text.replace(/^\uFEFF/, '').startsWith('---')) { console.log(`SKIP     ${file} (already has frontmatter)`); skipped++; continue; }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = buildBlock(kind, area).replace(/\n/g, eol);
    if (write) writeFileSync(abs, block + text);
    console.log(`${write ? 'UPDATED ' : 'WOULD   '} ${file}  kind=${kind} area=${area}`);
    changed++;
  }
  console.log(`\n${write ? 'Updated' : 'Would update'} ${changed}, skipped ${skipped}, missing ${missing}.${write ? '' : ' Re-run with --write to apply.'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
