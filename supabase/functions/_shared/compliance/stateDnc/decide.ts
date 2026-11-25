// supabase/functions/_shared/compliance/stateDnc/decide.ts
//
// Pure (no Deno / DB / npm imports): decides whether an outbound call may be placed, given the account's IMPORTED
// registry lists and per-jurisdiction rules. It never contacts a registry and assumes nothing about any registry.
//
// DRAFT - NOT LEGAL ADVICE. Every default below is the STRICTEST reading and is TODO(counsel). Nothing in this file
// says that any state requires any specific scrub frequency, purpose scope or retention.
//
// Semantics (mirrors docs/compliance/state-contact-rules.md: unknown residency resolves to the strictest profile):
//   * Residency CONFIRMED (explicit state or address): the national list ("US") and that state's list apply.
//   * Residency only PRESUMED from the area code, or unknown: membership is checked against EVERY active list
//     (a number on any imported state list is held). Numbers port and people move.
//   * A rule with requireActiveList=true needs a fresh active list for its jurisdiction, otherwise the call is held.
//     "Fresh" = list age <= maxAgeDays (when set) and not expired. A stale list is still used for membership.
//   * Precedence: suppressed > blocked_* > clear. Purpose "emergency" is exempt from lists unless a rule says otherwise;
//     the account's own opt-out list (internalHit) suppresses every purpose.

export const STATE_DNC_RULES_VERSION = "2026-11-24.1";
export const FEDERAL = "US";

export type GateMode = "shadow" | "enforce";
export function parseGateMode(raw: string | null | undefined): GateMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow";
}

export type DncPurpose = "marketing" | "service" | "emergency";
/** Unknown / missing purposes are treated as marketing (strictest). */
export function normalizePurpose(raw: string | null | undefined): DncPurpose {
  const p = (raw ?? "").trim().toLowerCase();
  return p === "service" || p === "emergency" ? p : "marketing";
}

export type ResidencyBasis = "explicit" | "address" | "phone" | "unknown";
export interface Residency { state: string | null; basis: ResidencyBasis }

export interface ListMeta {
  id: string;
  jurisdiction: string; // "US" or "US-XX"
  name: string;
  versionLabel: string | null;
  effectiveDate: string | null; // YYYY-MM-DD
  expiresAt: string | null; // ISO
  activatedAt: string | null; // ISO
  rowCount: number;
  contentSha256: string | null;
}

export interface RuleRow {
  jurisdiction: string;
  appliesToPurposes: readonly string[];
  maxAgeDays: number | null;
  requireActiveList: boolean;
}

/** Strictest defaults used when an account has set no rule for a jurisdiction. TODO(counsel). */
export const DEFAULT_RULE: Omit<RuleRow, "jurisdiction"> = {
  appliesToPurposes: ["marketing", "service"],
  maxAgeDays: null,
  requireActiveList: false,
};

export type Decision =
  | "clear"
  | "suppressed"
  | "blocked_no_list"
  | "blocked_stale_list"
  | "blocked_unavailable"
  | "blocked_invalid_number";

export interface ListEvidence {
  list_id: string;
  jurisdiction: string;
  name: string;
  version_label: string | null;
  effective_date: string | null;
  row_count: number;
  content_sha256: string | null;
  age_days: number | null;
  stale: boolean;
  matched: boolean;
}

export interface DecideInput {
  purpose: DncPurpose;
  residency: Residency;
  lists: readonly ListMeta[]; // ACTIVE lists only
  rules: readonly RuleRow[];
  /** Ids of lists that contain the number (looked up only for relevantListIds). */
  matchedListIds: ReadonlySet<string>;
  internalHit: boolean;
  now: Date;
}

export interface Outcome {
  decision: Decision;
  reasonCode: string;
  retryable: boolean;
  relevantListIds: string[];
  matchedListIds: string[];
  evidence: ListEvidence[];
}

const DAY_MS = 86_400_000;

export function stateOf(jurisdiction: string): string | null {
  return jurisdiction === FEDERAL ? null : jurisdiction.replace(/^US-/, "");
}

