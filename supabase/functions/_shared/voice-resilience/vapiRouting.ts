// Pure: what vapi-webhook's assistant-request handler should answer for a given ladder level.
// Returns null = proceed with the normal full-AI response (L0, or no alternative configured).
//
// NOT LIVE-VERIFIED: the `destination` response shape for assistant-request follows Vapi's documented
// "transfer/forward" destination object; confirm against current Vapi docs and in staging before relying on it.

import type { Level } from "./ladder.ts";

export interface LadderRouting {
  reducedAssistantId: string | null;
  /** First valid E.164 forwarding target for this org, or null. */
  forwardTarget: string | null;
  language: "en" | "es";
}

export type VapiAssistantResponse =
  | { assistantId: string; assistantOverrides: { variableValues: Record<string, string> } }
  | { destination: { type: "number"; number: string; message: string } };

const FORWARD_MSG = {
  en: "Our assistant is unavailable right now. Connecting you to the team.",
  es: "Nuestro asistente no está disponible ahora. Lo conectamos con el equipo.",
} as const;

export function ladderResponse(level: Level, r: LadderRouting, callerContext = ""): VapiAssistantResponse | null {
  if (level === 0) return null;
  // L2-L4 inside an engine-delivered call: the engine is alive (we were just called), so the safest degraded
  // behaviour is a human. Voicemail/static need the Twilio front door (voice-front-door), not this path.
  if (level >= 2 && r.forwardTarget) return { destination: { type: "number", number: r.forwardTarget, message: FORWARD_MSG[r.language] } };
  if (r.reducedAssistantId) return { assistantId: r.reducedAssistantId, assistantOverrides: { variableValues: { caller_context: callerContext } } };
  return null; // nothing configured to degrade to: keep answering with the full assistant rather than dropping the call
}
