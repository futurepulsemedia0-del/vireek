// supabase/functions/_shared/compliance/evidenceCore.ts
//
// Pure logic for the SOC 2 evidence pipeline. No Deno / Node globals except Web Crypto,
// so it is imported by the edge function AND unit-tested with Vitest.
//
// scripts/compliance/lib.mjs is the CI-side twin; evidenceCore.test.ts asserts they stay in
// lock-step (same collector catalog, same canonical JSON, same scrubbing, same hash).

export const ENVELOPE_SCHEMA = 'vireek.evidence/v1';
export const RESULTS = ['collected', 'blocked', 'error'] as const;
export const OUTCOMES = ['pass', 'fail', 'info'] as const;
export type EvidenceResult = (typeof RESULTS)[number];
export type EvidenceOutcome = (typeof OUTCOMES)[number];
export type RunsIn = 'ci' | 'edge' | 'manual';

/** collector id -> where it executes. MUST equal COLLECTORS in scripts/compliance/lib.mjs. */
export const COLLECTORS: Readonly<Record<string, RunsIn>> = {
  'repo.docs': 'ci',
  'repo.security_txt': 'ci',
  'repo.change_config': 'ci',
  'repo.headers': 'ci',
  'repo.registry': 'ci',
  'repo.migrations': 'ci',
  'github.branch_protection': 'ci',
  'github.pull_requests': 'ci',
  'github.workflow_runs': 'ci',
  'github.code_scanning': 'ci',
  'github.dependabot': 'ci',
  'github.secret_scanning': 'ci',
  'supabase.rls_coverage': 'edge',
  'supabase.access_review': 'edge',
  'supabase.backups': 'edge',
  'supabase.restore_drills': 'edge',
  'supabase.audit_summary': 'edge',
  'supabase.slo': 'edge',
  'supabase.incidents': 'edge',
  'supabase.retention': 'edge',
  'manual.policy_approval': 'manual',
  'manual.training': 'manual',
  'manual.risk_assessment': 'manual',
  'manual.access_review_signoff': 'manual',
  'manual.tabletop': 'manual',
  'manual.vendor_review': 'manual',
  'manual.pentest': 'manual',
};

export const EDGE_COLLECTOR_IDS: readonly string[] = Object.keys(COLLECTORS).filter((k) => COLLECTORS[k] === 'edge');

export const MAX_SUMMARY_BYTES = 12_000;
export const MAX_DATA_BYTES = 2_000_000;
export const MAX_RECORDS_PER_REQUEST = 20;
export const MAX_AGE_DAYS = 400;
export const FUTURE_SKEW_MS = 5 * 60_000;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Envelope {
  schema: typeof ENVELOPE_SCHEMA;
  collector: string;
  collected_at: string;
  result: EvidenceResult;
  outcome: EvidenceOutcome;
  run_ref: string | null;
  summary: { [k: string]: Json };
  data: { [k: string]: Json };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deterministic JSON (sorted keys). Must match stableStringify in scripts/compliance/lib.mjs. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      if (typeof v === 'bigint') return v.toString();
      return v;
    }
    if (seen.has(v)) throw new Error('stableStringify: circular structure');
    seen.add(v);
    let out: unknown;
    if (Array.isArray(v)) out = v.map((x) => (x === undefined ? null : walk(x)));
    else {
      const o: Record<string, unknown> = {};
      const src = v as Record<string, unknown>;
      for (const k of Object.keys(src).sort()) {
        if (src[k] !== undefined) o[k] = walk(src[k]);
      }
      out = o;
    }
    seen.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

// Names that END like a credential are dropped. Anchored on purpose: counters such as `tokensActive` stay.
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential|cookie|hash)s?$/i;

export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => scrub(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrub(v);
    }
    return out as T;
  }
  return value;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Validates an incoming evidence envelope. Rejects (never repairs):
 *  - unknown collector, bad enums, malformed or out-of-window timestamps
 *  - a non-'collected' result that claims anything other than 'fail'
 *  - oversize summary/data
 *  - manual evidence without an attesting person and a document reference
 * `allowEdge` is false for HTTP ingest: Supabase-side collectors may only be produced by the
 * function itself, so a leaked ingest token cannot forge backup/RLS/access-review evidence.
 */
