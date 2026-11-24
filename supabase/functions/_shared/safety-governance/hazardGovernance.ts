// supabase/functions/_shared/safety-governance/hazardGovernance.ts
//
// Safety-critical content governance for hazard guidance (gas, carbon monoxide, electrical, refrigerant).
// PURE and dependency-free: runs unchanged in edge functions, CI scripts and unit tests.
//
// What this module decides
//   * Which domain(s) a piece of content touches (detectHazardDomains).
//   * Whether a human review is CURRENT for it (evaluateReview): reviewer, review date, expiry and version must all be
//     present and valid, the review must not be in the future, must not outlive MAX_REVIEW_VALIDITY_DAYS, and (for
//     code-resident text) must be bound to the exact text via a content hash, so editing the text voids the review.
//   * Whether the content may be USED (decideUse), by tier:
//
//       floor          evacuate / call 911 / on-call alert wording and the deterministic detectors. NEVER blocked:
//                      withholding "leave the building" because a review lapsed would be more dangerous than speaking
//                      it. Lapsed or missing review is surfaced as backlog (mode "floor_unreviewed"), not as a block.
//       guardrail      prompt text that RESTRICTS the model near hazards ("never give gas steps"). Never blocked at runtime
//                      for the same reason; a change without re-review fails the CI check instead.
//       instructional  anything that tells a person or a model what to DO, CHECK or ASSERT about a hazard (diagnostic
//                      checks, hazard hypotheses, permit / code claims, playbook scripts, training scenarios). Blocked
//                      from AI use and from publishing unless a current review exists.
//       none           no hazard content.
//
// This module is an engineering control. It does NOT establish that any content is correct, compliant or sufficient;
// the reviewer's qualification and the review standard are decided by the business [COUNSEL].

export const HAZARD_DOMAINS = ["gas", "carbon_monoxide", "electrical", "refrigerant"] as const;
export type HazardDomain = typeof HAZARD_DOMAINS[number];
export type HazardTier = "none" | "floor" | "guardrail" | "instructional";

/** A review is valid for at most this many days from the review date. Proposed cadence, not a legal requirement. [COUNSEL] */
export const MAX_REVIEW_VALIDITY_DAYS = 366;

export interface ReviewRecord {
  /** Name of the human reviewer. Never a system or service account. */
  reviewer: string;
  /** Qualification the reviewer relied on, e.g. "licensed gas fitter, <licence id>". Free text, verified by the business. [VERIFY] */
  reviewerQualification: string;
  /** ISO date (YYYY-MM-DD) the review was completed. */
  reviewedOn: string;
  /** ISO date (YYYY-MM-DD) after which the review no longer counts. */
  expiresOn: string;
  /** Version of the content that was reviewed (integer >= 1). */
  version: number;
  /** contentHash() of the exact reviewed text. Required for code-resident content, optional for versioned DB rows. */
  contentHash?: string;
}

export type ReviewStatus = "approved" | "unreviewed" | "expired" | "stale" | "invalid";

export interface ReviewVerdict { status: ReviewStatus; reasons: string[] }

const DOMAIN_PATTERNS: Record<HazardDomain, RegExp> = {
  gas: /\b(?:natural gas|propane|lpg|gas (?:leak|smell|odou?r|line|lines|valve|supply|pipe|piping|furnace|appliance|appliances|meter|shut ?off|pressure|permit)|smell(?:s|ing)? (?:of )?gas|pilot light|flame sensor|gas)\b|huele a gas|fuga de gas/i,
  carbon_monoxide: /\b(?:carbon monoxide|monoxide|co (?:alarm|alarms|detector|detectors|sensor|safety|risk|poisoning)|co2? alarm|flue|venting|backdraft(?:ing)?)\b|monoxido de carbono|monóxido de carbono/i,
  electrical: /\b(?:electrical|electric shock|live wir(?:e|es|ing)|wiring|breaker|breakers|(?:main|sub|electrical|breaker|service) panel|gfci|arc ?fault|sparking|sparks|arcing|lockout|tagout|high voltage|energized)\b/i,
  refrigerant: /\b(?:refrigerant|freon|r-?410a|r-?22|r-?32|r-?454b|epa ?608|superheat|subcool(?:ing)?|brazing|nitrogen purge|recover(?:y|ing) (?:refrigerant|machine)|low charge)\b/i,
};

/** Domains a text touches. Order follows HAZARD_DOMAINS. Pure; bounded input (first 20k chars). */
export function detectHazardDomains(text: string | null | undefined): HazardDomain[] {
  const t = (text ?? "").slice(0, 20_000);
  if (!t) return [];
  return HAZARD_DOMAINS.filter((d) => DOMAIN_PATTERNS[d].test(t));
}