export function ruleFor(jurisdiction: string, rules: readonly RuleRow[]): RuleRow {
  return rules.find((r) => r.jurisdiction === jurisdiction) ?? { jurisdiction, ...DEFAULT_RULE };
}

export function ruleApplies(rule: RuleRow, purpose: DncPurpose): boolean {
  return rule.appliesToPurposes.includes(purpose);
}

export function isConfirmed(r: Residency): boolean {
  return !!r.state && (r.basis === "explicit" || r.basis === "address");
}

/** Which active lists the number must be checked against. Strictest when residency is not confirmed. */
export function relevantLists(lists: readonly ListMeta[], residency: Residency): ListMeta[] {
  if (!isConfirmed(residency)) return [...lists];
  return lists.filter((l) => l.jurisdiction === FEDERAL || stateOf(l.jurisdiction) === residency.state);
}

/** Which jurisdictions must HAVE a fresh list (requireActiveList). Federal always; plus the confirmed or presumed state. */
export function requiredJurisdictions(residency: Residency): string[] {
  const out = [FEDERAL];
  if (residency.state) out.push(`US-${residency.state}`);
  return out;
}

export function ageDays(l: ListMeta, now: Date): number | null {
  const base = l.effectiveDate ? Date.parse(`${l.effectiveDate}T00:00:00Z`) : l.activatedAt ? Date.parse(l.activatedAt) : NaN;
  if (!Number.isFinite(base)) return null;
  return Math.max(0, Math.floor((now.getTime() - base) / DAY_MS));
}

function isExpired(l: ListMeta, now: Date): boolean {
  if (!l.expiresAt) return false;
  const t = Date.parse(l.expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

/** Fresh = not expired AND (no max age configured OR age known and within it). An unknown age with a max age is NOT fresh. */
export function isFresh(l: ListMeta, rule: RuleRow, now: Date): boolean {
  if (isExpired(l, now)) return false;
  if (rule.maxAgeDays == null) return true;
  const a = ageDays(l, now);
  return a != null && a <= rule.maxAgeDays;
}

export function decideScrub(i: DecideInput): Outcome {
  const relevant = relevantLists(i.lists, i.residency);
  const applicable = relevant.filter((l) => ruleApplies(ruleFor(l.jurisdiction, i.rules), i.purpose));

  const evidence: ListEvidence[] = relevant.map((l) => {
    const rule = ruleFor(l.jurisdiction, i.rules);
    return {
      list_id: l.id, jurisdiction: l.jurisdiction, name: l.name, version_label: l.versionLabel,
      effective_date: l.effectiveDate, row_count: l.rowCount, content_sha256: l.contentSha256,
      age_days: ageDays(l, i.now), stale: !isFresh(l, rule, i.now), matched: i.matchedListIds.has(l.id),
    };
  });
  const base = {
    relevantListIds: applicable.map((l) => l.id),
    matchedListIds: applicable.filter((l) => i.matchedListIds.has(l.id)).map((l) => l.id),
    evidence,
  };

  if (i.internalHit) return { ...base, decision: "suppressed", reasonCode: "INTERNAL_DNC", retryable: false };
  if (base.matchedListIds.length > 0) return { ...base, decision: "suppressed", reasonCode: "STATE_REGISTRY_MATCH", retryable: false };

  // A required jurisdiction must have at least one fresh active list.
  let missing = false;
  let stale = false;
  for (const j of requiredJurisdictions(i.residency)) {
    const rule = ruleFor(j, i.rules);
    if (!rule.requireActiveList || !ruleApplies(rule, i.purpose)) continue;
    const ofJ = i.lists.filter((l) => l.jurisdiction === j);
    if (ofJ.length === 0) missing = true;
    else if (!ofJ.some((l) => isFresh(l, rule, i.now))) stale = true;
  }
  if (missing) return { ...base, decision: "blocked_no_list", reasonCode: "REQUIRED_LIST_MISSING", retryable: true };
  if (stale) return { ...base, decision: "blocked_stale_list", reasonCode: "REQUIRED_LIST_STALE", retryable: true };
  return { ...base, decision: "clear", reasonCode: applicable.length ? "SCRUBBED_CLEAR" : "NO_APPLICABLE_LIST", retryable: false };
}
