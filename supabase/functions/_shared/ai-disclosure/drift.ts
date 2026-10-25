// supabase/functions/_shared/ai-disclosure/drift.ts
//
// Pure: compares business_profile.ai_disclosure_script with the live Vapi
// assistant's first message.

import { bestWindowSimilarity, normalizeForMatch, tokenize } from "./match.ts";

export type DriftVerdict = "in_sync" | "drift" | "no_first_message";

/** The disclosure must start within this many normalised characters of the opening. */
export const OPENING_WINDOW_CHARS = 80;
/** Vapi template variable our webhook fills with the caller-language disclosure. */
export const DYNAMIC_VARIABLE = /\{\{\s*ai_disclosure\s*\}\}/i;

export interface DriftResult {
  status: DriftVerdict;
  similarity: number;
  reason: string;
}

export function compareDisclosureToFirstMessage(expected: string, liveFirstMessage: string | null | undefined): DriftResult {
  const live = (liveFirstMessage ?? "").trim();
  if (!live) return { status: "no_first_message", similarity: 0, reason: "live_first_message_empty" };

  // {{ai_disclosure}} at the very start = always the right wording, per caller language.
  if (DYNAMIC_VARIABLE.test(live) && live.search(DYNAMIC_VARIABLE) <= OPENING_WINDOW_CHARS) {
    return { status: "in_sync", similarity: 1, reason: "uses_dynamic_variable" };
  }

  const exp = normalizeForMatch(expected);
  const norm = normalizeForMatch(live);
  if (!exp) return { status: "drift", similarity: 0, reason: "expected_script_empty" };

  const at = norm.indexOf(exp);
  if (at >= 0) {
    return at <= OPENING_WINDOW_CHARS
      ? { status: "in_sync", similarity: 1, reason: "exact_match" }
      : { status: "drift", similarity: 1, reason: "disclosure_not_at_start" };
  }
  const similarity = Number(bestWindowSimilarity(tokenize(exp), tokenize(norm)).toFixed(3));
  return { status: "drift", similarity, reason: similarity >= 0.6 ? "wording_differs" : "disclosure_missing" };
}
