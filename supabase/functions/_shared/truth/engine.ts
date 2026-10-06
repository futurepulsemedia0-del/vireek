// supabase/functions/_shared/truth/engine.ts
//
// Vireek Operational Truth Engine — the pure core. No I/O, no Deno APIs, no
// imports, so the SAME file runs in the Edge Functions, in vitest and (type-only)
// in the dashboard.
//
// Every operational fact an agent may act on is a claim with a provenance chain:
//
//   Source -> Evidence -> Freshness -> Confidence -> Conflict -> Verification
//
// resolveTruth() turns the claims for one (subject, predicate) into ONE verdict.
// An agent may only act when verdict === "verified" (allow === true). Everything
// else carries a machine-readable reason and the exact action that would unblock it.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceKind = "authority" | "system" | "document" | "human" | "ai";

export interface SourceDef {
  key: string;
  label: string;
  kind: SourceKind;
  /** Prior trust in the source itself, 0..1. */
  reliability: number;
  /** An authoritative fresh claim cannot be out-voted by non-authoritative ones. */
  authoritative: boolean;
  /** May a logged-in user assert claims from this source? (Authorities cannot be self-asserted.) */
  userAssertable: boolean;
}

export type TruthVerdict =
  | "verified"
  | "unverified"
  | "stale"
  | "expired"
  | "conflict"
  | "low_confidence"
  | "insufficient_corroboration"
  | "denied";

export type FactState = "fresh" | "aging" | "stale" | "expired";

export interface TruthFact {
  id: string;
  subject_type: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  source_key: string;
  source_ref: string | null;
  verified_at: string;
  expires_at: string | null;
  base_confidence: number;
  evidence_count: number;
}

export interface TruthPolicy {
  /** Exact predicate, or a prefix ending in "." (e.g. "credential."). */
  predicate: string;
  min_confidence: number;
  max_age_days: number;
  min_independent_sources: number;
  expiring_warning_days: number;
}

export interface FactAssessment {
  fact_id: string;
  source_key: string;
  source_label: string;
  authoritative: boolean;
  age_days: number;
  days_to_expiry: number | null;
  freshness: number;
  effective_confidence: number;
  state: FactState;
}

export interface TruthConflict {
  leading_value: unknown;
  leading_confidence: number;
  competing_value: unknown;
  competing_confidence: number;
  fact_ids: string[];
}

export interface TruthResolution {
  verdict: TruthVerdict;
  /** The ONLY field an agent may branch on to decide whether to act. */
  allow: boolean;
  reason: string;
  required_action: string | null;
  resolved_value: unknown;
  confidence: number;
  winning_fact_ids: string[];
  conflict: TruthConflict | null;
  assessments: FactAssessment[];
  warnings: string[];
  policy: TruthPolicy;
  evaluated_at: string;
}

// ---------------------------------------------------------------------------
// Source catalog
// ---------------------------------------------------------------------------

export const SOURCE_CATALOG: Record<string, SourceDef> = {
  state_license_db: { key: "state_license_db", label: "State License Database", kind: "authority", reliability: 0.99, authoritative: true, userAssertable: false },
  government_registry: { key: "government_registry", label: "Government Registry", kind: "authority", reliability: 0.98, authoritative: true, userAssertable: false },
  manufacturer_portal: { key: "manufacturer_portal", label: "Manufacturer Portal", kind: "authority", reliability: 0.98, authoritative: true, userAssertable: false },
  insurance_carrier: { key: "insurance_carrier", label: "Insurance Carrier", kind: "authority", reliability: 0.97, authoritative: true, userAssertable: false },
  vireek_system: { key: "vireek_system", label: "Vireek System Record", kind: "system", reliability: 0.95, authoritative: false, userAssertable: false },
  document_upload: { key: "document_upload", label: "Uploaded Document", kind: "document", reliability: 0.85, authoritative: false, userAssertable: true },
  field_observation: { key: "field_observation", label: "Field Observation", kind: "human", reliability: 0.8, authoritative: false, userAssertable: true },
  owner_entered: { key: "owner_entered", label: "Owner Entered", kind: "human", reliability: 0.7, authoritative: false, userAssertable: true },
  customer_stated: { key: "customer_stated", label: "Customer Stated", kind: "human", reliability: 0.6, authoritative: false, userAssertable: true },
  ai_inference: { key: "ai_inference", label: "AI Inference", kind: "ai", reliability: 0.45, authoritative: false, userAssertable: false },
};

