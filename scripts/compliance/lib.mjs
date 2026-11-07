// scripts/compliance/lib.mjs
//
// Shared helpers for the SOC 2 readiness evidence pipeline.
// Pure Node (no dependencies) so it runs in CI and in unit tests unchanged.
//
// An "evidence envelope" is one timestamped, hashable record produced by one
// collector. Envelopes never contain secrets: `scrub()` removes any key that
// looks like a credential before anything is hashed, written or uploaded.

import { createHash } from 'node:crypto';

export const ENVELOPE_SCHEMA = 'vireek.evidence/v1';

/** What happened when the collector ran. */
export const RESULTS = Object.freeze(['collected', 'blocked', 'error']);
/** What the evidence says about the control. 'info' = recorded, not judged. */
export const OUTCOMES = Object.freeze(['pass', 'fail', 'info']);

/**
 * Every collector the pipeline knows. `runsIn` says where it executes:
 *  - ci:      scripts in this folder, run by .github/workflows/compliance-evidence.yml
 *  - edge:    supabase/functions/compliance-evidence (service-role stays inside Supabase)
 *  - manual:  a human attests; the pipeline only records pointer + SHA-256 of the document
 * Keep in sync with supabase/functions/compliance-evidence/index.ts (a unit test enforces it).
 */
export const COLLECTORS = Object.freeze({
  'repo.docs': { runsIn: 'ci', title: 'Compliance documents present, with approval status' },
  'repo.security_txt': { runsIn: 'ci', title: 'security.txt exists and is not (nearly) expired' },
  'repo.change_config': { runsIn: 'ci', title: 'CODEOWNERS, PR template and workflow definitions' },
  'repo.headers': { runsIn: 'ci', title: 'Security headers configured in vercel.json' },
  'repo.registry': { runsIn: 'ci', title: 'Control registry validates and its hash' },
  'repo.migrations': { runsIn: 'ci', title: 'Migration inventory and duplicate versions' },
  'github.branch_protection': { runsIn: 'ci', title: 'Branch protection / rulesets on the default branch' },
  'github.pull_requests': { runsIn: 'ci', title: 'Merged PRs, independent approvals, commits without a PR' },
  'github.workflow_runs': { runsIn: 'ci', title: 'CI / security workflow results' },
  'github.code_scanning': { runsIn: 'ci', title: 'Open CodeQL alerts by severity and age' },
  'github.dependabot': { runsIn: 'ci', title: 'Open Dependabot alerts by severity and age' },
  'github.secret_scanning': { runsIn: 'ci', title: 'Open secret-scanning alerts (never stores the secret)' },
  'supabase.rls_coverage': { runsIn: 'edge', title: 'RLS coverage, permissive policies, anon-executable functions' },
  'supabase.access_review': { runsIn: 'edge', title: 'Staff accounts, MFA enrolment, SCIM tokens, role counts' },
  'supabase.backups': { runsIn: 'edge', title: 'Logical backup runs (platform_backup_runs)' },
  'supabase.restore_drills': { runsIn: 'edge', title: 'Restore drills and measured RTO (platform_restore_drills)' },
  'supabase.audit_summary': { runsIn: 'edge', title: 'Audit-log volume by action (no content)' },
  'supabase.slo': { runsIn: 'edge', title: 'Synthetic probes, SLO definitions, answer latency' },
  'supabase.incidents': { runsIn: 'edge', title: 'Status and SLA incidents with durations' },
  'supabase.retention': { runsIn: 'edge', title: 'Retention policies, legal holds, erasure requests' },
  'manual.policy_approval': { runsIn: 'manual', title: 'Management approval of a policy (pointer + hash)' },
  'manual.training': { runsIn: 'manual', title: 'Security-awareness training records (pointer + hash)' },
  'manual.risk_assessment': { runsIn: 'manual', title: 'Risk assessment / register review (pointer + hash)' },
  'manual.access_review_signoff': { runsIn: 'manual', title: 'Signed access review (pointer + hash)' },
  'manual.tabletop': { runsIn: 'manual', title: 'Incident-response exercise record (pointer + hash)' },
  'manual.vendor_review': { runsIn: 'manual', title: 'Vendor review / attestation collected (pointer + hash)' },
  'manual.pentest': { runsIn: 'manual', title: 'Penetration test report (pointer + hash)' },
});

export const isKnownCollector = (id) => Object.prototype.hasOwnProperty.call(COLLECTORS, id);

/** Deterministic JSON: object keys sorted, no whitespace. Same value => same bytes => same hash. */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      if (typeof v === 'bigint') return v.toString();
      return v;
    }
    if (seen.has(v)) throw new Error('stableStringify: circular structure');
    seen.add(v);
    let out;
    if (Array.isArray(v)) out = v.map((x) => (x === undefined ? null : walk(x)));
    else {
      out = {};
      for (const k of Object.keys(v).sort()) {
        if (v[k] !== undefined) out[k] = walk(v[k]);
      }
    }
    seen.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

export const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');

// Matches property NAMES that end like a credential (access_token, apiKey, token_hash, password...).
// Deliberately anchored at the end so counters such as `tokensActive` or `secretType` are kept.
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential|cookie|hash)s?$/i;

/**
 * Defence in depth: drop every property whose NAME looks like a credential.
 * Collectors should never read such fields in the first place; this guarantees
 * a future mistake cannot leak one into evidence storage.
 */
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/**
 * Build a validated evidence envelope. Throws on invalid input so a buggy
 * collector fails loudly instead of uploading junk.
 */
export function makeEnvelope({ collector, result, outcome, summary, data, runRef, collectedAt }) {
  if (!isKnownCollector(collector)) throw new Error(`unknown collector "${collector}"`);
  if (!RESULTS.includes(result)) throw new Error(`invalid result "${result}"`);
  if (!OUTCOMES.includes(outcome)) throw new Error(`invalid outcome "${outcome}"`);
  const ts = collectedAt instanceof Date ? collectedAt : new Date(collectedAt ?? Date.now());
  if (Number.isNaN(ts.getTime())) throw new Error('invalid collectedAt');
  const env = {
    schema: ENVELOPE_SCHEMA,
    collector,
    collected_at: ts.toISOString(),
    result,
    // A run that did not produce data can never be a "pass".
    outcome: result === 'collected' ? outcome : 'fail',
    run_ref: runRef ? String(runRef).slice(0, 300) : null,
    summary: scrub(summary ?? {}),
    data: scrub(data ?? {}),
  };
  return env;
}

/** Envelope for a collector that could not run (missing token, 403, ...). Never counts as a pass. */
export const blockedEnvelope = (collector, reason, extra = {}) =>
  makeEnvelope({
    collector,
    result: 'blocked',
    outcome: 'fail',
    summary: { reason, ...extra },
    data: {},
    runRef: extra.runRef,
    collectedAt: extra.collectedAt,
  });

export const errorEnvelope = (collector, err, extra = {}) =>
  makeEnvelope({
    collector,
    result: 'error',
    outcome: 'fail',
    summary: { reason: String(err instanceof Error ? err.message : err).slice(0, 500) },
    data: {},
    runRef: extra.runRef,
    collectedAt: extra.collectedAt,
  });

/** Hash of the canonical envelope — what the server recomputes and de-duplicates on. */
export const envelopeHash = (envelope) => sha256Hex(stableStringify(envelope));

export const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

/** Proposed remediation SLAs (days) — mirror of docs/compliance/soc2/policies/08-sdlc-vulnerability-management-policy.md. DRAFT values. */
export const PROPOSED_VULN_SLA_DAYS = Object.freeze({ critical: 7, high: 30, medium: 90, low: 180 });
