// supabase/functions/_shared/verification-network/engine.ts
//
// VIREEK Verification Network - pure decision engine.
//
// No I/O, no Deno or Node globals except `crypto.subtle`, so the very same file runs in the
// edge function and in vitest (src/lib/verificationNetwork.test.ts).
//
// Design rules (these are what make the result trustworthy):
//   1. A check is only "verified_primary" when a PRIMARY source returned a record whose holder
//      name matches the technician (or their company) AND the record is active AND not expired.
//   2. Anything ambiguous (no record, name mismatch, unknown jurisdiction, no connector) is
//      "needs_review" - never silently "verified" and never silently "failed".
//   3. Negative findings (suspended / revoked / expired / below minimum cover) are "adverse".
//   4. Every decision carries a SHA-256 evidence seal over the exact data it was based on.

export type VerificationKind = "license" | "insurance" | "background";
export type FinalStatus = "verified_primary" | "verified_document" | "needs_review" | "adverse" | "error";
export type LicenseStatus = "active" | "inactive" | "expired" | "suspended" | "revoked" | "unknown";
export type VerificationMethod = "primary_source_api" | "rules_engine" | "document_review" | "manual";

export interface Decision {
  status: FinalStatus;
  reason: string;
  licenseStatus: LicenseStatus | null;
  holderName: string | null;
  nameMatchScore: number | null;
  classification: string | null;
  expiresOn: string | null; // YYYY-MM-DD
  disciplinaryFlag: boolean | null;
  coverageCents: number | null;
  carrier: string | null;
  method: VerificationMethod;
  evidence: Record<string, unknown>;
}

export interface NormalizedRecord {
  licenseNumber: string | null;
  holderName: string | null;
  rawStatus: string | null;
  expiresOn: string | null;
  classification: string | null;
  disciplinary: boolean | null;
}

export type StatusMap = Partial<Record<Exclude<LicenseStatus, "unknown">, string[]>>;

export const NAME_MATCH_THRESHOLD = 0.67;
export const RECHECK_DAYS_VERIFIED = 30;
export const RECHECK_DAYS_ADVERSE_LICENSE = 7;
export const MAX_ATTEMPTS = 5;

/** Default minimum coverage per policy type, in cents. Only types listed here are enforced. */
export const DEFAULT_MIN_COVERAGE_CENTS: Record<string, number> = {
  general_liability: 100_000_000, // USD 1,000,000
};

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- identifiers

/** Uppercase, keep letters/digits/hyphen only. "tx-123 456" -> "TX-123456". */
export function normalizeLicenseNumber(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, "").slice(0, 40);
}

/** Forms of a license number a public dataset might store: as typed, no hyphens, no leading zeros. */
export function licenseNumberCandidates(raw: unknown): string[] {
  const base = normalizeLicenseNumber(raw);
  if (!base) return [];
  const set = new Set<string>([base]);
  const noHyphen = base.replace(/-/g, "");
  if (noHyphen) set.add(noHyphen);
  const stripped = noHyphen.replace(/^0+(?=[A-Z0-9])/, "");
  if (stripped) set.add(stripped);
  return [...set].slice(0, 6);
}

// ---------------------------------------------------------------- names

const NAME_NOISE = new Set([
  "llc", "inc", "corp", "co", "company", "ltd", "the", "and", "of", "dba", "lp", "llp", "pllc",
  "services", "service", "enterprises", "group",
]);

export function nameTokens(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !NAME_NOISE.has(t));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

function tokensEqual(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b));
}

/** Dice coefficient over name tokens (order independent, so "SMITH, JOHN" == "John Smith"). */
export function nameMatchScore(a: unknown, b: unknown): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const used = new Set<number>();
  let common = 0;
  for (const x of ta) {
    const idx = tb.findIndex((y, i) => !used.has(i) && tokensEqual(x, y));
    if (idx >= 0) {
      used.add(idx);
      common++;
    }
  }
  return Math.round(((2 * common) / (ta.length + tb.length)) * 100) / 100;
}

export function bestNameScore(holder: string | null, candidates: string[]): number {
  if (!holder) return 0;
  return candidates.reduce((best, c) => Math.max(best, nameMatchScore(holder, c)), 0);
}

// ---------------------------------------------------------------- jurisdiction

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(US_STATES));
// Two-letter codes that are also common English words: only accepted when the caller says so explicitly.
const AMBIGUOUS_CODES = new Set(["IN", "OR", "ME", "OK", "HI", "ID", "AS", "OH"]);
const STATE_NAMES_LONGEST_FIRST = Object.keys(US_STATES).sort((a, b) => b.length - a.length);

