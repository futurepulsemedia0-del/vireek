// supabase/functions/_shared/ai-disclosure/outbound.ts
//
// DB glue so OUTBOUND voice calls carry the same AI disclosure proof as inbound ones.
//   1. outboundDisclosureVariables(): the business's disclosure wording as the `ai_disclosure` variable.
//   2. registerOutboundDisclosure():  writes the 'pending' call_ai_disclosures row once the provider returned a call id,
//      so vapi-webhook's end-of-call recordDisclosureOutcome() can prove (or flag) what was actually spoken.
// Both NEVER throw and never block a dial: a failed ledger write must not prevent or delay a call, and a failed config
// load falls back to the built-in default sentence (never to silence).
//
// DRAFT - NOT LEGAL ADVICE. See docs/compliance/state-ai-laws.md (TODO(counsel)).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadDisclosureConfig, planDisclosure } from "./ledger.ts";
import { withAiDisclosure } from "./outboundVars.ts";

export { AI_DISCLOSURE_VARIABLE, withAiDisclosure } from "./outboundVars.ts";

function warn(event: string, err: unknown): void {
  console.error(JSON.stringify({ event, error: err instanceof Error ? err.message : String(err) }));
}

/** `vars` plus `ai_disclosure` (business wording, else the built-in default). Never throws. */
export async function outboundDisclosureVariables(
  admin: SupabaseClient,
  userId: string,
  vars?: Record<string, string> | null,
): Promise<Record<string, string>> {
  try {
    const cfg = await loadDisclosureConfig(admin, userId);
    return withAiDisclosure(vars, cfg.script);
  } catch (err) {
    warn("outbound_disclosure_config_failed", err);
    return withAiDisclosure(vars, null);
  }
}

/** Creates the pending proof row for an outbound call. No-op without a call id. Never throws. */
export async function registerOutboundDisclosure(
  admin: SupabaseClient,
  input: { userId: string; vapiCallId: string | null | undefined },
): Promise<void> {
  if (!input.vapiCallId) return;
  try {
    await planDisclosure(admin, { userId: input.userId, vapiCallId: input.vapiCallId, callerLanguage: null });
  } catch (err) {
    warn("outbound_disclosure_register_failed", err);
  }
}
