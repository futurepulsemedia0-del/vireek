// supabase/functions/_shared/compliance/erasureCertificate.ts
//
// Deletion certificate for a completed full-account erasure job.
//
// What it is: a signed, canonical JSON record of what the erasure job actually did (systems and
// subprocessors from docs/compliance/erasure-coverage-baseline.json -> `certificate`), the backup
// expiry date, and a SHA-256 over the canonical payload that is stored separately for later checks.
//
// What it is not: a legal attestation or a third-party certification. Wording of `notice` is
// [COUNSEL] and must be reviewed before the certificate is shown to customers as a compliance document.
//
// Signature: HMAC-SHA256 (symmetric). Only Vireek can verify it, by design: a public-key signature
// (ES256/Ed25519) would be verifiable by anyone but is a quantum-vulnerable primitive
// (docs/security/crypto-inventory.md). Switching is a deliberate decision, not a default.
//
// Pure and dependency-injected: no I/O, no Date.now(), no env. WebCrypto only (Deno + Node 20+).

import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "../audit/crypto.ts";

export const CERTIFICATE_TYPE = "vireek.erasure-certificate" as const;
export const CERTIFICATE_SCHEMA_VERSION = 1 as const;
export const SIGNATURE_ALGORITHM = "HMAC-SHA256" as const;
export const HASH_ALGORITHM = "SHA-256" as const;
const SIGNING_DOMAIN = "vireek-erasure-cert-v1\n";
export const MIN_SIGNING_KEY_LENGTH = 32;
const MAX_BACKUP_RETENTION_DAYS = 3650;

export const CERTIFICATE_NOTICE =
  "This record states the outcome of Vireek's automated erasure job as of the completion time shown. " +
  "It is a technical record. It is not legal advice and it is not a certification by an independent third party.";

/* ------------------------------------------------------------------ baseline types */

export interface BaselineSystem {
  id: string;
  name: string;
  scope?: string;
  automated: boolean;
  evidenceKey?: string;
  method?: string;
  gap?: string;
}

export interface ErasureBaseline {
  certificate: { schemaVersion: number; systems: BaselineSystem[]; subprocessors: BaselineSystem[] };
  uncovered: string[];
}

/* ------------------------------------------------------------------ evidence (captured by the job) */

export interface ErasureEvidence {
  /** table -> rows deleted. */
  ownedTables?: Record<string, number>;
  /** erase_user_rows() result. */
  catalogErase?: { deleted?: Record<string, number>; blocked?: Record<string, string> };
  trustPack?: { ok: boolean };
  provider?: {
    ok: boolean;
    skipped: string[];
    failed: string[];
    erased: { elevenlabsVoices: number; vapiCalls: number };
  };
}

export type EntryOutcome = "erased" | "not_applicable" | "skipped_no_credential" | "failed" | "not_automated" | "no_evidence";

export interface CertificateEntry {
  id: string;
  name: string;
  scope?: string;
  method?: string;
  outcome: EntryOutcome;
  /** Rows / objects removed, when the job reported a count. */
  removed?: number;
  note?: string;
}

export interface BackupSection {
  retentionDays: number | null;
  expiresAt: string | null;
  basis: string;
  status: "scheduled" | "unverified";
  note: string;
}

export interface CertificatePayload {
  type: typeof CERTIFICATE_TYPE;
  schemaVersion: typeof CERTIFICATE_SCHEMA_VERSION;
  certificateNumber: string;
  issuedAt: string;
  subject: { accountId: string; deletionRequestId: string; requestType: "full_account" };
  timeline: { requestedAt: string; scheduledFor: string; completedAt: string };
  status: "completed" | "completed_with_exceptions";
  systems: CertificateEntry[];
  subprocessors: CertificateEntry[];
  limitations: { id: string; name: string; gap: string }[];
  backup: BackupSection;
  coverageBaseline: { source: string; sha256: string; acceptedUncoveredTables: number };
  notice: string;
}