/** Whitespace-insensitive 53-bit content hash (cyrb53) as 14 hex chars. Drift detection only, NOT a security primitive. */
export function contentHash(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dayMs(iso: string): number { return Date.parse(`${iso}T00:00:00Z`); }
function validIso(iso: unknown): iso is string {
  return typeof iso === "string" && ISO_DATE.test(iso) && !Number.isNaN(dayMs(iso)) && new Date(dayMs(iso)).toISOString().startsWith(iso);
}

/**
 * Is this review current for the content as it exists NOW?
 * `current.version` is the version of the content being used; `current.hash` the hash of its text when code-resident.
 * Fails closed: any malformed field makes the review "invalid", never "approved".
 */
export function evaluateReview(
  review: ReviewRecord | null | undefined,
  current: { version: number; hash?: string | null },
  now: Date = new Date(),
): ReviewVerdict {
  if (!review) return { status: "unreviewed", reasons: ["no review on record"] };
  const bad: string[] = [];
  if (typeof review.reviewer !== "string" || review.reviewer.trim().length < 3) bad.push("reviewer missing");
  if (typeof review.reviewerQualification !== "string" || review.reviewerQualification.trim().length < 3) bad.push("reviewer qualification missing");
  if (!validIso(review.reviewedOn)) bad.push("review date invalid");
  if (!validIso(review.expiresOn)) bad.push("expiry date invalid");
  if (!Number.isInteger(review.version) || review.version < 1) bad.push("version invalid");
  if (bad.length > 0) return { status: "invalid", reasons: bad };

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const on = dayMs(review.reviewedOn);
  const exp = dayMs(review.expiresOn);
  if (on > today) bad.push("review date is in the future");
  if (exp <= on) bad.push("expiry is not after the review date");
  if (exp - on > MAX_REVIEW_VALIDITY_DAYS * 86_400_000) bad.push(`validity exceeds ${MAX_REVIEW_VALIDITY_DAYS} days`);
  if (bad.length > 0) return { status: "invalid", reasons: bad };

  if (exp <= today) return { status: "expired", reasons: [`expired on ${review.expiresOn}`] };
  if (review.version !== current.version) return { status: "stale", reasons: [`reviewed version ${review.version}, content is version ${current.version}`] };
  if (current.hash != null && review.contentHash !== current.hash) return { status: "stale", reasons: ["content changed after the review (hash mismatch)"] };
  return { status: "approved", reasons: [] };
}

export type UseKind = "ai" | "publish";
export interface UseDecision {
  allow: boolean;
  /** approved = reviewed; floor_unreviewed = allowed because it is a safety floor, counted as backlog; blocked = not allowed. */
  mode: "approved" | "floor_unreviewed" | "blocked" | "no_hazard";
  reasons: string[];
}

export function decideUse(tier: HazardTier, verdict: ReviewVerdict): UseDecision {
  if (tier === "none") return { allow: true, mode: "no_hazard", reasons: [] };
  if (verdict.status === "approved") return { allow: true, mode: "approved", reasons: [] };
  if (tier === "floor" || tier === "guardrail") return { allow: true, mode: "floor_unreviewed", reasons: verdict.reasons };
  return { allow: false, mode: "blocked", reasons: [`${verdict.status}: ${verdict.reasons.join("; ")}`] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ontology rows (DB-resident, versioned). Used by vertical-ai/runtime.ts before rows reach the AI planner.
// ---------------------------------------------------------------------------------------------------------------------

export interface GovernedEntry {
  kind: string;
  key: string;
  version: number;
  title: string;
  payload: unknown;
  reviewed: boolean;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewExpiresOn?: string | null;
  reviewerQualification?: string | null;
  /** Domains declared in the database (audit). Only ever ADDS to what is detected from the text, never removes. */
  declaredHazardDomains?: readonly string[] | null;
}

function payloadText(e: GovernedEntry): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  // caller synonyms are what people SAY (\"gas smell\"), not guidance; everything else is content that may be asserted or acted on
  const { synonyms: _syn, ...rest } = p;
  void _syn;
  return `${e.title} ${JSON.stringify(rest)}`;
}

export function entryHazardDomains(e: GovernedEntry): HazardDomain[] {
  const found = new Set<HazardDomain>(detectHazardDomains(payloadText(e)));
  for (const d of e.declaredHazardDomains ?? []) if ((HAZARD_DOMAINS as readonly string[]).includes(d)) found.add(d as HazardDomain);
  return HAZARD_DOMAINS.filter((d) => found.has(d));
}

export function entryTier(e: GovernedEntry): HazardTier {
  if (entryHazardDomains(e).length === 0) return "none";
  return e.kind === "safety_rule" ? "floor" : "instructional";
}

export function entryReview(e: GovernedEntry): ReviewRecord | null {
  if (!e.reviewed || !e.reviewedBy || !e.reviewedAt || !e.reviewExpiresOn) return null;
  return {
    reviewer: e.reviewedBy,
    reviewerQualification: e.reviewerQualification ?? "",
    reviewedOn: String(e.reviewedAt).slice(0, 10),
    expiresOn: String(e.reviewExpiresOn).slice(0, 10),
    version: e.version,
  };
}

export interface GateResult<T> {
  allowed: T[];
  blocked: { kind: string; key: string; version: number; tier: HazardTier; reasons: string[] }[];
  /** Floor / guardrail rows that are allowed but have no current review (review backlog). */
  unreviewedFloor: string[];
}

/** Keep only entries the AI may use. `enforce=false` reports but blocks nothing (staged rollout). */
export function gateEntriesForAi<T extends GovernedEntry>(entries: readonly T[], now: Date = new Date(), enforce = true): GateResult<T> {
  const out: GateResult<T> = { allowed: [], blocked: [], unreviewedFloor: [] };
  for (const e of entries) {
    const tier = entryTier(e);
    const verdict = evaluateReview(entryReview(e), { version: e.version }, now);
    const d = decideUse(tier, verdict);
    if (d.mode === "floor_unreviewed") out.unreviewedFloor.push(`${e.kind}:${e.key}@v${e.version}`);
    if (!d.allow) {
      out.blocked.push({ kind: e.kind, key: e.key, version: e.version, tier, reasons: d.reasons });
      if (enforce) continue;
    }
    out.allowed.push(e);
  }
  return out;
}