/** "US-TX" or null. Accepts an already-formed code, a full state name, or an unambiguous UPPERCASE code. */
export function inferJurisdiction(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const direct = text.trim().toUpperCase().match(/^US-([A-Z]{2})$/);
  if (direct) return STATE_CODES.has(direct[1]) ? `US-${direct[1]}` : null;

  const found = new Set<string>();
  let rest = ` ${text.toLowerCase()} `;
  for (const name of STATE_NAMES_LONGEST_FIRST) {
    const re = new RegExp(`(?<![a-z])${name}(?![a-z])`, "g");
    if (re.test(rest)) {
      found.add(US_STATES[name]);
      rest = rest.replace(re, " ");
    }
  }
  for (const m of text.matchAll(/(?<![A-Za-z])([A-Z]{2})(?![A-Za-z])/g)) {
    const code = m[1];
    if (STATE_CODES.has(code) && !AMBIGUOUS_CODES.has(code)) found.add(code);
  }
  return found.size === 1 ? `US-${[...found][0]}` : null;
}

export function isValidJurisdiction(v: unknown): v is string {
  return typeof v === "string" && /^US-[A-Z]{2}$/.test(v) && STATE_CODES.has(v.slice(3));
}

// ---------------------------------------------------------------- dates

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Accepts ISO (2027-03-01[T...]) or US (03/01/2027). Returns YYYY-MM-DD or null. */
export function parseDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return toIsoDate(dt);
}

// ---------------------------------------------------------------- license evaluation

export function mapLicenseStatus(raw: string | null, map: StatusMap | undefined): LicenseStatus {
  if (!raw) return "unknown";
  const v = raw.trim().toLowerCase();
  const order: Exclude<LicenseStatus, "unknown">[] = ["revoked", "suspended", "expired", "inactive", "active"];
  for (const key of order) {
    if ((map?.[key] ?? []).some((x) => x.trim().toLowerCase() === v)) return key;
  }
  return "unknown";
}

export interface LicenseContext {
  /** Names the licence may legitimately be issued to: the technician and the company. */
  holderNames: string[];
  today: string; // YYYY-MM-DD
  statusMap?: StatusMap;
}

function emptyDecision(partial: Partial<Decision> & Pick<Decision, "status" | "reason" | "method">): Decision {
  return {
    licenseStatus: null, holderName: null, nameMatchScore: null, classification: null, expiresOn: null,
    disciplinaryFlag: null, coverageCents: null, carrier: null, evidence: {}, ...partial,
  };
}