export interface IntegrityBlock {
  hashAlgorithm: typeof HASH_ALGORITHM;
  sha256: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  keyId: string;
  signature: string;
}

export type SignedCertificate = CertificatePayload & { integrity: IntegrityBlock };

export interface BuildInput {
  deletionRequestId: string;
  accountId: string;
  requestedAt: string;
  scheduledFor: string;
  completedAt: string;
  evidence: ErasureEvidence;
  baseline: ErasureBaseline;
  /** From configuration. null/undefined => backup expiry is reported as unverified, never guessed. */
  backupRetentionDays?: number | null;
  now: Date;
}

/* ------------------------------------------------------------------ canonical JSON */

/**
 * Deterministic JSON: object keys sorted (code-point order), no whitespace, arrays keep order.
 * Throws on undefined, functions, symbols, bigint and non-finite numbers: a certificate must never
 * silently drop or coerce a value.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof value}`);
  }
}

/* ------------------------------------------------------------------ helpers */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function iso(label: string, v: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`invalid timestamp: ${label}`);
  return new Date(t).toISOString();
}

const sum = (o?: Record<string, number>) => Object.values(o ?? {}).reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);

/** Deterministic, idempotent per deletion request: re-issuing never yields a second number. */
export async function certificateNumberFor(deletionRequestId: string): Promise<string> {
  return `VRK-ERC-${(await sha256Hex(`erasure-cert|${deletionRequestId}`)).slice(0, 12).toUpperCase()}`;
}

export function computeBackupExpiry(completedAtIso: string, retentionDays: number | null | undefined): BackupSection {
  const valid = typeof retentionDays === "number" && Number.isInteger(retentionDays) && retentionDays > 0 && retentionDays <= MAX_BACKUP_RETENTION_DAYS;
  if (!valid) {
    return {
      retentionDays: null,
      expiresAt: null,
      basis: "completedAt + backup retention",
      status: "unverified",
      note: "Backup retention is not configured for this deployment, so no expiry date is stated. [VERIFY]",
    };
  }
  const expires = new Date(Date.parse(completedAtIso) + (retentionDays as number) * 86_400_000).toISOString();
  return {
    retentionDays: retentionDays as number,
    expiresAt: expires,
    basis: "completedAt + backup retention",
    status: "scheduled",
    note: "Backups taken before completion may still hold this account's data until this date, then age out. They are not erased individually.",
  };
}

/* ------------------------------------------------------------------ entry outcomes */

function classifyEntry(s: BaselineSystem, ev: ErasureEvidence): CertificateEntry {
  const base: CertificateEntry = { id: s.id, name: s.name, ...(s.scope ? { scope: s.scope } : {}), ...(s.method ? { method: s.method } : {}), outcome: "no_evidence" };
  if (!s.automated) return { ...base, outcome: "not_automated" };

  switch (s.evidenceKey) {
    case "ownedTables":
      return ev.ownedTables ? { ...base, outcome: "erased", removed: sum(ev.ownedTables) } : base;
    case "catalogErase": {
      if (!ev.catalogErase) return base;
      const blocked = Object.keys(ev.catalogErase.blocked ?? {}).length;
      return blocked > 0
        ? { ...base, outcome: "failed", note: `${blocked} table(s) could not be erased.` }
        : { ...base, outcome: "erased", removed: sum(ev.catalogErase.deleted) };
    }
    case "trustPack":
      if (!ev.trustPack) return base;
      return ev.trustPack.ok ? { ...base, outcome: "erased" } : { ...base, outcome: "failed" };
    case "elevenlabs": {
      const p = ev.provider;
      if (!p) return base;
      if (p.failed.includes("elevenlabs")) return { ...base, outcome: "failed" };
      if (p.skipped.includes("elevenlabs:no_key")) return { ...base, outcome: "skipped_no_credential", note: "No provider credential was configured when the job ran." };
      return p.erased.elevenlabsVoices > 0 ? { ...base, outcome: "erased", removed: p.erased.elevenlabsVoices } : { ...base, outcome: "not_applicable", note: "No voice clone was on record." };
    }
    case "vapi": {
      const p = ev.provider;
      if (!p) return base;
      const failed = p.failed.filter((f) => f.startsWith("vapi:")).length;
      if (failed > 0) return { ...base, outcome: "failed", removed: p.erased.vapiCalls, note: `${failed} call record(s) could not be removed.` };
      if (p.skipped.includes("vapi:no_key")) return { ...base, outcome: "skipped_no_credential", note: "No provider credential was configured when the job ran." };
      return p.erased.vapiCalls > 0 ? { ...base, outcome: "erased", removed: p.erased.vapiCalls } : { ...base, outcome: "not_applicable", note: "No call records were on record." };
    }
    default:
      return base;
  }
}