const UNKNOWN_SOURCE: Omit<SourceDef, "key" | "label"> = { kind: "human", reliability: 0.3, authoritative: false, userAssertable: false };

export function getSource(key: string): SourceDef {
  return SOURCE_CATALOG[key] ?? { key, label: key, ...UNKNOWN_SOURCE };
}

export function isUserAssertable(key: string): boolean {
  return SOURCE_CATALOG[key]?.userAssertable === true;
}

/** Stored confidence of a fresh claim: source reliability, discounted when nothing backs it. */
export function computeBaseConfidence(sourceKey: string, evidenceCount: number, cap?: number | null): number {
  const raw = getSource(sourceKey).reliability * (evidenceCount > 0 ? 1 : 0.85);
  const capped = cap !== null && cap !== undefined && Number.isFinite(cap) ? Math.min(raw, cap) : raw;
  return round4(clamp(capped, 0.01, 0.999));
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const DEFAULT_POLICY = { min_confidence: 0.7, max_age_days: 90, min_independent_sources: 1, expiring_warning_days: 14 };

const BUILTIN_POLICIES: TruthPolicy[] = [
  { predicate: "credential.", min_confidence: 0.8, max_age_days: 90, min_independent_sources: 1, expiring_warning_days: 30 },
  { predicate: "qualification.", min_confidence: 0.8, max_age_days: 90, min_independent_sources: 1, expiring_warning_days: 30 },
  { predicate: "insurance.", min_confidence: 0.85, max_age_days: 30, min_independent_sources: 1, expiring_warning_days: 14 },
  { predicate: "pricing.", min_confidence: 0.8, max_age_days: 30, min_independent_sources: 1, expiring_warning_days: 7 },
  { predicate: "equipment.", min_confidence: 0.7, max_age_days: 180, min_independent_sources: 1, expiring_warning_days: 30 },
  { predicate: "customer.", min_confidence: 0.7, max_age_days: 365, min_independent_sources: 1, expiring_warning_days: 30 },
  { predicate: "availability.", min_confidence: 0.7, max_age_days: 1, min_independent_sources: 1, expiring_warning_days: 0 },
];

/** Exact override > longest matching prefix override > built-in prefix > global default. */
export function resolvePolicy(predicate: string, overrides: TruthPolicy[] = []): TruthPolicy {
  const matches = (p: TruthPolicy) => (p.predicate.endsWith(".") ? predicate.startsWith(p.predicate) : p.predicate === predicate);
  const pick = (list: TruthPolicy[]) =>
    list.filter(matches).sort((a, b) => Number(a.predicate.endsWith(".")) - Number(b.predicate.endsWith(".")) || b.predicate.length - a.predicate.length)[0];
  return pick(overrides) ?? pick(BUILTIN_POLICIES) ?? { predicate, ...DEFAULT_POLICY };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const CONFLICT_MIN_COMPETING = 0.35;
const CONFLICT_MARGIN = 0.4;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Deterministic JSON (sorted keys) so equal values group together regardless of key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Per-fact assessment
// ---------------------------------------------------------------------------

/**
 * Freshness decays slowly at first and accelerates toward the policy's hard age
 * limit: 1 - 0.35 * (age / max_age)^2. Past max_age (or expires_at) the claim is
 * unusable — it is never silently down-weighted into "probably fine".
 */
export function assessFact(fact: TruthFact, policy: TruthPolicy, now: Date): FactAssessment {
  const src = getSource(fact.source_key);
  const nowMs = now.getTime();
  const verifiedMs = Date.parse(fact.verified_at);
  const expiresMs = fact.expires_at ? Date.parse(fact.expires_at) : null;
  const age = Number.isFinite(verifiedMs) ? Math.max(0, (nowMs - verifiedMs) / DAY_MS) : Number.POSITIVE_INFINITY;
  const maxAge = Math.max(policy.max_age_days, 0.001);
  const daysToExpiry = expiresMs !== null && Number.isFinite(expiresMs) ? (expiresMs - nowMs) / DAY_MS : null;

  let state: FactState;
  if (daysToExpiry !== null && daysToExpiry <= 0) state = "expired";
  else if (age > maxAge) state = "stale";
  else if (age / maxAge > 0.6) state = "aging";
  else state = "fresh";

  const usable = state === "fresh" || state === "aging";
  const freshness = usable ? clamp(1 - 0.35 * Math.pow(age / maxAge, 2), 0, 1) : 0;
  return {
    fact_id: fact.id,
    source_key: fact.source_key,
    source_label: src.label,
    authoritative: src.authoritative,
    age_days: Number.isFinite(age) ? round4(age) : -1,
    days_to_expiry: daysToExpiry === null ? null : round4(daysToExpiry),
    freshness: round4(freshness),
    effective_confidence: round4(clamp(fact.base_confidence, 0, 1) * freshness),
    state,
  };
}

interface Group {
  key: string;
  value: unknown;
  score: number;
  authoritative: boolean;
  sources: Set<string>;
  fact_ids: string[];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** If set, the verified value must equal this (default for gates: true). */
  expected?: unknown;
  now?: Date;
}

export function resolveTruth(facts: TruthFact[], policy: TruthPolicy, options: ResolveOptions = {}): TruthResolution {
  const now = options.now ?? new Date();
  const evaluated_at = now.toISOString();
  const base = { policy, evaluated_at, winning_fact_ids: [] as string[], conflict: null as TruthConflict | null, resolved_value: null as unknown, confidence: 0, warnings: [] as string[] };

  if (facts.length === 0) {
    return { ...base, verdict: "unverified", allow: false, reason: "No verified record exists for this fact.", required_action: "Verify this fact with an authoritative source or upload evidence.", assessments: [] };
  }

  const byId = new Map(facts.map((f) => [f.id, f]));
  const assessments = facts.map((f) => assessFact(f, policy, now));
  const usable = assessments.filter((a) => a.state === "fresh" || a.state === "aging");

  if (usable.length === 0) {
    const allExpired = assessments.every((a) => a.state === "expired");
    const best = [...assessments].sort((a, b) => getSource(b.source_key).reliability - getSource(a.source_key).reliability)[0];
    return {
      ...base,
      assessments,
      verdict: allExpired ? "expired" : "stale",
      allow: false,
      reason: allExpired ? "Every record for this fact has passed its expiry date." : `The most recent record is older than the ${policy.max_age_days}-day freshness limit.`,
      required_action: `Re-verify with ${best.source_label}.`,
    };
  }

  // Group usable claims by value; a source can corroborate a value only once.
  const groups = new Map<string, Group>();
  for (const a of usable) {
    const fact = byId.get(a.fact_id)!;
    const key = stableStringify(fact.value);
    const g = groups.get(key) ?? { key, value: fact.value, score: 0, authoritative: false, sources: new Set<string>(), fact_ids: [] };
    g.fact_ids.push(a.fact_id);
    g.authoritative = g.authoritative || a.authoritative;
    g.sources.add(a.source_key);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const perSource = new Map<string, number>();
    for (const id of g.fact_ids) {
      const a = assessments.find((x) => x.fact_id === id)!;
      perSource.set(a.source_key, Math.max(perSource.get(a.source_key) ?? 0, a.effective_confidence));
    }
    g.score = round4(Math.min(0.999, 1 - [...perSource.values()].reduce((p, c) => p * (1 - c), 1)));
  }

  const ranked = [...groups.values()].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  const runner = ranked[1] ?? null;
  const out = { ...base, assessments, winning_fact_ids: winner.fact_ids };

  // Disagreeing records that are no longer usable are surfaced, not ignored.
  const staleDisagree = assessments.some((a) => (a.state === "stale" || a.state === "expired") && stableStringify(byId.get(a.fact_id)!.value) !== winner.key);
  if (staleDisagree) out.warnings.push("An older record disagrees with the current value.");

  if (runner) {
    const bothAuthoritative = winner.authoritative && runner.authoritative;
    const authorityWins = winner.authoritative && !runner.authoritative;
    const isConflict = bothAuthoritative || (!authorityWins && runner.score >= CONFLICT_MIN_COMPETING && winner.score - runner.score < CONFLICT_MARGIN);
    if (isConflict) {
      return {
        ...out,
        verdict: "conflict",
        allow: false,
        confidence: round4(winner.score * (1 - runner.score)),
        resolved_value: null,
        conflict: {
          leading_value: winner.value,
          leading_confidence: winner.score,
          competing_value: runner.value,
          competing_confidence: runner.score,
          fact_ids: [...winner.fact_ids, ...runner.fact_ids],
        },
        reason: "Trusted sources disagree about this fact.",
        required_action: "Resolve the conflict: verify with the most authoritative source and select the correct record.",
      };
    }
  }

  // A fresh authority is never dragged down by a lower-trust disagreement; it is only flagged.
  const authorityOutranks = !!runner && winner.authoritative && !runner.authoritative;
  const penalty = runner && !authorityOutranks ? runner.score : 0;
  const confidence = round4(winner.score * (1 - penalty));
  const resolved = { ...out, resolved_value: winner.value, confidence };
  if (authorityOutranks) resolved.warnings.push("A lower-trust source disagrees with the authoritative record.");

  if (!winner.authoritative && winner.sources.size < policy.min_independent_sources) {
    return { ...resolved, verdict: "insufficient_corroboration", allow: false, reason: `Policy requires ${policy.min_independent_sources} independent sources; only ${winner.sources.size} support this value.`, required_action: "Add a second independent source or verify with an authority." };
  }
  if (confidence < policy.min_confidence) {
    return { ...resolved, verdict: "low_confidence", allow: false, reason: `Confidence ${(confidence * 100).toFixed(1)}% is below the required ${(policy.min_confidence * 100).toFixed(0)}%.`, required_action: "Verify with a higher-reliability source or attach evidence." };
  }
  if (options.expected !== undefined && stableStringify(winner.value) !== stableStringify(options.expected)) {
    return { ...resolved, verdict: "denied", allow: false, reason: "The verified value does not match what the action requires.", required_action: null };
  }

  const wins = assessments.filter((a) => winner.fact_ids.includes(a.fact_id));
  const soonest = wins.map((a) => a.days_to_expiry).filter((d): d is number => d !== null).sort((a, b) => a - b)[0];
  if (soonest !== undefined && soonest <= policy.expiring_warning_days) resolved.warnings.push(`Expires in ${Math.max(0, Math.ceil(soonest))} day(s) — re-verify soon.`);
  if (wins.every((a) => a.state === "aging")) resolved.warnings.push("Record is aging — nearing the freshness limit.");

  return { ...resolved, verdict: "verified", allow: true, reason: "Verified, fresh, corroborated and conflict-free.", required_action: null };
}

// ---------------------------------------------------------------------------
// Input validation (shared by assert / ingest)
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS = ["document", "api_response", "photo", "signature", "record", "note"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceInput { kind: EvidenceKind; uri: string | null; content_hash: string | null; excerpt: string | null }

export interface AssertionInput {
  subject_type: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  source_key: string;
  source_ref: string | null;
  verified_at: string;
  expires_at: string | null;
  confidence_cap: number | null;
  method: string;
  evidence: EvidenceInput[];
}

const SUBJECT_TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SUBJECT_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const PREDICATE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_:-]+)+$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function normalizeAssertion(raw: unknown, now: Date = new Date()): { ok: true; value: AssertionInput } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const subject_type = str(r.subject_type);
  const subject_id = str(r.subject_id);
  const predicate = str(r.predicate);
  const source_key = str(r.source_key);
  if (!SUBJECT_TYPE_RE.test(subject_type)) return { ok: false, error: "Invalid subject_type." };
  if (!SUBJECT_ID_RE.test(subject_id)) return { ok: false, error: "Invalid subject_id." };
  if (predicate.length > 120 || !PREDICATE_RE.test(predicate)) return { ok: false, error: "Invalid predicate (use dotted names like credential.hvac_license)." };
  if (!SOURCE_CATALOG[source_key]) return { ok: false, error: "Unknown source_key." };

  const value = r.value === undefined ? true : r.value;
  if (stableStringify(value).length > 2000) return { ok: false, error: "value is too large." };

  const verifiedMs = r.verified_at === undefined || r.verified_at === null || r.verified_at === "" ? now.getTime() : Date.parse(str(r.verified_at));
  if (!Number.isFinite(verifiedMs)) return { ok: false, error: "Invalid verified_at." };
  if (verifiedMs > now.getTime() + 5 * 60_000) return { ok: false, error: "verified_at cannot be in the future." };

  let expires_at: string | null = null;
  if (r.expires_at !== undefined && r.expires_at !== null && r.expires_at !== "") {
    const e = Date.parse(str(r.expires_at));
    if (!Number.isFinite(e)) return { ok: false, error: "Invalid expires_at." };
    if (e <= verifiedMs) return { ok: false, error: "expires_at must be after verified_at." };
    if (e > now.getTime() + 3650 * DAY_MS) return { ok: false, error: "expires_at is too far in the future." };
    expires_at = new Date(e).toISOString();
  }

  const capRaw = r.confidence_cap;
  const cap = capRaw === undefined || capRaw === null || capRaw === "" ? null : Number(capRaw);
  if (cap !== null && (!Number.isFinite(cap) || cap <= 0 || cap > 1)) return { ok: false, error: "confidence_cap must be between 0 and 1." };

  const evidenceRaw = Array.isArray(r.evidence) ? r.evidence : [];
  if (evidenceRaw.length > 10) return { ok: false, error: "At most 10 evidence items per assertion." };
  const evidence: EvidenceInput[] = [];
  for (const e of evidenceRaw) {
    const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const kind = str(x.kind) as EvidenceKind;
    if (!EVIDENCE_KINDS.includes(kind)) return { ok: false, error: "Invalid evidence kind." };
    const hash = str(x.content_hash).toLowerCase();
    if (hash && !HASH_RE.test(hash)) return { ok: false, error: "content_hash must be a SHA-256 hex digest." };
    const uri = str(x.uri).slice(0, 500);
    const excerpt = str(x.excerpt).slice(0, 500);
    if (!uri && !hash && !excerpt) return { ok: false, error: "Each evidence item needs a uri, content_hash or excerpt." };
    evidence.push({ kind, uri: uri || null, content_hash: hash || null, excerpt: excerpt || null });
  }

  return {
    ok: true,
    value: {
      subject_type, subject_id, predicate, value, source_key,
      source_ref: str(r.source_ref).slice(0, 300) || null,
      verified_at: new Date(verifiedMs).toISOString(),
      expires_at, confidence_cap: cap,
      method: str(r.method).slice(0, 60) || "asserted",
      evidence,
    },
  };
}
