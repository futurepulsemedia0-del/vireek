// supabase/functions/_shared/review-shield/eligibility.ts
//
// The gate between "suspicious" and "appeal pack". Policy, in code:
//   * a genuine-customer match (or possible match) is NEVER an appeal candidate;
//   * an incomplete ledger search is NEVER treated as "no matching record";
//   * a rating below 5 from someone we can match is simply feedback;
//   * the owner must confirm, and the basis must be a PLATFORM-POLICY reason (fake engagement,
//     spam, conflict of interest, extortion), never "I disagree with it" or "it's unfair".

import type { LedgerReport } from "./match.ts";
import type { Signal } from "./detect.ts";
import type { PatternHit } from "./patterns.ts";

export type PolicyBasis = "fake_engagement" | "spam" | "conflict_of_interest" | "extortion_or_threat" | "off_topic";

export type EligibilityBlocker =
  | "ledger_match"
  | "ledger_possible_match"
  | "ledger_incomplete"
  | "owner_marked_genuine"
  | "no_suspicion_signal"
  | "owner_not_confirmed"
  | "no_policy_basis";

export interface EligibilityInput {
  ledger: LedgerReport | null;
  signals: Signal[]; // burst/wording signals that include this review
  extortionHits: PatternHit[];
  ownerMarkedGenuine: boolean;
  ownerConfirmed: boolean;
  basis: PolicyBasis | null;
}

export interface Eligibility {
  eligible: boolean;
  blockers: EligibilityBlocker[];
}

export function appealEligibility(i: EligibilityInput): Eligibility {
  const blockers: EligibilityBlocker[] = [];
  if (!i.ledger || i.ledger.overall === "incomplete") blockers.push("ledger_incomplete");
  else if (i.ledger.overall === "match") blockers.push("ledger_match");
  else if (i.ledger.overall === "possible_match") blockers.push("ledger_possible_match");
  if (i.ownerMarkedGenuine) blockers.push("owner_marked_genuine");
  if (i.signals.length === 0 && i.extortionHits.length === 0) blockers.push("no_suspicion_signal");
  if (!i.basis) blockers.push("no_policy_basis");
  if (!i.ownerConfirmed) blockers.push("owner_not_confirmed");
  return { eligible: blockers.length === 0, blockers };
}