/* ------------------------------------------------------------------ build / sign / verify */

export async function baselineDigest(baseline: ErasureBaseline): Promise<string> {
  return sha256Hex(canonicalize(baseline));
}

export async function buildCertificatePayload(input: BuildInput): Promise<CertificatePayload> {
  if (!isUuid(input.deletionRequestId)) throw new Error("deletionRequestId must be a uuid");
  if (!isUuid(input.accountId)) throw new Error("accountId must be a uuid");
  const sections = input.baseline?.certificate;
  if (!sections || !Array.isArray(sections.systems) || !Array.isArray(sections.subprocessors)) throw new Error("baseline.certificate is missing");
  if (!Array.isArray(input.baseline.uncovered)) throw new Error("baseline.uncovered is missing");

  const completedAt = iso("completedAt", input.completedAt);
  const entries = (list: BaselineSystem[]) => list.filter((s) => s.automated).map((s) => classifyEntry(s, input.evidence));
  const systems = entries(sections.systems);
  const subprocessors = entries(sections.subprocessors);

  const bad = (e: CertificateEntry) => e.outcome === "failed" || e.outcome === "skipped_no_credential" || e.outcome === "no_evidence";
  const status = [...systems, ...subprocessors].some(bad) ? "completed_with_exceptions" : "completed";

  const limitations = [...sections.systems, ...sections.subprocessors]
    .filter((s) => !s.automated)
    .map((s) => ({ id: s.id, name: s.name, gap: s.gap ?? "Not covered by the automated erasure job." }));

  return {
    type: CERTIFICATE_TYPE,
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    certificateNumber: await certificateNumberFor(input.deletionRequestId),
    issuedAt: input.now.toISOString(),
    subject: { accountId: input.accountId, deletionRequestId: input.deletionRequestId, requestType: "full_account" },
    timeline: { requestedAt: iso("requestedAt", input.requestedAt), scheduledFor: iso("scheduledFor", input.scheduledFor), completedAt },
    status,
    systems,
    subprocessors,
    limitations,
    backup: computeBackupExpiry(completedAt, input.backupRetentionDays),
    coverageBaseline: {
      source: "docs/compliance/erasure-coverage-baseline.json",
      sha256: await baselineDigest(input.baseline),
      acceptedUncoveredTables: input.baseline.uncovered.length,
    },
    notice: CERTIFICATE_NOTICE,
  };
}

export function assertSigningKey(secret: string | undefined | null): asserts secret is string {
  if (typeof secret !== "string" || secret.length < MIN_SIGNING_KEY_LENGTH) {
    throw new Error(`signing key must be at least ${MIN_SIGNING_KEY_LENGTH} characters`);
  }
}

export async function signCertificatePayload(
  payload: CertificatePayload,
  key: { id: string; secret: string },
): Promise<{ document: SignedCertificate; documentJson: string; sha256: string; signature: string }> {
  assertSigningKey(key.secret);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(key.id)) throw new Error("invalid key id");
  const canonical = canonicalize(payload);
  const sha256 = await sha256Hex(canonical);
  const signature = await hmacSha256Hex(key.secret, SIGNING_DOMAIN + canonical);
  const document: SignedCertificate = {
    ...payload,
    integrity: { hashAlgorithm: HASH_ALGORITHM, sha256, signatureAlgorithm: SIGNATURE_ALGORITHM, keyId: key.id, signature },
  };
  return { document, documentJson: canonicalize(document), sha256, signature };
}