export function validateEnvelope(input: unknown, now: Date, allowEdge: boolean): Validated<Envelope> {
  if (!isPlainObject(input)) return { ok: false, reason: 'record is not an object' };
  if (input.schema !== ENVELOPE_SCHEMA) return { ok: false, reason: `schema must be ${ENVELOPE_SCHEMA}` };
  const collector = input.collector;
  if (typeof collector !== 'string' || !Object.prototype.hasOwnProperty.call(COLLECTORS, collector)) return { ok: false, reason: 'unknown collector' };
  if (COLLECTORS[collector] === 'edge' && !allowEdge) return { ok: false, reason: 'collector runs inside Supabase and cannot be ingested' };
  if (typeof input.result !== 'string' || !(RESULTS as readonly string[]).includes(input.result)) return { ok: false, reason: 'invalid result' };
  if (typeof input.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(input.outcome)) return { ok: false, reason: 'invalid outcome' };
  if (input.result !== 'collected' && input.outcome !== 'fail') return { ok: false, reason: 'a blocked/error record must have outcome "fail"' };

  if (typeof input.collected_at !== 'string') return { ok: false, reason: 'collected_at must be an ISO string' };
  const ts = new Date(input.collected_at);
  if (Number.isNaN(ts.getTime())) return { ok: false, reason: 'collected_at is not a valid date' };
  if (ts.getTime() > now.getTime() + FUTURE_SKEW_MS) return { ok: false, reason: 'collected_at is in the future' };
  if (ts.getTime() < now.getTime() - MAX_AGE_DAYS * 86_400_000) return { ok: false, reason: `collected_at older than ${MAX_AGE_DAYS} days` };

  const runRef = input.run_ref;
  if (runRef !== null && runRef !== undefined && (typeof runRef !== 'string' || runRef.length > 300)) return { ok: false, reason: 'run_ref must be a string up to 300 chars' };
  if (!isPlainObject(input.summary)) return { ok: false, reason: 'summary must be an object' };
  if (!isPlainObject(input.data)) return { ok: false, reason: 'data must be an object' };

  const summary = scrub(input.summary) as { [k: string]: Json };
  const data = scrub(input.data) as { [k: string]: Json };
  if (byteLength(stableStringify(summary)) > MAX_SUMMARY_BYTES) return { ok: false, reason: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` };
  if (byteLength(stableStringify(data)) > MAX_DATA_BYTES) return { ok: false, reason: `data exceeds ${MAX_DATA_BYTES} bytes` };

  if (COLLECTORS[collector] === 'manual') {
    const who = summary.attestedBy;
    const ref = summary.documentRef;
    if (typeof who !== 'string' || who.trim().length < 3) return { ok: false, reason: 'manual evidence requires summary.attestedBy' };
    if (typeof ref !== 'string' || ref.trim().length < 3) return { ok: false, reason: 'manual evidence requires summary.documentRef' };
  }

  return {
    ok: true,
    value: {
      schema: ENVELOPE_SCHEMA,
      collector,
      collected_at: ts.toISOString(),
      result: input.result as EvidenceResult,
      outcome: input.outcome as EvidenceOutcome,
      run_ref: typeof runRef === 'string' ? runRef : null,
      summary,
      data,
    },
  };
}

// ----------------------------------------------------------------------------- registry payload

export interface ControlDef {
  id: string;
  criteria: string[];
  category: 'security' | 'availability' | 'confidentiality';
  title: string;
  status: 'met' | 'partial' | 'missing';
  ownerRole: string;
  owner: string | null;
  frequencyDays: number;
  collectors: string[];
  implementation: string[];
  gap: string;
}
export interface ClaimDef {
  key: string;
  controlIds: string[];
}
export interface RegistryPayload {
  registryVersion: string;
  controls: ControlDef[];
  claims: ClaimDef[];
}

const ID_RE = /^[A-Z]{3}-\d{2}$/;
const CRITERION_RE = /^(CC\d\.\d|A1\.\d|C1\.\d)$/;
const CLAIM_RE = /^[a-z][a-z0-9_]{2,60}$/;
const str = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const strArr = (v: unknown, maxItems: number, maxLen: number): v is string[] => Array.isArray(v) && v.length <= maxItems && v.every((x) => str(x, 1, maxLen));

/** Server-side re-validation of the registry pushed from CI (the server never trusts the client). */
export function validateRegistryPayload(input: unknown): Validated<RegistryPayload> | { ok: false; reason: string; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, reason: 'registry is not an object', errors: ['registry is not an object'] };
  if (!str(input.registryVersion, 1, 40)) errors.push('registryVersion invalid');
  if (!Array.isArray(input.controls) || input.controls.length === 0 || input.controls.length > 200) errors.push('controls must be a non-empty array (max 200)');
  const controls: ControlDef[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(input.controls) ? input.controls : []) {
    if (!isPlainObject(raw)) {
      errors.push('control is not an object');
      continue;
    }
    const id = raw.id;
    if (!str(id, 6, 6) || !ID_RE.test(id)) {
      errors.push(`invalid control id ${String(id)}`);
      continue;
    }
    if (ids.has(id)) errors.push(`${id}: duplicate`);
    ids.add(id);
    const where = id;
    if (!strArr(raw.criteria, 12, 8) || raw.criteria.length === 0 || !raw.criteria.every((c) => CRITERION_RE.test(c))) errors.push(`${where}: criteria invalid`);
    if (raw.category !== 'security' && raw.category !== 'availability' && raw.category !== 'confidentiality') errors.push(`${where}: category invalid`);
    if (raw.status !== 'met' && raw.status !== 'partial' && raw.status !== 'missing') errors.push(`${where}: status invalid`);
    if (!str(raw.title, 8, 300)) errors.push(`${where}: title invalid`);
    if (!str(raw.ownerRole, 3, 200)) errors.push(`${where}: ownerRole invalid`);
    if (raw.owner !== undefined && raw.owner !== null && !str(raw.owner, 2, 200)) errors.push(`${where}: owner invalid`);
    if (!Number.isInteger(raw.frequencyDays) || (raw.frequencyDays as number) < 1 || (raw.frequencyDays as number) > 400) errors.push(`${where}: frequencyDays invalid`);
    if (!strArr(raw.collectors, 12, 60) || !raw.collectors.every((c) => Object.prototype.hasOwnProperty.call(COLLECTORS, c))) errors.push(`${where}: collectors invalid or unknown`);
    if (!strArr(raw.implementation, 30, 300)) errors.push(`${where}: implementation invalid`);
    if (!str(raw.gap, 5, 2000)) errors.push(`${where}: gap invalid`);
    if (raw.status === 'met' && strArr(raw.collectors, 12, 60) && !raw.collectors.some((c) => COLLECTORS[c] !== 'manual')) errors.push(`${where}: "met" needs an automated collector`);
    if (errors.length === 0) {
      controls.push({
        id,
        criteria: raw.criteria as string[],
        category: raw.category as ControlDef['category'],
        title: raw.title as string,
        status: raw.status as ControlDef['status'],
        ownerRole: raw.ownerRole as string,
        owner: typeof raw.owner === 'string' ? raw.owner : null,
        frequencyDays: raw.frequencyDays as number,
        collectors: raw.collectors as string[],
        implementation: raw.implementation as string[],
        gap: raw.gap as string,
      });
    }
  }
  const claims: ClaimDef[] = [];
  const claimKeys = new Set<string>();
  for (const raw of Array.isArray(input.claims) ? input.claims : []) {
    if (!isPlainObject(raw) || !str(raw.key, 3, 61) || !CLAIM_RE.test(raw.key)) {
      errors.push('claim key invalid');
      continue;
    }
    if (claimKeys.has(raw.key)) errors.push(`claim ${raw.key}: duplicate`);
    claimKeys.add(raw.key);
    if (!strArr(raw.controlIds, 12, 6) || raw.controlIds.length === 0 || !raw.controlIds.every((c) => ids.has(c))) errors.push(`claim ${raw.key}: controlIds invalid`);
    else claims.push({ key: raw.key, controlIds: raw.controlIds });
  }
  if (errors.length) return { ok: false, reason: errors[0], errors };
  return { ok: true, value: { registryVersion: input.registryVersion as string, controls, claims } };
}

/** Storage path for an evidence payload. Deterministic so a retried upload hits the same object. */
export function evidencePath(collector: string, collectedAt: string, sha256: string): string {
  const d = new Date(collectedAt);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const stamp = collectedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `${yyyy}/${mm}/${collector}/${stamp}-${sha256.slice(0, 12)}.json`;
}

/** Constant-time string comparison via digests (length-independent). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && a.length === b.length;
}
