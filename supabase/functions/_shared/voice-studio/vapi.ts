// Builds the ONLY thing Voice Studio ever sends to Vapi: a `voice` object.
// firstMessage (AI disclosure) and the system prompt are never part of the patch.
import type { Tuning } from "./logic.ts";
import { toProviderSettings } from "./logic.ts";

export function buildVapiVoice(providerVoiceId: string, t: Tuning) {
  const s = toProviderSettings(t);
  return {
    provider: "11labs",
    voiceId: providerVoiceId,
    stability: s.stability,
    similarityBoost: s.similarity_boost,
    style: s.style,
    useSpeakerBoost: s.use_speaker_boost,
    speed: s.speed,
  };
}
export const buildVapiPatch = (providerVoiceId: string, t: Tuning) => ({ voice: buildVapiVoice(providerVoiceId, t) });