export interface VerifyResult {
  valid: boolean;
  checks: { wellFormed: boolean; hashMatches: boolean; keyKnown: boolean; signatureValid: boolean; storedHashMatches: boolean | null };
}

/**
 * Verifies a stored certificate. `keys` maps key id -> secret (current + retired keys), so a rotated key
 * keeps old certificates verifiable. `storedSha256` is the hash kept in the database column.
 */
export async function verifyCertificateJson(
  documentJson: string,
  keys: Record<string, string>,
  storedSha256?: string,
): Promise<VerifyResult> {
  const fail = (o: Partial<VerifyResult["checks"]> = {}): VerifyResult => ({
    valid: false,
    checks: { wellFormed: false, hashMatches: false, keyKnown: false, signatureValid: false, storedHashMatches: storedSha256 === undefined ? null : false, ...o },
  });
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(documentJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail();
    doc = parsed as Record<string, unknown>;
  } catch {
    return fail();
  }
  const integrity = doc.integrity as Partial<IntegrityBlock> | undefined;
  if (
    !integrity || typeof integrity.sha256 !== "string" || typeof integrity.signature !== "string" || typeof integrity.keyId !== "string" ||
    integrity.hashAlgorithm !== HASH_ALGORITHM || integrity.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
    doc.type !== CERTIFICATE_TYPE || doc.schemaVersion !== CERTIFICATE_SCHEMA_VERSION
  ) return fail();

  const { integrity: _omit, ...payload } = doc;
  let canonical: string;
  try {
    canonical = canonicalize(payload);
  } catch {
    return fail();
  }
  const sha = await sha256Hex(canonical);
  const hashMatches = timingSafeEqual(sha, integrity.sha256);
  const storedHashMatches = storedSha256 === undefined ? null : timingSafeEqual(sha, storedSha256);

  const secret = Object.prototype.hasOwnProperty.call(keys, integrity.keyId) ? keys[integrity.keyId] : undefined;
  const keyKnown = typeof secret === "string" && secret.length >= MIN_SIGNING_KEY_LENGTH;
  let signatureValid = false;
  if (keyKnown) signatureValid = timingSafeEqual(await hmacSha256Hex(secret as string, SIGNING_DOMAIN + canonical), integrity.signature);

  return {
    valid: hashMatches && signatureValid && storedHashMatches !== false,
    checks: { wellFormed: true, hashMatches, keyKnown, signatureValid, storedHashMatches },
  };
}

/**
 * Reads signing keys from env-like values. Current key: ERASURE_CERT_SIGNING_KEY (+ _KEY_ID, default "k1").
 * Retired keys for verification only: ERASURE_CERT_VERIFY_KEYS = JSON {"k0":"<secret>"}.
 */
export function loadSigningKeys(env: (name: string) => string | undefined): { current: { id: string; secret: string } | null; verify: Record<string, string> } {
  const secret = env("ERASURE_CERT_SIGNING_KEY");
  const id = env("ERASURE_CERT_KEY_ID") || "k1";
  const verify: Record<string, string> = {};
  const extra = env("ERASURE_CERT_VERIFY_KEYS");
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") verify[k] = v;
    } catch {
      /* ignore malformed retired-key map; current key still works */
    }
  }
  const current = secret && secret.length >= MIN_SIGNING_KEY_LENGTH && /^[A-Za-z0-9._-]{1,32}$/.test(id) ? { id, secret } : null;
  if (current) verify[current.id] = current.secret;
  return { current, verify };
}

export function parseBackupRetentionDays(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,4}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n > 0 && n <= MAX_BACKUP_RETENTION_DAYS ? n : null;
}
