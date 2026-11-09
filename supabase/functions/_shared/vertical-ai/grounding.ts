// supabase/functions/_shared/vertical-ai/grounding.ts
//
// "No grounding -> no assertion -> hand off or ask."
//
// Every technical statement the assistant may make (price, urgency, diagnosis hint, safety advice, code/permit)
// is an `Assertion` that must carry evidence ids. This module decides, deterministically:
//   grounded    -> may be asserted as fact
//   uncertain   -> evidence exists but is unreviewed / low-confidence: may be said ONLY with an explicit hedge
//   ungrounded  -> must NOT be asserted: dropped, logged as a grounding miss, and the caller is handed off or asked
//
// PURE: no I/O. The model never gets to author a price, code citation or safety instruction outside this gate.

import { jurisdictionApplies } from "./ontology.ts";
import type { Assertion, AssertionType, EvidenceRef, GroundingStatus } from "./types.ts";

export interface GroundingPolicy {
  now?: Date;
  /** Evidence below this confidence can only ever be "uncertain". */
  minConfidence?: number;
  callerJurisdiction?: string | null;
  /**
   * Safety guidance is the one place where withholding is more dangerous than an unreviewed answer, so
   * `safety_advice` backed by a safety-rule/ontology entry is allowed as grounded even when not yet licensed-reviewed
   * (the dashboard counts these as `unreviewed_safety_rule` so the review backlog stays visible).
   */
  safetyConservative?: boolean;
}

export interface AssertionVerdict {
  status: GroundingStatus;
  reason:
    | "grounded"
    | "safety_conservative_unreviewed"
    | "no_evidence"
    | "evidence_expired_or_out_of_scope"
    | "evidence_wrong_kind"
    | "unreviewed_or_low_confidence";
  usable: EvidenceRef[];
}

const KIND_OK: Record<AssertionType, ReadonlyArray<EvidenceRef["kind"]>> = {
  // A price may only ever be backed by the tenant's own price book / owner price policy.
  price: ["price_book", "policy"],
  urgency: ["rule", "ontology"],
  diagnosis_hint: ["ontology", "knowledge"],
  safety_advice: ["ontology", "rule"],
  code_permit: ["ontology", "knowledge", "policy"],
};

function inScope(e: EvidenceRef, now: Date, jurisdiction: string | null | undefined): boolean {
  if (e.effectiveOn && Date.parse(e.effectiveOn) > now.getTime()) return false;
  if (e.expiresOn && Date.parse(e.expiresOn) <= now.getTime()) return false;
  if (e.jurisdiction && !jurisdictionApplies(e.jurisdiction, jurisdiction ?? "US")) return false;
  return true;
}

export function evaluateAssertion(a: Assertion, policy: GroundingPolicy = {}): AssertionVerdict {
  const now = policy.now ?? new Date();
  const minConf = policy.minConfidence ?? 0.7;
  if (!a.evidence || a.evidence.length === 0) return { status: "ungrounded", reason: "no_evidence", usable: [] };

  const rightKind = a.evidence.filter((e) => KIND_OK[a.type].includes(e.kind));
  if (rightKind.length === 0) return { status: "ungrounded", reason: "evidence_wrong_kind", usable: [] };

  const usable = rightKind.filter((e) => inScope(e, now, policy.callerJurisdiction));
  if (usable.length === 0) return { status: "ungrounded", reason: "evidence_expired_or_out_of_scope", usable: [] };

  if (usable.some((e) => e.reviewed && e.confidence >= minConf)) return { status: "grounded", reason: "grounded", usable };

  if (a.type === "safety_advice" && (policy.safetyConservative ?? true) && usable.some((e) => e.confidence >= 0.5)) {
    return { status: "grounded", reason: "safety_conservative_unreviewed", usable };
  }
  return { status: "uncertain", reason: "unreviewed_or_low_confidence", usable };
}

export const UNCERTAIN_PREFIX = "I can't be certain without a technician looking at it, but generally ";
export const HANDOFF_SPOKEN = "I don't want to guess on that. Let me have a team member confirm it and get back to you.";

export interface EmittedStatement {
  type: AssertionType;
  /** What may be spoken: original text when grounded, hedged text when uncertain. */
  text: string;
  status: Exclude<GroundingStatus, "ungrounded">;
  evidenceIds: string[];
}

export interface GroundedAnswer {
  statements: EmittedStatement[];
  /** Assertions that were refused (ungrounded) with their reasons. Feeds the grounding-miss log. */
  misses: { type: AssertionType; text: string; reason: AssertionVerdict["reason"] }[];
  handoff: { required: boolean; reason: "ungrounded_assertion" | "nothing_grounded" | null; action: "handoff" | "ask" | null };
  /** Spoken text ready for the assistant: emitted statements, then a hand-off line if one is required. */
  spoken: string;
}

function lcfirst(s: string): string {
  return s.length > 0 && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Types whose absence/uncertainty must hand the caller to a human instead of letting the model improvise. */
const HANDOFF_ON_MISS: ReadonlySet<AssertionType> = new Set(["price", "code_permit", "safety_advice"]);

export function composeGroundedAnswer(assertions: readonly Assertion[], policy: GroundingPolicy = {}, opts: { askInstead?: string | null } = {}): GroundedAnswer {
  const statements: EmittedStatement[] = [];
  const misses: GroundedAnswer["misses"] = [];

  for (const a of assertions) {
    const v = evaluateAssertion(a, policy);
    if (v.status === "ungrounded") { misses.push({ type: a.type, text: a.text, reason: v.reason }); continue; }
    const ids = v.usable.map((e) => e.id);
    statements.push({ type: a.type, text: v.status === "uncertain" ? `${UNCERTAIN_PREFIX}${lcfirst(a.text)}` : a.text, status: v.status, evidenceIds: ids });
  }

  const missedCritical = misses.some((m) => HANDOFF_ON_MISS.has(m.type));
  // Nothing to ground (the caller asked no technical question) is NOT a hand-off; all-assertions-missed is.
  const nothing = assertions.length > 0 && statements.length === 0;
  const required = missedCritical || nothing;
  const action: GroundedAnswer["handoff"]["action"] = !required ? null : opts.askInstead ? "ask" : "handoff";
  const tail = !required ? "" : action === "ask" ? (opts.askInstead as string) : HANDOFF_SPOKEN;
  const spoken = [...statements.map((s) => s.text), tail].filter(Boolean).join(" ");

  return {
    statements,
    misses,
    handoff: { required, reason: !required ? null : missedCritical ? "ungrounded_assertion" : "nothing_grounded", action },
    spoken,
  };
}

/** Share of emitted technical statements that carry >=1 evidence id. By construction this is 1 (or n/a when empty). */
export function groundedStatementRate(answer: Pick<GroundedAnswer, "statements">): number | null {
  if (answer.statements.length === 0) return null;
  return answer.statements.filter((s) => s.evidenceIds.length > 0).length / answer.statements.length;
}
