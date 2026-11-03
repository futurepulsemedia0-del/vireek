// ---------------------------------------------------------------------------
// Voice map — business_profile.assistant_voice (dashboard picker id) → Vapi voice config.
//
// Single source of truth for every place a call is created or an
// assistant-request is answered. Do not hand-roll voice objects elsewhere.
//
// The ids MUST stay in sync with:
//   - VOICE_OPTIONS in src/pages/AssistantPersonaPage.tsx
//   - the assistant_voice CHECK constraint in
//     supabase/migrations/20260911060000_add_business_profile_assistant_persona.sql
//
// Voices are Vapi-native (docs.vapi.ai/providers/voice/vapi-voices): no
// third-party credentials are needed, and every voiceId below is listed there
// as Active. `version: 2` is set only for voices the docs list as V2-capable.
//
// ACCENT CAVEAT: Vapi-native voices include no British female voice (the only
// British voice is the male "Dan"). 'maya-calm-f-uk' therefore maps to a
// female voice with an American accent so calls never fail on an unverified
// third-party voiceId. To get a real UK female voice, change that one entry
// after confirming the provider/voiceId in the Vapi Voice Library.
// ---------------------------------------------------------------------------

export interface VapiVoiceConfig {
  provider: "vapi";
  voiceId: string;
  /** Only present for voices the Vapi docs list as V2-capable. */
  version?: 2;
}

/** Same as the DB default for assistant_voice ('sarah-warm-f-us'). */
export const DEFAULT_ASSISTANT_VOICE_ID = "sarah-warm-f-us";

export const VOICE_MAP: Readonly<Record<string, VapiVoiceConfig>> = Object.freeze({
  "sarah-warm-f-us": { provider: "vapi", voiceId: "Savannah", version: 2 }, // female, American
  "aria-friendly-f-us": { provider: "vapi", voiceId: "Emma", version: 2 }, // female, American
  "maya-calm-f-uk": { provider: "vapi", voiceId: "Clara", version: 2 }, // female; American accent — see ACCENT CAVEAT
  "miles-confident-m-us": { provider: "vapi", voiceId: "Kai", version: 2 }, // male, American
  "jay-easygoing-m-us": { provider: "vapi", voiceId: "Nico", version: 2 }, // male, American
  "oliver-polished-m-uk": { provider: "vapi", voiceId: "Dan" }, // male, British (no V2 for Dan)
});

export const DEFAULT_VOICE: VapiVoiceConfig = VOICE_MAP[DEFAULT_ASSISTANT_VOICE_ID];

/**
 * Maps a stored assistant_voice id to a Vapi voice config. Unknown, empty or
 * non-string input (including values inherited from Object.prototype such as
 * "constructor") falls back to the default voice. Always returns a fresh object.
 */
export function resolveVapiVoice(assistantVoiceId: unknown): VapiVoiceConfig {
  const hit =
    typeof assistantVoiceId === "string" && Object.prototype.hasOwnProperty.call(VOICE_MAP, assistantVoiceId)
      ? VOICE_MAP[assistantVoiceId]
      : DEFAULT_VOICE;
  return { ...hit };
}

/**
 * Fragment to spread into `assistantOverrides` (POST /call, squad members, and
 * the assistant-request response): `{ ...voiceOverride(row.assistant_voice) }`.
 */
export function voiceOverride(assistantVoiceId: unknown): { voice: VapiVoiceConfig } {
  return { voice: resolveVapiVoice(assistantVoiceId) };
}
