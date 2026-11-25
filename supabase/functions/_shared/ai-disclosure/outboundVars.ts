// supabase/functions/_shared/ai-disclosure/outboundVars.ts
//
// Pure (no Deno / DB / npm imports). Outbound calls that name a saved assistant (`assistantId`) never pass through
// vapi-webhook's assistant-request, so nothing fills the `{{ai_disclosure}}` template variable. An assistant whose first
// message starts with that variable is judged "in sync" by drift.ts, yet would speak an empty/placeholder opening on an
// outbound call. Every outbound call therefore sends the variable itself, through this one function.
//
// DRAFT - NOT LEGAL ADVICE. See docs/compliance/state-ai-laws.md (TODO(counsel)).

import { DEFAULT_DISCLOSURE_SCRIPT } from "./select.ts";

/** Must equal the name inside drift.ts DYNAMIC_VARIABLE and the one vapi-webhook sets for inbound calls. */
export const AI_DISCLOSURE_VARIABLE = "ai_disclosure";

/**
 * Returns a copy of `vars` with `ai_disclosure` set. The disclosure ALWAYS wins over a same-named caller-supplied
 * variable (campaign context must never be able to blank or rewrite it), and an empty text falls back to the
 * built-in default, so the value can never be missing.
 */
export function withAiDisclosure(
  vars: Record<string, string> | null | undefined,
  text: string | null | undefined,
): Record<string, string> {
  const spoken = (text ?? "").trim() || DEFAULT_DISCLOSURE_SCRIPT;
  return { ...(vars ?? {}), [AI_DISCLOSURE_VARIABLE]: spoken };
}