export function evaluateLicenseRecords(records: NormalizedRecord[], ctx: LicenseContext): Decision {
  const base = { method: "primary_source_api" as const };
  if (records.length === 0) {
    return emptyDecision({ ...base, status: "needs_review", reason: "record_not_found", evidence: { records_found: 0 } });
  }
  const scored = records
    .map((r) => ({ r, score: bestNameScore(r.holderName, ctx.holderNames) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const evidence = {
    records_found: records.length,
    best_name_score: best.score,
    record: {
      license_number: best.r.licenseNumber, holder_name: best.r.holderName, status: best.r.rawStatus,
      expires_on: best.r.expiresOn, classification: best.r.classification, disciplinary: best.r.disciplinary,
    },
  };
  const common = {
    ...base, evidence, holderName: best.r.holderName, nameMatchScore: best.score,
    classification: best.r.classification, expiresOn: best.r.expiresOn, disciplinaryFlag: best.r.disciplinary,
  };
  if (!best.r.holderName) return emptyDecision({ ...common, status: "needs_review", reason: "name_unavailable" });
  if (best.score < NAME_MATCH_THRESHOLD) {
    return emptyDecision({ ...common, status: "needs_review", reason: "name_mismatch" });
  }

  let status = mapLicenseStatus(best.r.rawStatus, ctx.statusMap);
  if (status === "active" && best.r.expiresOn && best.r.expiresOn < ctx.today) status = "expired";
  if (status === "unknown") {
    return emptyDecision({ ...common, licenseStatus: status, status: "needs_review", reason: "status_unrecognised" });
  }
  if (status === "active") {
    return emptyDecision({ ...common, licenseStatus: status, status: "verified_primary", reason: "matched_active" });
  }
  return emptyDecision({ ...common, licenseStatus: status, status: "adverse", reason: `license_${status}` });
}

// ---------------------------------------------------------------- insurance evaluation

export interface PolicyInput {
  policy_type: string;
  carrier: string | null;
  status: string;
  expires_at: string;
  effective_date: string | null;
  coverage_amount_cents: number | null;
  verified_at: string | null;
}

export function evaluateInsurancePolicy(
  p: PolicyInput,
  today: string,
  minCoverage: Record<string, number> = DEFAULT_MIN_COVERAGE_CENTS,
): Decision {
  const min = minCoverage[p.policy_type];
  const common = {
    method: "rules_engine" as const,
    carrier: p.carrier,
    coverageCents: p.coverage_amount_cents,
    expiresOn: parseDate(p.expires_at),
    evidence: {
      policy_type: p.policy_type, carrier: p.carrier, expires_at: p.expires_at, effective_date: p.effective_date,
      coverage_amount_cents: p.coverage_amount_cents, minimum_required_cents: min ?? null,
      manager_reviewed: p.verified_at !== null,
    },
  };
  if (p.status !== "active") return emptyDecision({ ...common, status: "adverse", reason: "policy_cancelled" });
  if (common.expiresOn === null) return emptyDecision({ ...common, status: "needs_review", reason: "expiry_invalid" });
  if (common.expiresOn < today) return emptyDecision({ ...common, status: "adverse", reason: "policy_expired" });
  const eff = parseDate(p.effective_date ?? "");
  if (eff && eff > today) return emptyDecision({ ...common, status: "needs_review", reason: "policy_not_yet_effective" });
  if (min !== undefined) {
    if (p.coverage_amount_cents === null) return emptyDecision({ ...common, status: "needs_review", reason: "coverage_unknown" });
    if (p.coverage_amount_cents < min) return emptyDecision({ ...common, status: "adverse", reason: "coverage_below_minimum" });
  }
  if (!p.verified_at) return emptyDecision({ ...common, status: "needs_review", reason: "coi_not_reviewed" });
  return emptyDecision({ ...common, status: "verified_document", reason: "policy_ok" });
}

// ---------------------------------------------------------------- manual resolution

export interface ManualInput {
  kind: VerificationKind;
  outcome: "verified" | "adverse";
  licenseStatus?: LicenseStatus | null;
  expiresOn?: string | null;
  note: string;
  reference?: string | null;
}

/** Manager-attested result with document evidence (e.g. portal screenshot, COI, vendor report). */
export function decisionFromManual(input: ManualInput, today: string): Decision {
  const expiresOn = input.expiresOn ? parseDate(input.expiresOn) : null;
  const expired = expiresOn !== null && expiresOn < today;
  const adverse = input.outcome === "adverse" || expired;
  return emptyDecision({
    method: "document_review",
    status: adverse ? "adverse" : "verified_document",
    reason: adverse ? (expired ? "manual_expired" : "manual_adverse") : "manual_verified",
    licenseStatus: input.kind === "license" ? (adverse ? (expired ? "expired" : input.licenseStatus ?? "inactive") : "active") : null,
    expiresOn,
    evidence: { note: input.note.slice(0, 1000), reference: input.reference?.slice(0, 200) ?? null },
  });
}

// ---------------------------------------------------------------- scheduling

export function nextCheckAt(d: Pick<Decision, "status" | "expiresOn">, kind: VerificationKind, now: Date, attempts = 0): Date | null {
  switch (d.status) {
    case "verified_primary":
    case "verified_document": {
      const regular = now.getTime() + RECHECK_DAYS_VERIFIED * DAY_MS;
      if (!d.expiresOn) return new Date(regular);
      const afterExpiry = Date.parse(`${d.expiresOn}T00:00:00Z`) + DAY_MS;
      return new Date(Math.max(now.getTime() + 3_600_000, Math.min(regular, afterExpiry)));
    }
    case "adverse":
      return kind === "license" ? new Date(now.getTime() + RECHECK_DAYS_ADVERSE_LICENSE * DAY_MS) : null;
    case "error":
      return new Date(now.getTime() + Math.min(2 ** attempts, 24) * 3_600_000);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- evidence seal

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Seal binds the decision to the subject, the source and the moment it was made. */
export async function sealEvidence(args: {
  kind: VerificationKind; sourceKey: string | null; subjectFingerprint: string; checkedAt: string; decision: Decision;
}): Promise<string> {
  const { decision: d } = args;
  return sha256Hex(canonicalJson({
    v: 1, kind: args.kind, source: args.sourceKey, subject: args.subjectFingerprint, at: args.checkedAt,
    status: d.status, reason: d.reason, license_status: d.licenseStatus, expires_on: d.expiresOn,
    name_score: d.nameMatchScore, evidence: d.evidence,
  }));
}
